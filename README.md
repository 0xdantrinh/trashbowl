# TrashBowl

Protobowl-style real-time quizbowl for **Sports** (with a broader Trash bank on deck). Rooms, word-by-word reading, buzzing with interrupts, powers (+15), negs (−5), real quizbowl prompting, chat, and per-sport + difficulty filters.

See [`CHANGELOG.md`](CHANGELOG.md) for what's changed and why, with commit hashes. This README is meant to be enough on its own to re-orient in this codebase from zero prior context.

## Run it

```bash
cd trashbowl
npm install
npm start
# open http://localhost:3000
```

Share a room by sharing the URL (e.g. `http://localhost:3000/friday-practice`).

## Gameplay

The interface and mechanics mirror protobowl.com: rooms live at `/roomname` URLs, questions read word-by-word with a tenths countdown timer, and past questions collapse into a searchable, paginated history feed with bookmarks (star icons). Space buzzes and swaps the toolbar for a Guess input with an 8-second red countdown; n (or j) starts the next question, s skips, p pauses/resumes, and c, /, or Enter opens chat (with live keystroke broadcast, like Protobowl's "show chat messages while typing"). Correct in power = 15, after = 10, wrong interrupt = −5, with inline buzz markers in the text (blue = buzz, red = wrong, orange = pause, blue badge = prompt). Sidebar stats track score, correct/interrupt streaks, and questions seen. Room settings cover reading speed, a difficulty filter (Any / College / High School / Middle School — derived from qbreader ratings plus per-set inference), a sport filter (football, basketball, baseball, soccer, hockey, tennis, golf, olympics, combat, racing), and toggles for re-buzzing, skipping, and pausing. Room settings are cached locally and re-applied on reconnect. Local settings include dark theme, distraction-free mode, and a correct-buzz sound.

**Prompting**: a guess that's part of the required answer but not specific enough (e.g. "Kobe" for "Kobe Bryant", "carolina" for "South Carolina") earns a **prompt** instead of scoring or failing — the buzzer stays with that player, the guess bar reopens with their partial answer preserved so they can extend it, and everyone's countdown resets to a fresh window. A player gets at most two prompts per buzz before a third still-vague answer is ruled wrong (matching how a live moderator behaves).

## Architecture

### Server (`server.js`)

Node + Express + `ws`. One in-memory game loop per room, no database. Room state machine: `idle → reading → buzzed → done → (next question) → reading`.

- **Clock-based reading**: the server does *not* stream one WebSocket message per word (that was the original design and caused visible stuttering under network jitter on a hosted/free-tier instance). Instead, `question_start` ships the full word list once, and a `reading` message carries `{from, elapsed, speed}` — each client reveals words on its own local `setInterval` clock. The server tracks the authoritative position via `readBase`/`readStartAt` and computes it on demand (`currentWordIndex()`) whenever it actually matters — a buzz, a pause, a mid-question rejoin, a speed change. Pausing folds the live position into `wordIndex` and stops the clock; resuming restarts it from there with a fresh `reading` broadcast.
- **Multi-socket player model**: a `player` object holds a `Set` of live WebSocket connections (`player.sockets`), not a single `ws` reference. This matters because the *same* player can have multiple tabs open (or a flaky reconnect can briefly overlap two sockets) — every socket gets every broadcast, so a stray extra tab never silently "steals" a player's messages and leaves the other tab's buttons looking dead. The player only goes offline (and only then announces "left the room") once its *last* socket closes.
- **Sync-based self-healing**: the periodic `sync` broadcast carries enough state (`state`, `buzzerId`, `buzzRemainMs`, `paused`) that a client which missed a message (dropped packet, brief disconnect) reconciles its local phase against the server's authoritative one on the next sync, instead of getting permanently stuck.
- **Heartbeat**: the server pings every WebSocket every 30s and terminates non-responsive peers; the client sends its own app-level keepalive ping every 25s. Hosting proxies (Render's included) silently drop WebSocket connections they consider idle between questions — this keeps the connection alive without relying on gameplay traffic.
- **Room history**: a bounded (600-item) per-room log of chat/system/buzz/finished-question events, replayed to a client on join via a `history` message. Without this, refreshing the page wiped the visible feed even though the room's actual game state (score, current question) already survived via `ROOM_EMPTY_GRACE_MS`.
- **Empty-room persistence**: a room with zero connected players is kept alive for 3 hours (`ROOM_EMPTY_GRACE_MS`) — an in-progress question auto-pauses (distinct from a user-triggered pause) and auto-resumes as soon as someone rejoins, so switching lobbies and coming back doesn't wipe scores or restart the clock.
- **Unique usernames**: enforced server-side per room, case-insensitive (`uniqueName()`) — a collision gets suffixed ("John Madden" → "John Madden 2"). The server is authoritative; the client adopts whatever name comes back in the `joined`/`renamed` messages. A reconnect on the same `clientKey` (localStorage-persisted) keeps its own name rather than colliding with itself.

### Answer judging (`lib/answer-check.js`)

This is the part most worth understanding before touching it — it's had several rounds of real bugs fixed (see `CHANGELOG.md`).

**The core convention**: real quizbowl packets mark the *minimum required* part of an answer with `<b><u>...</u></b>` in a separate `answerDisplay` field (verified against protobowl's own `shared/checker2.coffee` algorithm, which uses the same bold-vs-non-bold signal). Anything **outside** that bold markup isn't wrong, but isn't specific enough either — it should **prompt**, not score or fail. `parseAnswerLine(answerLine, answerDisplay)` walks the bold/non-bold word runs in `answerDisplay` and buckets them into `accept` (bold, sufficient alone) vs. `prompt` (non-bold, needs more) candidates. Two adjacent bold words only merge into one *required-together* run if the gap between them is *also* bold (`<b><u>Green Bay</u></b> <b><u>Packers</u></b>` → two independently-sufficient answers; `<b><u>Kentucky Derby</u></b>` → one phrase said together).

Explicit prose in the plain `answer` field can override that default in either direction, using a specific bracket grammar parsed literally (not free-form):

| Form | Effect |
|---|---|
| `[or X]` / `[accept X]` / `[also accept X]` | X is a fully acceptable alternate answer |
| `[prompt on X]` | X alone should prompt, even if bolded elsewhere (e.g. "Manning" prompts despite being bolded, because Eli Manning exists) |
| `[do not accept X]` / `[do not accept or prompt on X]` | X is explicitly wrong, even if it overlaps the real answer |

**Judging (`judgeGuess(guess, answerLine, answerDisplay)` → `"correct" | "prompt" | "incorrect"`)**: matching is **word-coverage based**, not substring containment — a guess only counts as correct if it covers *every word* of some accepted phrase (this fixed a real bug where "carolina" scored against "South Carolina" just because it was a substring). Covering *part* of a required phrase earns a prompt. A guess naming a *different specific thing* (e.g. "University of Connecticut" against "Gonzaga University Bulldogs" — shares the generic word "University" but adds a significant word found nowhere in the answer) is ruled incorrect, never a prompt — this required an explicit "foreign word" check, since naive coverage matching alone can't distinguish "a real but incomplete answer" from "a plausible-sounding wrong one." `reject` clauses match on the exact phrase only (not substring/fuzzy), so a rejected "polo" doesn't also block the correct answer "water polo". When `answerDisplay` has no bold markup at all (some data sources don't provide it), judging falls back to a lenient "surname alone is enough" convention instead of requiring the full phrase.

### Client (`public/index.html`)

Single file, no framework/build step. All UI state lives in one `S` object; `handle(msg)` is the WebSocket message dispatcher. Reveals words from the local reveal-clock (`revealTick()`, driven by the `reading`/`reading_done`/`buzz`/`paused` messages from the server) rather than per-word server pushes. On a `sync` message it reconciles `S.phase` against the server's `state`/`buzzerId` so a missed message can't leave the UI permanently stuck (e.g. showing an unresponsive Buzz button).

## Question database

- `data/questions.json` — ~2,900 real Trash tossups (1,781 Sports + Music/Movies/TV/etc. held in reserve) pulled from the [qbreader.org](https://www.qbreader.org) API, with difficulty ratings where available. The server currently loads **Sports only**. Questions originate from packets released for free study/practice use; set and packet attribution is preserved and shown after each question. **Do not use them commercially or for paid tournaments without the authors' consent.**
- `data/original-sports.json` — 24 original sports tossups written for this project, pyramidal with power marks. Add more here (same JSON shape) and they load automatically.
- `data/ai-sports.json` — AI-assisted original sports tossups, generated via a documented human/Claude-in-the-loop procedure (see [`docs/ai-question-generation.md`](docs/ai-question-generation.md)), each validated by `scripts/validate-generated.mjs` before merge. **Unlike `data/questions.json`'s qbreader-sourced content, this file is original composition and carries no non-commercial-use restriction.** Currently 16 questions (combat/racing/golf/tennis) from the first generation batch — more to come.
- Each Sports question carries `sport` (auto-tagged) and `level` (Middle School / High School / College) fields used by the room filters.
- All three files are loaded and merged by `loadQuestions()` in `server.js`, filtered to `subcategory === "Sports"`. A question object's exact required shape (fields, power-mark convention, bracket grammar, bold markup) is documented in `docs/ai-question-generation.md` — that doc is the ground truth for "what does a valid question object look like," not just for AI generation.

### Growing the bank

1. **Real content first**: `node scripts/fetch-questions.mjs` pulls more from qbreader.org (resumable, dedupes by id). It's a random-sample API, so it self-limits via a "stale" counter (stop after N consecutive batches with nothing new); override with `STALE_CAP=30 node scripts/fetch-questions.mjs` for a deeper, slower pull once in a while. Last run took Sports from 825 → 1,781 before plateauing (that pool is likely exhausted for now — a direct [quizbowlpackets.com](https://quizbowlpackets.com) importer, which qbreader's own ingestion already partially draws from, is the next lever if this stops yielding).
2. **AI-assisted original content**: see [`docs/ai-question-generation.md`](docs/ai-question-generation.md) for the full repeatable procedure (Wikipedia research → pyramidal drafting → bracket/bold markup → validate → human review → merge). No API key is required for this path — content is drafted by prompting Claude directly in a session; the staging/validate/merge pipeline is provider-agnostic so a scripted API-based generator could slot in later without a redesign.

Scripts:

```bash
node scripts/fetch-questions.mjs   # pull more questions (resumable, dedupes, keeps difficulty; STALE_CAP=30 for a deeper pull)
node scripts/tag-sports.mjs        # auto-tag Sports questions by sport
node scripts/tag-levels.mjs        # tag questions with MS/HS/College level
node scripts/validate-generated.mjs data/staging/<file>.json          # validate an AI-generated staging batch
node scripts/merge-generated.mjs data/staging/<file>.json --commit    # merge an approved batch into data/ai-sports.json
```

## Testing

```bash
node scripts/test-e2e.mjs                  # multiplayer gameplay over real WebSockets: buzz/neg/lockout/pause/re-buzz/typing/reset, plus inline answer-judging unit assertions
node scripts/test-scoring.mjs              # power 15 / regular 10 scoring
node scripts/test-room-persistence.mjs     # room state survives switching lobbies and coming back
node scripts/test-validate-generated.mjs   # fixture tests for the AI-question validator itself
python3 scripts/screenshot.py              # UI screenshots of each game state (requires playwright)
```

There's no CI configured — run these manually before merging changes to `server.js`, `lib/answer-check.js`, or `public/index.html`. `scripts/test-e2e.mjs` in particular spawns a real server on a scratch port and drives it with real `ws` clients, so it catches protocol-shape regressions that unit tests alone would miss.

## Architecture notes / known limitations

- **No database** — everything is in-memory per Node process. A server restart or redeploy loses all room state (scores, chat history) and forces a full question-bank reload from disk (fast — the JSON files, not a big deal).
- **Single-node only** — comfortably handles hundreds of concurrent players on one machine; scaling beyond that would need room state moved to Redis pub/sub or similar.
- **Render free tier**: the app is currently deployed there. Free tier sleeps after ~15 min idle (first visitor after that eats a ~50s cold start, and all in-memory state is lost) — an external uptime pinger or the paid tier removes this. This is a hosting-tier issue, not something fixable in code.
- **Full question text lives in client memory** once a question starts (a requirement of clock-based reading, not per-word streaming) — someone determined could read ahead via devtools. Acceptable for casual play; the same tradeoff protobowl itself makes.

## Deploying

Any Node host with WebSocket support works (Railway, Render, Fly.io, a $5 VPS). `PORT` env var is respected. `render.yaml` has a ready blueprint. Currently deployed at Render on the free tier — see limitations above.

## Ideas next

Bonuses (30-point 3-parters), account-free stat tracking via localStorage keys (already used for reconnects), a question-submission page so the community writes sports packets, audio "buzz" effects, and growing `data/ai-sports.json` well past its current 16 questions.
