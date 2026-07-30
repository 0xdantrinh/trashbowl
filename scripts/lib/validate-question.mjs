// Validation rules for AI-generated/staged question objects, shared by
// scripts/validate-generated.mjs (report) and scripts/merge-generated.mjs
// (writer) so the rules live in exactly one place.
import { judgeGuess } from "../../lib/answer-check.js";
import { RULES as SPORT_RULES, tag as tagSport } from "../tag-sports.mjs";

const VALID_SPORTS = new Set(SPORT_RULES.map(([name]) => name).concat("other"));
const VALID_LEVELS = new Set(["College", "High School", "Middle School"]);
const STOPWORDS = new Set([
  "the", "a", "an", "of", "this", "for", "points", "point", "name", "what",
  "who", "which", "and", "or", "in", "on", "at", "to", "with", "as", "by",
]);

function stripTags(html) {
  return (html || "").replace(/<[^>]+>/g, "");
}

function normalizeQuotes(s) {
  return (s || "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// mirrors parseAnswerLine's own "main phrase" extraction (lib/answer-check.js)
// so the self-check targets the same text the judge would treat as primary,
// including skipping a leading "(Optional word) Real Answer" parenthetical
function mainAnswerText(answer) {
  const line = answer || "";
  const leading = line.match(/^(?:\[([^\]]*)\]|\(([^)]*)\))\s*/);
  const start = leading ? leading[0].length : 0;
  const rest = line.slice(start);
  const bracketIdx = rest.search(/[\[(]/);
  return (bracketIdx === -1 ? rest : rest.slice(0, bracketIdx)).trim();
}

// significant, de-boilerplated words for near-duplicate comparison
function significantWords(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

function jaccard(aWords, bWords) {
  const a = new Set(aWords), b = new Set(bWords);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

// Build a lookup of existing Sports-subcategory rows for id-collision and
// near-duplicate checks. `banks` is an array of question arrays (one per
// source file) — pass every file that could collide, not just Sports rows,
// since ids must be globally unique across the whole loaded set.
export function buildExistingIndex(banks) {
  const allIds = new Set();
  const byAnswer = new Map(); // normalized main answer -> [{question, id}]
  for (const bank of banks) {
    for (const q of bank) {
      if (q.id) allIds.add(q.id);
      if (q.subcategory !== "Sports") continue;
      const key = mainAnswerText(q.answer).toLowerCase();
      if (!key) continue;
      if (!byAnswer.has(key)) byAnswer.set(key, []);
      byAnswer.get(key).push({ question: q.question, id: q.id });
    }
  }
  return { allIds, byAnswer };
}

const REQUIRED_FIELDS = ["id", "question", "answer", "answerDisplay", "category", "subcategory", "set", "packet", "source"];

// Validate one question object against schema/judging/dedup rules.
// `index` is the result of buildExistingIndex() over every other file that
// could collide (existing bank + ids already accepted earlier in this batch).
export function validateQuestion(q, index) {
  const failures = [];
  const warnings = [];

  for (const field of REQUIRED_FIELDS) {
    if (typeof q[field] !== "string" || !q[field].trim()) failures.push(`missing/empty field "${field}"`);
  }
  if (q.category !== "Trash") failures.push(`category must be "Trash", got ${JSON.stringify(q.category)}`);
  if (q.subcategory !== "Sports") failures.push(`subcategory must be "Sports", got ${JSON.stringify(q.subcategory)}`);
  if (!q.sport || !VALID_SPORTS.has(q.sport)) failures.push(`sport must be one of ${[...VALID_SPORTS].join(", ")}, got ${JSON.stringify(q.sport)}`);
  if (!q.level || !VALID_LEVELS.has(q.level)) failures.push(`level must be one of ${[...VALID_LEVELS].join(", ")}, got ${JSON.stringify(q.level)}`);

  // bail out of the checks below if the basics aren't even present —
  // they'd throw on undefined/non-string fields
  if (failures.length) return { id: q.id, pass: false, failures, warnings };

  const powerCount = (q.question.match(/\(\*\)/g) || []).length;
  if (powerCount > 1) failures.push(`question has ${powerCount} "(*)" power marks — must be 0 or 1 (loadQuestions() picks the first match, silently wrong with 2+)`);
  if (powerCount === 0) warnings.push("no (*) power mark — every question should have one for gameplay quality");
  else {
    const words = q.question.split(/\s+/).filter(Boolean);
    const idx = words.findIndex((w) => w.includes("(*)"));
    if (idx === 0) warnings.push("power mark is on the very first word — no runway before it");
    if (idx >= 0 && idx / words.length > 0.9) warnings.push("power mark is within the last 10% of the question — too close to the giveaway");
  }

  if (!/<b[\s>]/i.test(q.answerDisplay)) {
    failures.push('answerDisplay has no <b> span — prompting will degrade to "whole phrase required"');
  }

  const strippedDisplay = normalizeQuotes(stripTags(q.answerDisplay));
  const strippedAnswer = normalizeQuotes(q.answer);
  if (strippedDisplay !== strippedAnswer) {
    failures.push(`answerDisplay text (stripped of tags) doesn't match answer — got ${JSON.stringify(strippedDisplay)} vs ${JSON.stringify(strippedAnswer)}`);
  }

  const main = mainAnswerText(q.answer);
  if (!main) {
    failures.push("could not derive a main answer (text before the first bracket) from answer");
  } else if (judgeGuess(main, q.answer, q.answerDisplay) !== "correct") {
    failures.push(`self-check failed: judgeGuess(${JSON.stringify(main)}, answer, answerDisplay) !== "correct" — the bolding/bracket syntax don't actually score the intended answer`);
  }

  const words = q.question.split(/\s+/).filter(Boolean);
  if (words.length < 45) warnings.push(`question is thin (${words.length} words) for a pyramidal tossup`);
  if (!/for\s+(ten|10)\s+points/i.test(q.question)) warnings.push('question has no "for 10 points" giveaway marker');

  if (index) {
    if (index.allIds.has(q.id)) failures.push(`id ${JSON.stringify(q.id)} already exists in the bank`);

    const guessedSport = tagSport(q);
    if (guessedSport !== "other" && guessedSport !== q.sport) {
      warnings.push(`declared sport "${q.sport}" disagrees with keyword classifier's guess "${guessedSport}"`);
    }

    const key = main.toLowerCase();
    const existingForAnswer = index.byAnswer.get(key) || [];
    const myWords = significantWords(q.question);
    for (const ex of existingForAnswer) {
      const sim = jaccard(myWords, significantWords(ex.question));
      if (sim > 0.8) failures.push(`near-verbatim duplicate of existing question ${JSON.stringify(ex.id)} on the same answer (similarity ${sim.toFixed(2)})`);
      else if (sim > 0.5) warnings.push(`similar clue text to existing question ${JSON.stringify(ex.id)} on the same answer (similarity ${sim.toFixed(2)})`);
    }
  }

  if (q.source !== "ai-generated") warnings.push(`source is ${JSON.stringify(q.source)}, expected "ai-generated"`);

  return { id: q.id, pass: failures.length === 0, failures, warnings };
}
