// Validates a staged batch of AI-generated questions against the answer
// checker, schema rules, and the existing bank (id collisions, near-dupes).
// Usage: node scripts/validate-generated.mjs data/staging/<file>.json [--json]
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildExistingIndex, validateQuestion } from "./lib/validate-question.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "data");

const args = process.argv.slice(2).filter((a) => a !== "--json");
const asJson = process.argv.includes("--json");
const file = args[0];
if (!file) {
  console.error("Usage: node scripts/validate-generated.mjs data/staging/<file>.json [--json]");
  process.exit(1);
}

function loadBank(name) {
  const p = path.join(DATA, name);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return []; }
}

const batchPath = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
const batch = JSON.parse(readFileSync(batchPath, "utf8"));

const existing = [...loadBank("questions.json"), ...loadBank("original-sports.json"), ...loadBank("ai-sports.json")];
const index = buildExistingIndex([existing]);

const results = [];
let failCount = 0, warnCount = 0;
for (const q of batch) {
  const r = validateQuestion(q, index);
  results.push(r);
  if (!r.pass) failCount++;
  if (r.warnings.length) warnCount++;
  // let later questions in the same batch collide-check against earlier ones
  if (r.pass && q.id) index.allIds.add(q.id);
}

if (asJson) {
  console.log(JSON.stringify(results, null, 1));
} else {
  results.forEach((r, i) => {
    const q = batch[i];
    const label = `[${i + 1}/${batch.length}] id=${JSON.stringify(r.id)} "${(q.answer || "").slice(0, 50)}"`;
    if (r.pass && !r.warnings.length) console.log(`${label} -> PASS`);
    else if (r.pass) console.log(`${label} -> WARN: ${r.warnings.join("; ")}`);
    else console.log(`${label} -> FAIL: ${r.failures.join("; ")}${r.warnings.length ? " | also: " + r.warnings.join("; ") : ""}`);
  });
  console.log(`\n${batch.length - failCount} passed, ${failCount} failed, ${warnCount} with warnings`);
}

process.exitCode = failCount > 0 ? 1 : 0;
