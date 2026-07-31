// Unit tests for scripts/lib/validate-question.mjs, following the inline-
// assert pattern already used at the top of scripts/test-e2e.mjs.
import assert from "assert";
import { buildExistingIndex, validateQuestion } from "./lib/validate-question.mjs";

function base(overrides = {}) {
  return {
    id: "ai-sp-tennis-999",
    question:
      "This player lost a January 2022 court appeal and was deported before the year's first major, which he had won the previous three times. This man completed a career Golden Slam by winning gold in Paris in 2024. Rafael Nadal and Roger Federer each finished with fewer major titles than this man, who has won a record ten Australian Opens (*) and holds the men's record for weeks at world No. 1. For 10 points, name this Serbian tennis player.",
    answer: "Novak Djokovic",
    answerDisplay: "Novak <b><u>Djokovic</u></b>",
    category: "Trash",
    subcategory: "Sports",
    set: "TrashBowl AI-Generated",
    packet: "Batch 1",
    source: "ai-generated",
    sport: "tennis",
    level: "High School",
    ...overrides,
  };
}

const existingBank = [
  { id: "orig-sp-001", subcategory: "Sports", answer: "Novak Djokovic", question: "A totally different clue set about Djokovic entirely unrelated in wording from the fixture question used elsewhere in these unit tests for good measure and length padding." },
  { id: "orig-sp-999", subcategory: "Sports", answer: "Tom Brady [or Thomas Edward Patrick Brady Jr.]", question: "some other question" },
];

// clean pass
{
  const index = buildExistingIndex([existingBank]);
  const r = validateQuestion(base({ id: "ai-sp-tennis-001" }), index);
  assert.strictEqual(r.pass, true, "clean fixture should pass: " + JSON.stringify(r.failures));
}

// double power mark
{
  const r = validateQuestion(base({ question: base().question.replace("For 10 points", "(*) For 10 points") }), buildExistingIndex([existingBank]));
  assert.strictEqual(r.pass, false, "double power mark should fail");
  assert(r.failures.some((f) => /power mark/.test(f)), "failure should mention power mark: " + JSON.stringify(r.failures));
}

// no markup at all (e.g. PDF-sourced imports with nothing to extract) is a
// graceful, legitimate case — warns, doesn't fail
{
  const r = validateQuestion(base({ answerDisplay: "Novak Djokovic" }), buildExistingIndex([existingBank]));
  assert.strictEqual(r.pass, true, "answerDisplay with zero markup should pass (warning, not failure): " + JSON.stringify(r.failures));
  assert(r.warnings.some((w) => /bold markup/.test(w)), "should still warn about the missing markup: " + JSON.stringify(r.warnings));
}

// markup present but no <b> span (a broken bold attempt) should still fail
{
  const r = validateQuestion(base({ answerDisplay: "Novak <i>Djokovic</i>" }), buildExistingIndex([existingBank]));
  assert.strictEqual(r.pass, false, "markup without a <b> span should fail");
  assert(r.failures.some((f) => /<b>/.test(f)), "failure should mention <b>: " + JSON.stringify(r.failures));
}

// mismatched answerDisplay vs answer
{
  const r = validateQuestion(base({ answerDisplay: "Novak <b><u>Djokovich</u></b>" }), buildExistingIndex([existingBank]));
  assert.strictEqual(r.pass, false, "mismatched answerDisplay text should fail");
  assert(r.failures.some((f) => /answerDisplay text/.test(f)), "failure should mention text mismatch: " + JSON.stringify(r.failures));
}

// self-check failure: an authoring mistake blocks the main answer itself
// (e.g. a careless "do not accept" clause matching the primary answer text)
{
  const bad = base({
    answer: 'Novak Djokovic [do not accept "Novak Djokovic"]',
    answerDisplay: 'Novak <b><u>Djokovic</u></b> [do not accept "Novak Djokovic"]',
  });
  const r = validateQuestion(bad, buildExistingIndex([existingBank]));
  assert.strictEqual(r.pass, false, "a reject clause matching the main answer should fail self-check");
  assert(r.failures.some((f) => /self-check/.test(f)), "failure should mention self-check: " + JSON.stringify(r.failures));
}

// id collision against existing bank
{
  const r = validateQuestion(base({ id: "orig-sp-001" }), buildExistingIndex([existingBank]));
  assert.strictEqual(r.pass, false, "colliding id should fail");
  assert(r.failures.some((f) => /already exists/.test(f)), "failure should mention id collision: " + JSON.stringify(r.failures));
}

// near-duplicate: same answer, near-identical clue wording
{
  const nearDupeBank = [
    { id: "orig-sp-100", subcategory: "Sports", answer: "Novak Djokovic", question: base().question },
  ];
  const r = validateQuestion(base({ id: "ai-sp-tennis-002" }), buildExistingIndex([nearDupeBank]));
  assert.strictEqual(r.pass, false, "near-identical clue text on the same answer should fail");
  assert(r.failures.some((f) => /near-verbatim/.test(f)), "failure should mention near-verbatim duplicate: " + JSON.stringify(r.failures));
}

// same answer recurring with genuinely different clues is fine (not itself a failure)
{
  const r = validateQuestion(base({ id: "ai-sp-tennis-003" }), buildExistingIndex([existingBank]));
  assert.strictEqual(r.pass, true, "same answer with different clue wording should not fail: " + JSON.stringify(r.failures));
}

// missing required field
{
  const q = base();
  delete q.level;
  const r = validateQuestion(q, buildExistingIndex([existingBank]));
  assert.strictEqual(r.pass, false, "missing level should fail");
}

console.log("✓ validate-question unit tests passed");
