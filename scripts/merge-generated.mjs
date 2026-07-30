// Merges an approved staging batch into data/ai-sports.json. Re-validates
// every question against the CURRENT bank at merge time (never trusts a
// stale validate-time pass) and skips already-merged ids idempotently.
// Usage:
//   node scripts/merge-generated.mjs data/staging/<file>.json          (dry run)
//   node scripts/merge-generated.mjs data/staging/<file>.json --commit
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildExistingIndex, validateQuestion } from "./lib/validate-question.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "data");
const DEST = path.join(DATA, "ai-sports.json");

const commit = process.argv.includes("--commit");
const file = process.argv.slice(2).find((a) => a !== "--commit");
if (!file) {
  console.error("Usage: node scripts/merge-generated.mjs data/staging/<file>.json [--commit]");
  process.exit(1);
}

function loadBank(name) {
  const p = path.join(DATA, name);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return []; }
}

const batchPath = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
const batch = JSON.parse(readFileSync(batchPath, "utf8"));
const dest = loadBank("ai-sports.json");
const existing = [...loadBank("questions.json"), ...loadBank("original-sports.json"), ...dest];
const index = buildExistingIndex([existing]);

const toAdd = [];
const skippedAlreadyMerged = [];
const skippedFailed = [];

for (const q of batch) {
  if (dest.some((d) => d.id === q.id)) {
    skippedAlreadyMerged.push(q.id);
    continue;
  }
  const r = validateQuestion(q, index);
  if (!r.pass) {
    skippedFailed.push({ id: q.id, reasons: r.failures });
    continue;
  }
  toAdd.push(q);
  index.allIds.add(q.id); // so a later row in the same batch can't collide with this one
}

console.log(`Batch: ${batch.length} questions`);
console.log(`  already merged (skipped): ${skippedAlreadyMerged.length}${skippedAlreadyMerged.length ? " -> " + skippedAlreadyMerged.join(", ") : ""}`);
if (skippedFailed.length) {
  console.log(`  failing validation (skipped):`);
  for (const s of skippedFailed) console.log(`    ${s.id}: ${s.reasons.join("; ")}`);
}
console.log(`  to add: ${toAdd.length}`);

if (!commit) {
  console.log("\nDry run — no files written. Re-run with --commit to merge.");
  process.exitCode = toAdd.length > 0 ? 0 : 1;
} else {
  if (!toAdd.length) {
    console.log("\nNothing to merge.");
    process.exitCode = 1;
  } else {
    const merged = [...dest, ...toAdd];
    writeFileSync(DEST, JSON.stringify(merged, null, 1));
    console.log(`\nWrote ${merged.length} total questions to ${DEST} (${dest.length} -> ${merged.length})`);
    console.log("Next: git diff data/ai-sports.json, then delete/archive the staging file once you're happy with the diff.");
  }
}
