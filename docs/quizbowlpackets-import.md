# quizbowlpackets.com (Pop Culture / Trash) importer

Direct importer for `popculture.quizbowlpackets.com` — a separate Trash/Pop-Culture
archive from the main academic quizbowlpackets.com site, with its own `subjects`
tagging that includes "Sports" as a first-class tag. Built because live verification
showed qbreader.org's coverage of this archive is incomplete (qbreader's own ingestion
tool is a manual, per-set pipeline with no automated sync), and because the Sports
pool pulled from qbreader's API had plateaued (see the "Real content first" section
in the main [README](../README.md)).

Output feeds `data/quizbowlpackets-sports.json`, loaded by `server.js` alongside the
other three question banks. Schema, bracket grammar, and bold-markup conventions are
identical to [`docs/ai-question-generation.md`](ai-question-generation.md) — this doc
only covers what's specific to this pipeline.

## Licensing

Same restriction as `data/questions.json`: released by the original authors for
study/practice use. **Do not use commercially or for paid tournaments without the
authors' consent.**

## Site facts (verified live, not assumed)

- Canonical domain is `popculture.quizbowlpackets.com` (`trash.quizbowlpackets.com`
  301s here; bare `quizbowlpackets.com` is a different, academic-only archive).
- **Every request needs a real browser `User-Agent`** — the default Node fetcher gets
  HTTP 403'd. Centralized as `USER_AGENT` in `qbp-discover.mjs`, reused everywhere.
- The set listing has no clean JSON API — it's embedded as an escaped React Server
  Components ("RSC flight") payload inside the initial page HTML. `qbp-discover.mjs`
  extracts `{set_id, set_name, subjects, level}` records via regex, scoping each
  record's field search strictly to `[thisPos, nextPos)` between consecutive
  `set_id` occurrences (a fixed-size window bleeds fields from the neighboring
  record — confirmed live on a real mis-tagged set before this fix).
- **Pagination**: tested `?page=2` against the live site — byte-identical to page 1
  (same 510 set ids). No working pagination mechanism was found. This importer treats
  the single listing load as the full corpus (v1 scope, ~510 sets total, of which the
  Sports-tagged subset is what gets fetched).
- The `level` field on every set record is uniformly `5` across the entire site — a
  dead signal. Level is instead derived from `scripts/tag-levels.mjs`'s
  `heuristic()`, a set-name keyword classifier, reused as-is.
- Set detail pages (`https://popculture.quizbowlpackets.com/<set_id>`) link packet
  files via plain `<a href="https://files.quizbowlpackets.com/<set_id>/<filename>">`
  tags — no RSC-unwrapping needed there.
- One set (`2023 Baseball`, id 3027) links a `.zip` bundle instead of individual
  files — not handled in v1 (would need an unzip dependency). Logged visibly
  ("SKIPPED unsupported: ...") rather than silently yielding zero files.

## Pipeline

```bash
node scripts/qbp-discover.mjs                  # crawl listing, filter to Sports-tagged sets -> data/quizbowlpackets-cache/sets.json
node scripts/qbp-fetch.mjs [--limit=N] [--only=id,id]   # download packet files -> data/quizbowlpackets-cache/raw/<set_id>/
node scripts/qbp-parse.mjs [--force]            # PDF/DOCX -> raw tossups -> data/quizbowlpackets-cache/parsed/<set_id>.json
node scripts/qbp-convert.mjs                    # raw tossups -> app schema -> data/staging/quizbowlpackets-<date>.json
node scripts/validate-generated.mjs data/staging/quizbowlpackets-<date>.json
# hand-spot-check a sample against source files, then:
node scripts/merge-generated.mjs data/staging/quizbowlpackets-<date>.json --dest=data/quizbowlpackets-sports.json --commit
```

`validate-generated.mjs` and `merge-generated.mjs` are the exact same scripts used by
the AI-generation pipeline (see `docs/ai-question-generation.md`) — same staging →
validate → human-review → merge gate, just pointed at a different destination file
via `merge-generated.mjs --dest=`.

All four `qbp-*` scripts are resumable: `qbp-discover`/`qbp-fetch` skip anything
already on disk; `qbp-parse` skips already-parsed sets unless run with `--force`.

## Parsing: format diversity

Real packets on this archive vary far more than a single convention. `qbp-parse.mjs`
tries, per file, in order, keeping the first one that passes a quality check
(`spansAreClean` — see below):

1. **Bare numbered** — `"1. ... ANSWER: ..."` (the dominant convention).
2. **Native Word `<ol>/<li>` list** (DOCX only) — the number lives in list metadata,
   not as visible text; each `<li>` is treated as a tossup start, extending to the
   next `<li>` since the answer paragraph is often a sibling `<p>` after the list
   item rather than nested inside it.
3. **Labeled `"Tossup N:" / "Bonus N -"`** — some packets spell the label out
   instead of using bare numbers; only `Tossup`-labeled spans are kept.
4. **No numbering at all** — the whole "Let's Remember Some Guys" series is just
   consecutive `"question text ANSWER: answer text"` paragraphs back to back, split
   purely on `ANSWER:` marker occurrences.

A common convention pairs each tossup with a bonus that **reuses the tossup's own
number** right after it (`"1. <tossup> ANSWER: ... 1. <bonus, 3 parts, own ANSWER:
markers> ..."`). Every recognized marker — including ones later rejected as
non-sequential — acts as a hard span boundary, so a bonus's content never gets
silently absorbed into the preceding tossup's answer text. Bonus spans themselves are
identified and dropped via `looksLikeBonus()` (2+ `[10...]`-style part markers before
the first answer marker).

**Quality gate (`spansAreClean`)**: after a strategy produces spans, each span's
content *after* its first `ANSWER:` marker is checked for a second `ANSWER:`
occurrence. If found, that segmentation under- or mis-matched real boundaries (e.g. a
file with only one stray numbered marker and no others, or a marker regex false
positive) and the whole file falls through to the next strategy tier — down to the
answer-marker tier, which is clean by construction and always terminates the chain.
This caught several real bugs during development: files where the "numbered" tier
found too few markers and silently swallowed several real tossups' worth of content
into one oversized span.

One sharp edge worth documenting: `ANSWER:` detection must require a **word
boundary** after "ANSWER" (`\bANSWER\b`, not `\bANSWER`) — clue text containing
"non-**answers**" or similar inflections will otherwise false-positive-match as a
marker, since `answer` is a substring of `answers`.

DOCX parsing runs all boundary regexes against a plain-text projection of the tagged
HTML (`toPlainWithMap`, position-mapped back to the original for `answerDisplay`
extraction) — mammoth emits zero literal whitespace between block elements
(`"</p><p>"` with nothing between), which breaks naive anchored regexes and merges
adjacent words with no space once tags are stripped for display/judging comparison,
so block-tag boundaries are explicitly converted to `\n` (plain text) or a literal
space (tagged `answerDisplay`) rather than deleted outright. A slice that starts
mid-way through an already-open `<b>`/`<u>` span (e.g. the whole `"ANSWER: X"`
including the literal word "ANSWER" is bolded, and extraction starts after
"ANSWER:") gets that opening tag re-added so the closing tag captured later isn't
left dangling. Packets that mark the required answer span with underline only, no
bold at all, get their `<u>` promoted to `<b><u>...</u></b>` — the app's judging
logic (`lib/answer-check.js`) only reads `<b>` depth, so an underline-only convention
would otherwise degrade every prompt in that file to "whole phrase required."

The inverse edge case is just as real: some authors bold their *entire* answer line
(literally including the word "ANSWER:" itself) as pure visual flourish, with
underline marking the actual required span underneath — confirmed on a real file
where `<strong>Answer: Randall <u>Cobb</u></strong>` would otherwise have made a
guess of "Cobb" alone only prompt (bold, taken at face value, requires the full
"Randall Cobb"). Detected by checking whether `<b>` is already open at the position
of the `ANSWER:` marker itself (`ANSWER:` can never legitimately be part of a
required answer span, so bold covering it proves the bolding is line-wide styling,
not a required-span signal); when true, `<b>` is stripped entirely and `<u>` (if
present) is promoted per the rule above instead.

PDF parsing has no formatting info at all — `answerDisplay` equals `answer` verbatim,
falling back to `lib/answer-check.js`'s lenient surname-matching judging path (same
fallback most of the qbreader-sourced `data/questions.json` content already uses).

## Per-question Sports gate

`subjects` is **set-level** metadata — a mixed trash packet tagged
`"Music, Movies, Sports, Miscellaneous"` contains questions on all those topics, not
just sports. `qbp-convert.mjs` re-gates every question individually via
`scripts/tag-sports.mjs`'s `tag()`, requiring a real sport-keyword hit
(`sport !== "other"`); anything failing that is excluded and logged to
`data/quizbowlpackets-cache/excluded/<set_id>.json` for review rather than silently
dropped. One entire discovered set ("Maybe MacVan, or maybe it's Maybelline") turned
out to be a general trash packet with no real sports content despite its Sports tag —
correctly excluded wholesale (0 kept / 20 excluded) by this gate.

## Known limitations

- Single-page listing load (no confirmed pagination) — v1 scope is whatever the
  first page's ~510 sets contain, not necessarily the archive's full history.
- `.zip`-bundled packets are skipped (logged, not silently dropped).
- PDF-sourced questions have no bold-derived `answerDisplay` (lenient fallback
  judging only).
- Power marks (`(*)`) only survive if the original author typed a literal `(*)`
  token; otherwise a question ends up with zero power marks (a warning, not a
  failure, in `validate-question.mjs`).
- Two files in the initial pilot corpus (`Guys IV - Lamberti.docx`,
  `Guys VI - Chowdhury.pdf`) had no recognizable structure under any of the four
  tiers and were skipped entirely, with a reason logged.
