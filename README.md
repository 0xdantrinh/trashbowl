# TrashBowl

Protobowl-style real-time quizbowl for **Sports** (with a broader Trash bank on deck). Rooms, word-by-word reading, buzzing with interrupts, powers (+15), negs (−5), chat, and per-sport + difficulty filters.

## Run it

```bash
cd trashbowl
npm install
npm start
# open http://localhost:3000
```

Share a room by sharing the URL (e.g. `http://localhost:3000/?room=friday-practice`).

## Gameplay

The interface and mechanics mirror protobowl.com: rooms live at `/roomname` URLs, questions read word-by-word with a tenths countdown timer, and past questions collapse into a searchable, paginated history feed with bookmarks (star icons). Space buzzes and swaps the toolbar for a Guess input with an 8-second red countdown; n (or j) starts the next question, s skips, p pauses/resumes, and c, /, or Enter opens chat (with live keystroke broadcast, like Protobowl's "show chat messages while typing"). Correct in power = 15, after = 10, wrong interrupt = −5 with inline buzz markers in the text (blue = buzz, red = wrong, orange = pause). Sidebar stats track score, correct/interrupt streaks, and questions seen. Room settings cover reading speed, a difficulty filter (Any / College / High School / Middle School — derived from qbreader ratings plus per-set inference), a sport filter (football, basketball, baseball, soccer, hockey, tennis, golf, olympics, combat, racing), and toggles for re-buzzing, skipping, and pausing. Room settings are cached locally and re-applied on reconnect, so they survive server restarts. Local settings include dark theme, distraction-free mode, and a correct-buzz sound.

## Question database

- `data/questions.json` — ~1,400 real Trash tossups (825 Sports + Music/Movies/TV/etc. held in reserve) pulled from the [qbreader.org](https://www.qbreader.org) API, with difficulty ratings where available. The server currently loads **Sports only**. Questions originate from packets released for free study/practice use; set and packet attribution is preserved and shown after each question. **Do not use them commercially or for paid tournaments without the authors' consent.**
- `data/original-sports.json` — 24 original sports tossups written for this project, pyramidal with power marks. Add more here (same JSON shape) and they load automatically.
- Each Sports question carries `sport` (auto-tagged) and `level` (Middle School / High School / College) fields used by the room filters.

Scripts:

```bash
node scripts/fetch-questions.mjs   # pull more questions (resumable, dedupes, keeps difficulty)
node scripts/tag-sports.mjs        # auto-tag Sports questions by sport
node scripts/tag-levels.mjs        # tag questions with MS/HS/College level
node scripts/test-e2e.mjs          # multiplayer gameplay tests (buzz, neg, lockout, pause, re-buzz, typing, reset)
node scripts/test-scoring.mjs      # power 15 / regular 10 scoring tests
python3 scripts/screenshot.py      # UI screenshots of each game state (requires playwright)
```

## Architecture

- `server.js` — Node + Express + `ws`. One in-memory game loop per room: streams words on a timer, handles buzz/lockout/scoring, GCs empty rooms. No database needed.
- `lib/answer-check.js` — parses quizbowl answer lines (`[or ...]`, `[accept ...]`, ignores prompts/rejects), then matches guesses via normalization, surname matching, containment, and edit distance.
- `public/index.html` — single-file client, no framework, dark UI, keyboard-first.

## Deploying

Any Node host with WebSocket support works (Railway, Render, Fly.io, a $5 VPS). `PORT` env var is respected. For scale-out beyond one machine you'd move room state to Redis pub/sub, but a single node comfortably handles hundreds of concurrent players.

## Ideas next

Bonuses (30-point 3-parters), account-free stat tracking via localStorage keys (already used for reconnects), difficulty ratings, a question-submission page so the community writes sports packets, and audio "buzz" effects.
