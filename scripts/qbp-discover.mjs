// Discovers Sports-tagged sets from quizbowlpackets.com's Pop Culture
// (Trash) archive. Metadata only — no downloads. Resumable.
// Usage: node scripts/qbp-discover.mjs
//
// popculture.quizbowlpackets.com is a Next.js App Router site: its set
// listing isn't a clean JSON endpoint, it's embedded as an escaped React
// Server Components ("RSC flight") payload inside the initial page HTML —
// e.g. `\"set_id\":3520,\"set_name\":\"Henry's Obsessions\",...,\"subjects\":
// \"Sports\"`. We extract records by regex rather than a real API, since no
// such API is exposed by the site itself (a third-party "Quizbowl Packets
// API" is referenced online but its base URL couldn't be verified live).
//
// Pagination: tested `?page=2` against the live site — it returns byte-
// identical content to page 1 (same 510 set ids). No working pagination
// mechanism was found, so this treats the single listing load as the full
// corpus. See docs/quizbowlpackets-import.md.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "data", "quizbowlpackets-cache");
const OUT = path.join(CACHE_DIR, "sets.json");

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const LISTING_URL = "https://popculture.quizbowlpackets.com/";

// Pulls {set_id, set_name, subjects, level} records out of the RSC payload.
// Each record's fields (name/subjects/level/etc) can be separated from its
// set_id by a dozen+ other fields (difficulty, urls, timestamps...), so a
// fixed-size window around set_id is NOT safe — it can and did bleed into
// an adjacent record's fields (e.g. grabbing the PRECEDING record's
// "subjects" when this record's own subjects field is far enough away).
// Instead, every set_id position is found first, and each record's search
// span is strictly [this set_id, next set_id) — never crossing into a
// neighboring record.
export function extractSetRecords(html) {
  const idMatches = [...html.matchAll(/set_id\\":(\d+)/g)];
  const records = [];
  const seen = new Set();
  for (let i = 0; i < idMatches.length; i++) {
    const id = idMatches[i][1];
    if (seen.has(id)) continue; // the same record can be referenced more than once in the payload
    seen.add(id);
    const spanStart = idMatches[i].index;
    const spanEnd = i + 1 < idMatches.length ? idMatches[i + 1].index : html.length;
    const span = html.slice(spanStart, spanEnd);
    const nameM = span.match(/set_name\\":\\"((?:[^\\]|\\.)*?)\\"/);
    const subjectsM = span.match(/subjects\\":\\"((?:[^\\]|\\.)*?)\\"/);
    const levelM = span.match(/\blevel\\":(\d+)/);
    if (!nameM) continue;
    records.push({
      set_id: id,
      set_name: unescapeRsc(nameM[1]),
      subjects: subjectsM ? unescapeRsc(subjectsM[1]) : null,
      level: levelM ? Number(levelM[1]) : null,
    });
  }
  return records;
}

function unescapeRsc(s) {
  return s.replace(/\\\\/g, "\\").replace(/\\"/g, '"').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function isSportsTagged(subjects) {
  if (!subjects) return false;
  return subjects.split(",").some((s) => s.trim().toLowerCase() === "sports" || s.trim().toLowerCase().includes("sports"));
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true });

  const seen = new Map();
  if (existsSync(OUT)) {
    try {
      for (const s of JSON.parse(readFileSync(OUT, "utf8"))) seen.set(s.set_id, s);
      console.log(`Resuming with ${seen.size} previously discovered sets`);
    } catch {}
  }

  console.log(`Fetching ${LISTING_URL} ...`);
  const res = await fetch(LISTING_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`GET ${LISTING_URL} -> ${res.status}`);
  const html = await res.text();

  const all = extractSetRecords(html);
  console.log(`Extracted ${all.length} total set records from the listing page`);
  const withSubjects = all.filter((r) => r.subjects);
  console.log(`  ${withSubjects.length} had an extractable subjects field`);

  const sports = all.filter((r) => isSportsTagged(r.subjects));
  console.log(`  ${sports.length} are Sports-tagged`);

  const now = new Date().toISOString();
  let added = 0;
  for (const r of sports) {
    if (!seen.has(r.set_id)) added++;
    seen.set(r.set_id, { ...r, discovered_at: seen.get(r.set_id)?.discovered_at || now });
  }

  const outArr = [...seen.values()];
  writeFileSync(OUT, JSON.stringify(outArr, null, 1));
  console.log(`\nWrote ${outArr.length} Sports-tagged sets to ${OUT} (${added} new this run)`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
