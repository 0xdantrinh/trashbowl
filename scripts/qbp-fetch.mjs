// Downloads packet files for each Sports set found by qbp-discover.mjs.
// Usage:
//   node scripts/qbp-fetch.mjs [--limit=N] [--only=id,id,...]
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { USER_AGENT } from "./qbp-discover.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "data", "quizbowlpackets-cache");
const SETS_FILE = path.join(CACHE_DIR, "sets.json");
const RAW_DIR = path.join(CACHE_DIR, "raw");
const MANIFEST_FILE = path.join(CACHE_DIR, "manifest.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : Infinity;
const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",")) : null;

function extractPacketLinks(html, setId) {
  const links = [];
  const re = new RegExp(`href="(https://files\\.quizbowlpackets\\.com/${setId}/[^"]+)"`, "g");
  let m;
  while ((m = re.exec(html))) {
    const url = m[1].replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
    links.push(url);
  }
  return [...new Set(links)];
}

function labelFromFilename(decoded) {
  const base = path.basename(decoded).replace(/\.(pdf|docx)$/i, "");
  const m = base.match(/\b(packet|round)\s*(\d+)/i);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}` : base;
}

async function main() {
  if (!existsSync(SETS_FILE)) {
    console.error(`${SETS_FILE} not found — run scripts/qbp-discover.mjs first.`);
    process.exit(1);
  }
  const sets = JSON.parse(readFileSync(SETS_FILE, "utf8"));
  const targets = (only ? sets.filter((s) => only.has(s.set_id)) : sets).slice(0, limit);
  console.log(`Fetching packet files for ${targets.length} set(s)${only ? " (--only)" : ""}${limitArg ? ` (--limit=${limit})` : ""}`);

  const manifest = existsSync(MANIFEST_FILE) ? JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) : {};

  for (const set of targets) {
    const setUrl = `https://popculture.quizbowlpackets.com/${set.set_id}`;
    let html;
    try {
      const res = await fetch(setUrl, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) { console.log(`  ${set.set_id} (${set.set_name}): GET ${setUrl} -> ${res.status}, skipping`); continue; }
      html = await res.text();
    } catch (e) {
      console.log(`  ${set.set_id} (${set.set_name}): fetch failed (${e.message}), skipping`);
      continue;
    }
    const links = extractPacketLinks(html, set.set_id);
    if (!links.length) {
      console.log(`  ${set.set_id} (${set.set_name}): no packet files found on set page`);
      manifest[set.set_id] = manifest[set.set_id] || [];
      await sleep(500);
      continue;
    }

    const setDir = path.join(RAW_DIR, set.set_id);
    mkdirSync(setDir, { recursive: true });
    const files = manifest[set.set_id] || [];
    let downloaded = 0, skipped = 0, unsupported = [];

    for (const url of links) {
      const decoded = decodeURIComponent(new URL(url).pathname.split("/").pop());
      const localPath = path.join(setDir, decoded);
      const ext = (decoded.match(/\.(pdf|docx)$/i) || [, ""])[1].toLowerCase();
      if (!ext) {
        // e.g. a .zip bundle instead of individual packet files — not
        // handled in v1 (would need an unzip dependency), logged so it's
        // visible rather than silently yielding zero files for this set
        unsupported.push(decoded);
        continue;
      }

      if (!files.some((f) => f.filename === decoded)) {
        files.push({ filename: decoded, localPath: path.relative(path.join(__dirname, ".."), localPath), url, packetLabel: labelFromFilename(decoded), ext });
      }

      if (existsSync(localPath)) { skipped++; continue; }
      try {
        const fres = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
        if (!fres.ok) { console.log(`    GET ${url} -> ${fres.status}`); continue; }
        const buf = Buffer.from(await fres.arrayBuffer());
        writeFileSync(localPath, buf);
        downloaded++;
      } catch (e) {
        console.log(`    download failed for ${url}: ${e.message}`);
      }
      await sleep(700);
    }

    manifest[set.set_id] = files;
    console.log(`  ${set.set_id} (${set.set_name}): ${downloaded} downloaded, ${skipped} already cached, ${files.length} total files${unsupported.length ? `, SKIPPED unsupported: ${unsupported.join(", ")}` : ""}`);
    writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 1));
    await sleep(500);
  }

  console.log(`\nManifest written to ${MANIFEST_FILE}`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
