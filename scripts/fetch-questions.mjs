// Fetches Trash/Sports tossups from the qbreader.org API into data/questions.json
// Usage: node scripts/fetch-questions.mjs
// Questions originate from packets released for free study/practice use;
// this site is free practice, per archive terms. Credit is kept via set/packet fields.

import { writeFileSync, readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "data", "questions.json");

// subcategory -> target count (sports-first: the site currently plays Sports only)
const TARGETS = {
  Sports: 800,
  Music: 120,
  Movies: 120,
  Television: 90,
  "Video Games": 90,
  "Other Pop Culture": 80,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchBatch(sub, n) {
  const url = `https://www.qbreader.org/api/random-tossup?categories=Trash&subcategories=${encodeURIComponent(sub)}&number=${n}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${sub}`);
  const d = await res.json();
  return d.tossups || [];
}

function clean(t) {
  return {
    id: t._id,
    question: t.question_sanitized || t.question?.replace(/<[^>]+>/g, ""),
    answer: t.answer_sanitized || t.answer?.replace(/<[^>]+>/g, ""),
    answerDisplay: t.answer,
    category: "Trash",
    subcategory: t.subcategory || "Other Pop Culture",
    set: t.set?.name || "",
    packet: t.packet?.name || "",
    difficulty: typeof t.difficulty === "number" ? t.difficulty : 0,
    source: "qbreader",
  };
}

const seen = new Map(); // id -> q
if (existsSync(OUT)) {
  try {
    for (const q of JSON.parse(readFileSync(OUT, "utf8"))) seen.set(q.id, q);
    console.log(`Resuming with ${seen.size} existing questions`);
  } catch {}
}

for (const [sub, target] of Object.entries(TARGETS)) {
  let have = [...seen.values()].filter((q) => q.subcategory === sub).length;
  let stale = 0;
  while (have < target && stale < 8) {
    const before = seen.size;
    let batch;
    try {
      batch = await fetchBatch(sub, 50);
    } catch (e) {
      console.error(`  retry ${sub}: ${e.message}`);
      await sleep(2000);
      stale++;
      continue;
    }
    for (const t of batch) {
      const existing = seen.get(t._id);
      if (existing) {
        // enrich previously fetched questions with difficulty
        if (!existing.difficulty && typeof t.difficulty === "number") existing.difficulty = t.difficulty;
        continue;
      }
      if ((t.question_sanitized || t.question) && (t.answer_sanitized || t.answer)) {
        const q = clean(t);
        if (q.question.length > 80) seen.set(t._id, q);
      }
    }
    stale = seen.size === before ? stale + 1 : 0;
    have = [...seen.values()].filter((q) => q.subcategory === sub).length;
    console.log(`${sub}: ${have}/${target}`);
    await sleep(400);
  }
}

const all = [...seen.values()];
writeFileSync(OUT, JSON.stringify(all, null, 1));
console.log(`\nWrote ${all.length} questions to ${OUT}`);
const counts = {};
for (const q of all) counts[q.subcategory] = (counts[q.subcategory] || 0) + 1;
console.log(counts);
