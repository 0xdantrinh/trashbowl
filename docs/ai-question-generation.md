# Writing a batch of AI-generated sports questions

This is the repeatable procedure for growing `data/ai-sports.json` with new,
original pyramidal sports tossups — written by prompting Claude (or another
model) directly in a session, grounded in Wikipedia facts, then validated
before merging. No API key or generation script is required for this path;
see "Later: a scripted generator" at the bottom for that extension point.

Every claim in a generated question must be traceable to a real source
(Wikipedia, in practice) — never invent a stat, date, or quote.

## 1. Pick 10-15 topics for the session

Bias toward whatever's thin in the current bank. Check current counts first:

```bash
node -e '
import("fs").then(({readFileSync}) => {
  const all = [...JSON.parse(readFileSync("data/questions.json")),
               ...JSON.parse(readFileSync("data/original-sports.json"))]
    .filter(q => q.subcategory === "Sports");
  const by = k => { const c = {}; for (const q of all) c[q[k]] = (c[q[k]]||0)+1; return c; };
  console.log("sport:", by("sport"));
  console.log("level:", by("level"));
});
'
```

As of the last check, `combat`, `golf`, `racing`, and `tennis` were the
thinnest sports — prefer those, and prefer subjects/eras not already covered
(check `grep -i "<player name>" data/*.json` before committing to a topic, to
avoid writing a near-duplicate of something already in the bank — the
validator also catches this, but it's cheaper to notice up front).

## 2. Research each topic on Wikipedia

For each topic, read its Wikipedia page (via WebFetch/WebSearch) and pull
4-6 distinct, verifiable facts spanning obscure → famous: a career stat, a
specific game/moment, a controversy, an award, a nickname, a record. These
become your clues — don't invent anything not on the page.

## 3. Draft the tossup

3-5 clues, ordered obscure → giveaway, ending in a canonical quizbowl
giveaway sentence. Study `data/original-sports.json`'s existing 24 rows for
tone/pacing — e.g.:

> "This athlete lost a January 2022 court appeal and was deported before the
> year's first major, which he had won the previous three times it was
> held. This man completed a 'double career Golden Slam' by winning gold in
> Paris in 2024, beating Carlos Alcaraz. [...] For 10 points, name this
> Serbian who holds the men's record of 24 Grand Slam singles titles."

Guidelines:
- Obscure-but-real details first, unmistakable identity last.
- Avoid stacking two clues that are trivially the same fact restated.
- End with "For 10 points, name this \_\_\_" (or a close variant) — the
  validator checks for this and warns if it's missing.
- Aim for 45+ words — thinner tossups get flagged as too short.

## 4. Place the power mark

Insert the literal three-character token `(*)` **exactly once**, attached to
a word roughly 55-70% through the clue sequence — never in the first clue,
never inside the giveaway sentence. This is what `loadQuestions()` in
`server.js` scans for (`q.words.findIndex(w => w.includes("(*)"))`) to know
where "power" ends; two or zero occurrences either breaks that lookup or
loses the power-bonus opportunity entirely.

Example (from the real data): `"...won a record ten Australian Opens. (*)
Rafael Nadal and Roger Federer each finished their careers with fewer major
titles..."`

## 5. Write the answer line

The `answer` field uses a specific bracket grammar that
`lib/answer-check.js`'s `parseAnswerLine()` parses **literally** — phrasing
outside these exact forms silently fails to parse and won't do what you
expect:

| Form | Effect |
|---|---|
| `[or X]` | X is a fully acceptable alternate answer |
| `[accept X]` | same as `or` |
| `[also accept X]` | same as `or` |
| `[prompt on X]` | X alone should prompt (needs more) rather than score or fail |
| `[do not accept X]` | X is explicitly wrong, even if it overlaps the real answer |
| `[do not accept or prompt on X]` | X is wrong and should never earn a prompt either |

Multiple alternatives in one clause: `[accept X or Y or Z]`. Multiple
clauses: separate with `;`.

Examples from the real data:
```
Pete Rose [or Peter Edward Rose Sr.]
Kentucky Derby [prompt on "the Derby"]
Serena Williams [prompt on Williams; do NOT accept or prompt on "Venus Williams"]
```

## 6. Hand-bold `answerDisplay`

Copy the `answer` field into `answerDisplay`, then wrap the **minimum
sufficient** substring in `<b><u>...</u></b>`. **This is not cosmetic** — the
judging logic in `lib/answer-check.js` reads this markup as the authoritative
correct-vs-prompt boundary at judge time. Under- or over-bolding directly
changes how the game judges buzzes (this exact mistake caused real bugs
earlier in this project — see git history for "prompt fixing" commits).

Rules of thumb, all drawn from existing rows:
- **Surname-only answer** (most people): bold just the surname.
  `Novak <b><u>Djokovic</u></b>` — "Djokovic" alone scores; "Novak" alone
  should prompt (handled automatically since it's the only non-bold word).
- **Full multi-word phrase required together**: wrap the whole thing in one
  `<b><u>...</u></b>` pair with no gap.
  `<b><u>Kentucky Derby</u></b>` — "Derby" alone should prompt (add an
  explicit `[prompt on "the Derby"]` clause too, since bold alone won't
  generate that without it).
- **Multiple independently-sufficient answers** (e.g. either the city or the
  team name alone is fine): bold each one in its **own separate**
  `<b><u>...</u></b>` pair, with a non-bold gap between them, even if they're
  adjacent words. `<b><u>Green Bay</u></b> <b><u>Packers</u></b>` — either
  "Green Bay" or "Packers" alone scores. (If they were wrapped together as
  one pair instead, only saying both together would score.)

If you're unsure, err toward **less** bolding — an under-bolded answer just
prompts a bit more than ideal; an over-bolded one can silently auto-credit an
answer that should have required more specificity from the player.

## 7. Append to the staging file

Add the finished question object to this session's batch file:
`data/staging/ai-generated-<YYYY-MM-DD>.json` (create it if this is the
first batch today; use `-2`, `-3` suffixes for additional same-day sessions).
Match the field shape exactly:

```json
{
  "id": "ai-sp-<sport>-<NNN>",
  "question": "...",
  "answer": "...",
  "answerDisplay": "...",
  "category": "Trash",
  "subcategory": "Sports",
  "set": "TrashBowl AI-Generated",
  "packet": "Batch <date>",
  "source": "ai-generated",
  "sport": "football | basketball | baseball | soccer | hockey | tennis | golf | olympics | combat | racing | other",
  "level": "College | High School | Middle School"
}
```

`id` must not collide with anything already in `data/questions.json`,
`data/original-sports.json`, or `data/ai-sports.json` — use the
`ai-sp-<sport>-<NNN>` prefix and keep a running counter per sport. Write the
file with the same single-space-indent JSON formatting the other data files
use (`JSON.stringify(all, null, 1)`), so diffs stay clean.

## 8. Validate

```bash
node scripts/validate-generated.mjs data/staging/ai-generated-<date>.json
```

Fix every `FAIL`, re-run until clean. `WARN`s don't block a merge but should
be read — they often catch a real mistake (wrong `sport` tag, a near-dupe of
an existing question, no power mark).

## 9. Hand off for review

Don't merge your own batch straight through — hand the staging file (and the
validator's output) to a human for a spot-check before running the merge
step below. Once approved:

```bash
node scripts/merge-generated.mjs data/staging/ai-generated-<date>.json          # dry run — shows what would happen
node scripts/merge-generated.mjs data/staging/ai-generated-<date>.json --commit # writes into data/ai-sports.json
```

The merge script re-validates against the *current* bank (not a cached
validate-time result) and skips anything already merged, so it's safe to
re-run. After a successful commit, delete the staging file (its contents are
preserved permanently in git history via the commit that added it).

Do **not** run `tag-sports.mjs` / `tag-levels.mjs` on this file — they only
scan `questions.json`/`original-sports.json`. Generated questions set `sport`
and `level` directly at authoring time (step 7).

## Later: a scripted generator

Everything above (staging format, validation rules, merge step) is
deliberately provider-agnostic — it doesn't care whether a question was
typed by a human, drafted by Claude in a chat, or produced by a script
calling an LLM API. If/when it's worth paying for a dedicated API key (a
cheap model is plenty for this — draft quality matters more than raw
intelligence, and the validator catches structural mistakes either way), a
generator script can write directly into the same
`data/staging/ai-generated-<date>.json` format and slot into step 8 onward
with no other changes.
