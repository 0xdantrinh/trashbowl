// Maps parsed tossups (data/quizbowlpackets-cache/parsed/<set_id>.json) into
// the app's question schema and writes a reviewable staging batch. Does NOT
// write to any destination file directly — same human-review gate as the
// AI-generation pipeline (see docs/ai-question-generation.md).
// Usage: node scripts/qbp-convert.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { tag as tagSport } from "./tag-sports.mjs";
import { heuristic as levelHeuristic } from "./tag-levels.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "data", "quizbowlpackets-cache");
const SETS_FILE = path.join(CACHE_DIR, "sets.json");
const PARSED_DIR = path.join(CACHE_DIR, "parsed");
const EXCLUDED_DIR = path.join(CACHE_DIR, "excluded");
const STAGING_DIR = path.join(__dirname, "..", "data", "staging");

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function main() {
  if (!existsSync(SETS_FILE)) {
    console.error(`${SETS_FILE} not found — run scripts/qbp-discover.mjs first.`);
    process.exit(1);
  }
  const sets = new Map(JSON.parse(readFileSync(SETS_FILE, "utf8")).map((s) => [s.set_id, s]));
  mkdirSync(EXCLUDED_DIR, { recursive: true });
  mkdirSync(STAGING_DIR, { recursive: true });

  if (!existsSync(PARSED_DIR)) {
    console.error(`${PARSED_DIR} not found — run scripts/qbp-parse.mjs first.`);
    process.exit(1);
  }

  const converted = [];
  let excludedNotSports = 0, excludedEmpty = 0;
  const counters = {}; // per-sport running id counter

  for (const file of readdirSync(PARSED_DIR)) {
    if (!file.endsWith(".json")) continue;
    const setId = file.replace(/\.json$/, "");
    const set = sets.get(setId);
    if (!set) { console.log(`  ${setId}: not in sets.json (stale parsed file?), skipping`); continue; }
    const tossups = JSON.parse(readFileSync(path.join(PARSED_DIR, file), "utf8"));

    const excluded = [];
    let keptForSet = 0;
    for (const t of tossups) {
      if (!t.questionRaw || !t.answerRaw) { excludedEmpty++; continue; }

      // subjects is SET-level metadata — a mixed trash packet tagged
      // "Sports" can (and does) contain non-sports questions too. Gate at
      // the question level: require a real sport-keyword hit, not just
      // membership in a Sports-tagged set.
      const sport = tagSport({ question: t.questionRaw, answer: t.answerRaw });
      if (sport === "other") {
        excluded.push({ ...t, reason: "no sport-keyword hit (tag-sports.mjs returned 'other')" });
        excludedNotSports++;
        continue;
      }

      counters[sport] = (counters[sport] || 0) + 1;
      const id = `qbp-${set.set_id}-${(t.packetLabel || "p").toString().replace(/\s+/g, "").toLowerCase()}-${t.tossupNumber}`;

      converted.push({
        id,
        question: t.questionRaw,
        answer: t.answerRaw,
        answerDisplay: t.answerDisplayRaw,
        category: "Trash",
        subcategory: "Sports",
        set: set.set_name,
        packet: t.packetLabel || "",
        source: "quizbowlpackets",
        sport,
        level: levelHeuristic(set.set_name || ""),
      });
      keptForSet++;
    }

    if (excluded.length) writeFileSync(path.join(EXCLUDED_DIR, `${setId}.json`), JSON.stringify(excluded, null, 1));
    console.log(`  ${set.set_name} (${setId}): ${keptForSet} kept, ${excluded.length} excluded (not sports-specific)`);
  }

  // de-dup ids within this batch (shouldn't happen given the id scheme, but don't silently overwrite if it does)
  const seenIds = new Set();
  const finalBatch = [];
  let idCollisions = 0;
  for (const q of converted) {
    if (seenIds.has(q.id)) { idCollisions++; continue; }
    seenIds.add(q.id);
    finalBatch.push(q);
  }

  const outFile = path.join(STAGING_DIR, `quizbowlpackets-${today()}.json`);
  writeFileSync(outFile, JSON.stringify(finalBatch, null, 1));

  console.log(`\nConverted ${finalBatch.length} questions -> ${outFile}`);
  console.log(`  excluded (not sports-specific): ${excludedNotSports}`);
  console.log(`  excluded (empty question/answer): ${excludedEmpty}`);
  if (idCollisions) console.log(`  WARNING: ${idCollisions} in-batch id collisions dropped`);
  console.log(`  sport breakdown:`, counters);
  console.log(`\nNext: node scripts/validate-generated.mjs ${path.relative(process.cwd(), outFile)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
