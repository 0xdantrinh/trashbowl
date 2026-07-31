// Tags every question with a level: "Middle School" | "High School" | "College"
// 1) qbreader difficulty: 1 => MS, 2-5 => HS, 6-10 => College
// 2) set-name consensus: sets rated elsewhere share their level
// 3) keyword heuristics for unrated sets (most trash opens are college-level)
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MS = "Middle School", HS = "High School", COL = "College";

export const byDiff = (d) => (d >= 6 ? COL : d >= 2 ? HS : d === 1 ? MS : null);

export const HS_WORDS = /novice|scop|tails|kickoff|prison bowl|bhsat|show-me|\blist\b|tapir|\bsith\b|basqt|hsapq|nasat|maryland|spring|fall kickoff|moqba|bhsu|memorial|invitational|hippopotamus|saucy|kk?ck|state|districts|jv\b/i;
export const MS_WORDS = /middle school|\bms\b|elementary/i;
export const COL_WORDS = /acronym|mkultra|chicago open|oxford|penn bowl|\bwao\b|honk|t-party|dragoon|hybrid|league|geoffrey|dart|\bopen\b|college|acf|ict\b|guerrilla|trashmasters|delta burke|bisb|eft\b|mut\b/i;

// unrated trash sets are overwhelmingly college/open events
export function heuristic(set) {
  if (MS_WORDS.test(set)) return MS;
  if (COL_WORDS.test(set)) return COL;
  if (HS_WORDS.test(set)) return HS;
  return COL;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) await main();

async function main() {
const files = ["questions.json", "original-sports.json"].map((f) => path.join(__dirname, "..", "data", f));
const all = files.map((p) => JSON.parse(readFileSync(p, "utf8")));

// consensus per set from rated questions
const setDiffs = new Map();
for (const qs of all)
  for (const q of qs) {
    const lvl = byDiff(q.difficulty || 0);
    if (lvl) {
      if (!setDiffs.has(q.set)) setDiffs.set(q.set, new Map());
      const m = setDiffs.get(q.set);
      m.set(lvl, (m.get(lvl) || 0) + 1);
    }
  }
const setLevel = new Map();
for (const [set, m] of setDiffs)
  setLevel.set(set, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);

const counts = {};
all.forEach((qs, i) => {
  for (const q of qs) {
    q.level = byDiff(q.difficulty || 0) || setLevel.get(q.set) || heuristic(q.set || "");
    if (q.set === "TrashBowl Originals") q.level = HS;
    counts[q.level] = (counts[q.level] || 0) + 1;
  }
  writeFileSync(files[i], JSON.stringify(qs, null, 1));
});
console.log(counts);
}
