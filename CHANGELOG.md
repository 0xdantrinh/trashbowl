# Changelog

All notable changes to TrashBowl, newest first. Hashes are short commit ids
in this repo (`git show <hash>` for the full diff).

## 2026-07-31

- **`7d301ea`** — New direct importer for popculture.quizbowlpackets.com's
  Trash/Sports archive (`scripts/qbp-{discover,fetch,parse,convert}.mjs`),
  a source with real, confirmed gaps in qbreader.org's own manual
  ingestion. Added 691 real, human-written Sports tossups (1,851 → 2,542),
  0 validation failures, spot-checked against source files across every
  parsing strategy the pipeline supports. Real packets on this archive use
  at least four distinct tossup-boundary conventions (bare "N." numbering,
  native Word `<ol>/<li>` lists, explicit "Tossup N:"/"Bonus N" labels, and
  no numbering at all — just consecutive `ANSWER:`-terminated paragraphs),
  plus tossup+bonus pairs that reuse the same number; the parser tries each
  strategy in order and falls through whenever a segmentation's own answer
  text turns out to contain a second `ANSWER:` marker (a hard signal a
  boundary was missed and content got silently swallowed — caught several
  real bugs this way during development, including one file where a single
  stray numbered marker absorbed the rest of the document into one span).
  DOCX answer-span reconstruction now also detects and corrects for the
  case where an author bolds an entire answer line (including the literal
  word "ANSWER:") as visual flourish rather than marking a required span —
  detected by checking whether `<b>` is already open at the marker's own
  position, in which case underline (if present) is treated as the real
  signal instead, promoted the same way an underline-only convention
  already is. Prerequisite fixes: `validate-question.mjs` no longer
  hard-fails PDF-sourced rows for lacking bold markup (downgraded to a
  warning); `merge-generated.mjs` gained `--dest` so this batch merges into
  its own `data/quizbowlpackets-sports.json` rather than `ai-sports.json`.

## 2026-07-30

- **`bac1f6f`** — Fixed "accept either underlined" scoring wrong when the
  bold markup merged what should be two independently-sufficient spans into
  one (`The Buffalo Bills (accept either underlined)` bolds "Buffalo Bills"
  as a single run, so "bills" alone only earned a prompt). Some of the
  underlying data is worse — the plain text itself lost the space between
  words entirely (`SeattleMariners`, `San Francisco49ers`) from stripping
  adjacent HTML tags with nothing between them. When this directive is
  present, required runs now also split on spaces and at camelCase/
  letter-digit boundaries, guarded (every piece must be ≥4 letters, except
  at an unambiguous digit boundary) so it can't tear apart real surnames
  (McGregor) or glued brand names (TaxSlayer). 231 answer lines in the bank
  carry this directive; verified against every real case that was actually
  broken by it.
- **`7eefb46`** — The answer clock now auto-submits whatever's currently
  typed when time runs out, instead of always judging an empty guess — a
  correct answer typed but never explicitly sent (no Enter) previously
  scored as wrong. Applies to both the initial buzz window and the
  follow-up window after a prompt.
- **`b870f64` / `b96d7ca`** — Fixed a real judging bug found live: some
  qbreader answer lines write a directive with no enclosing brackets at all
  (`Peyton Manning; prompt on "Manning"` instead of the usual
  `Peyton Manning [prompt on "Manning"]`). The parser only ever looked for
  directives inside `[...]`/`(...)`, so the whole string was treated as one
  literal main answer and "Manning" scored an instant correct instead of
  prompting — affected 18 real questions in the bank. Bare, top-level
  semicolon-separated directive clauses are now wrapped in synthetic
  brackets before parsing.

## 2026-07-29

- **`e5a851b`** — Merged a second AI-generated batch: 30 more questions
  (6 each across combat, racing, golf, tennis, and 6 new hockey tossups —
  hockey's first appearance in `data/ai-sports.json`), covering athletes not
  yet in the bank (Holyfield, Canelo, Khabib, Verstappen, Lauda, Ballesteros,
  Gretzky, Orr, McDavid, and more). `data/ai-sports.json` now has 46
  questions total, sports pool at 1,851. Live judging spot-checked before
  merge (surname scoring, mononym prompting, wrong-answer rejection).
- **`713d72e`** — Added this changelog and rewrote the README with enough
  architectural depth (bold-markup judging convention, clock-based reading
  model, multi-socket player model) to re-orient from zero prior context.
- **`398171c`** — Built the AI-generated question pipeline: `scripts/lib/validate-question.mjs`
  (shared rule engine — schema completeness, power-mark count, `answerDisplay`
  bold-span presence, `answerDisplay`/`answer` text consistency, a self-check
  against the real judging logic, id-collision and near-duplicate detection),
  `scripts/validate-generated.mjs` / `scripts/merge-generated.mjs` (staging →
  validate → merge CLIs), `scripts/test-validate-generated.mjs`, and
  `docs/ai-question-generation.md` (the full repeatable procedure). Wired
  `data/ai-sports.json` into `server.js`'s question loader. Also maximized
  the existing qbreader import (`scripts/fetch-questions.mjs`, new
  `STALE_CAP` env var) — Sports pool went from 825 → 1,781 questions — and
  merged a first validated batch of 16 AI-generated tossups (combat, racing,
  golf, tennis) into `data/ai-sports.json`.
- **`048621c`** — Fixed a judging gap: a guess naming a *different specific
  thing* (e.g. "University of Connecticut" against "Gonzaga University
  Bulldogs") was earning a prompt instead of being ruled wrong, because it
  shared a generic word ("University") with the answer. `judgeGuess()` now
  rejects any guess containing a significant word absent from the answer's
  own vocabulary before it can reach a prompt outcome. Also fixed the client
  losing a player's partial answer text when a prompt reopened the guess bar
  (it now reopens with the previous guess kept, cursor at the end, instead of
  clearing it).
- **`3ad427c`** — Fixed the core prompting UX bug: pressing Enter hid the
  guess bar as soon as an answer was sent, so a "prompt" verdict left the
  player with nowhere to type before the clock ran out. The guess bar now
  reopens on a prompt, and every player's countdown resets to a fresh
  8-second window. Added a two-prompt cap per buzz (matching how a live
  moderator behaves) — a third still-too-vague answer is ruled wrong instead
  of stalling the room.
- **`7c62e94`** — Made usernames unique per room (case-insensitive):
  duplicate joins/renames get suffixed ("John Madden" → "John Madden 2").
  The server is authoritative; the client adopts whatever name it's given
  back, including on a same-clientKey reconnect (which keeps its own name,
  no self-collision).
- **`b13915f`** — Rewrote the core answer-matching algorithm from substring
  containment to word-coverage matching, fixing a real judging bug: "carolina"
  was scoring as correct against the bolded-required "South Carolina" because
  it was merely a substring. A guess now only counts as correct if it covers
  *every word* of an accepted phrase; partial coverage earns a prompt. Also
  tightened explicit `reject` clauses to exact-phrase matching only (a
  substring/fuzzy reject was blocking legitimate answers, e.g. "water polo"
  when bare "polo" was rejected) and fixed bracket-parsing when a `[...]`
  directive contains a nested `(...)`.
- **`aef806f`** — Fixed dead buttons/clicks caused by two tabs (or a flaky
  reconnect) sharing one player: the server now tracks a *set* of live
  sockets per player instead of one, so every tab gets every broadcast.
  Added `sync`-based state reconciliation on the client so a missed message
  can never leave the UI stuck in a phase the server has already moved past.
  A system-paused room (emptied out, auto-paused) now auto-resumes as soon
  as someone rejoins, instead of ambushing them with a dead Buzz button.
  Also stopped a second tab/quick reconnect from spamming duplicate "joined
  the room" announcements.
- **`017f104`** — Replaced per-word WebSocket streaming (one message every
  ~135ms during reading) with clock-based reading: the server sends the full
  word list once plus a small `{from, elapsed, speed}` sync message, and each
  client reveals words on its own local clock. This was the main cause of
  laggy/stuttering reading on the deployed (Render free-tier) instance —
  network jitter can no longer desync word reveal. Added a WebSocket
  heartbeat (ping every 30s, terminate non-responsive peers) plus a
  client-side keepalive ping, since hosting proxies were silently dropping
  "idle" connections between questions.
- **`99b7c9d`** — The big one: implemented real quizbowl prompting. Rewrote
  `lib/answer-check.js` to parse the packet's bolded/underlined `answerDisplay`
  markup as the authoritative "minimum required to score" signal (verified
  against protobowl's own `checker2.coffee` algorithm) — a guess covering
  only the non-bold part of a required phrase (e.g. "Kobe" for "Kobe
  Bryant") now correctly prompts instead of silently scoring, while explicit
  `prompt on X`/`do not accept X` directives in the answer line can still
  override the bold default in either direction. Wired the new
  correct/prompt/incorrect three-way judgment into `server.js`'s buzz flow
  (a prompt keeps the buzzer live for a follow-up answer, no
  points/penalty). Also added server-side chat/buzz/question history
  (replayed to clients on join/reconnect, so a page refresh no longer wipes
  the feed) and fixed the leaderboard showing permanent greyed "ghost" rows
  for long-disconnected players.
- **`8e2d3ef`** — Fixed room state (score, current question, settings) being
  wiped when the last player disconnected and later rejoined (e.g. by
  switching lobbies and coming back): empty rooms now stay alive for 3
  hours, an in-progress question silently auto-pauses while nobody's
  connected, and rejoining resumes exactly where it left off with a synced
  timer.
- **`b152507`** — Added a Render deploy blueprint.
- **`2b3b9ea`** — Initial commit: TrashBowl, a Protobowl-style realtime
  sports quizbowl (Node/Express/`ws` server, single-file HTML client).
