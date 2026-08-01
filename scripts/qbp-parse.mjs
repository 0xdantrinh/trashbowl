// Converts downloaded packet files (manifest.json) into raw tossups
// (bonuses discarded — this app only plays tossups). Usage:
//   node scripts/qbp-parse.mjs [--force]
//
// Two source formats, unified via a plain-text + position-map:
//   - PDF (pdf-parse): plain text, no formatting. Power marks only survive
//     as a literal "(*)" token if the author typed one; otherwise a
//     tossup ends up with zero power marks (validate-question.mjs already
//     treats that as a warning, not a failure).
//   - DOCX (mammoth): HTML with <strong>/<u> preserved, normalized to
//     <b>/<u>. All boundary-finding (tossup numbering, ANSWER marker,
//     bonus detection) runs against a fully tag-stripped PLAIN-TEXT view —
//     an early version of this script tried to run those regexes directly
//     against the tagged HTML (tags don't match \d or "ANSWER", so it
//     seemed safe), but mammoth emits zero literal newlines and visible
//     text is almost always preceded by tags ("<p><b>1. In the..."), which
//     breaks any line-start-anchored regex. A position map (plain index ->
//     original index, same technique lib/answer-check.js's stripBoldMask
//     uses) lets every regex run on clean plain text while still letting
//     the DOCX answer span be sliced back out of the ORIGINAL tagged text
//     afterward, to preserve <b> for answerDisplay.
//
// Real packets on this archive vary a lot in convention (confirmed by
// downloading and inspecting real files, not assumed): numbering as
// "1." / "1)" / Word's native <ol>/<li> list (no visible number at all);
// answer markers as "ANSWER:" / "Answer:"; bonuses either as a resetting-
// to-1 second block (academic convention) or paired immediately after
// their tossup reusing the same number (common in casual trash packets)
// with [10]/[10m]/[10h]/[10e]-style part markers. This parser handles the
// numbered "N. ... ANSWER: ..." convention (by far the most common and
// highest-quality one in what was sampled), with an <li>-based fallback
// for native Word lists, and SKIPS — with a logged reason — any file where
// neither structure is found, rather than guessing at an unfamiliar layout.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "data", "quizbowlpackets-cache");
const MANIFEST_FILE = path.join(CACHE_DIR, "manifest.json");
const PARSED_DIR = path.join(CACHE_DIR, "parsed");

const force = process.argv.includes("--force");

// Strips tags, returning plain text plus map[plainIndex] = index in the
// original string. Safe to run on plain text with no tags at all (PDF) —
// map becomes the identity function. Block-level tag boundaries (p/li/br/
// div) insert a synthetic "\n" into the plain output — mammoth's HTML has
// ZERO literal whitespace between paragraphs ("</p><p>" with nothing
// between), so without this every paragraph/list-item runs directly into
// the next with no separator at all, destroying line-start anchors.
function toPlainWithMap(original) {
  let plain = "";
  const map = [];
  let i = 0;
  while (i < original.length) {
    if (original[i] === "<") {
      const end = original.indexOf(">", i);
      if (end === -1) { plain += original[i]; map.push(i); i++; continue; }
      const tag = original.slice(i + 1, end);
      if (/^\/?(p|li|br|div)\b/i.test(tag)) { plain += "\n"; map.push(end); }
      i = end + 1;
      continue;
    }
    plain += original[i];
    map.push(i);
    i++;
  }
  return { plain, map };
}

// smallest plain index i such that map[i] >= originalIdx (map ascending)
function originalToPlainIndex(map, originalIdx) {
  let lo = 0, hi = map.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid] < originalIdx) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Non-block tags (<b>, </b>, <u>, </u>, <em>, ...) have NO plain-text
// representation at all in the map — they're pure noise to toPlainWithMap,
// skipped with no map entry. So the tagged-end boundary must be the
// ORIGINAL position of the NEXT plain character (map[plainEnd]), not
// map[plainEnd-1]+1 — using the latter stops right after the last plain
// character and silently drops any closing tags sitting between it and
// the next one (e.g. cuts "Kevin <b><u>Mench" off before "</u></b>").
function originalSliceForPlainRange(original, map, plainStart, plainEnd) {
  const a = plainStart < map.length ? map[plainStart] : original.length;
  const b = plainEnd < map.length ? map[plainEnd] : original.length;
  return original.slice(a, b);
}

// trailing writer-credit tag, e.g. "... <Weiner>" at the end of an answer
function stripAuthorCredit(s) {
  return s.replace(/\s*<[A-Z][A-Za-z.''-]{0,30}>\s*$/, "").trim();
}

// Removes repeated header/footer lines (set name, page markers) that show
// up on 2+ "pages" — PDF only; DOCX has no page concept in the same sense.
function stripRepeatedLines(pages) {
  const counts = new Map();
  for (const p of pages) {
    const lines = new Set(p.split("\n").map((l) => l.trim()).filter((l) => l.length > 3));
    for (const l of lines) counts.set(l, (counts.get(l) || 0) + 1);
  }
  const repeated = new Set([...counts.entries()].filter(([, n]) => n >= 2).map(([l]) => l));
  return pages
    .map((p) => p.split("\n").filter((l) => !repeated.has(l.trim())).join("\n"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

// Finds sequential "N." tossup starts in plain text, returns
// [{num, contentStart, end}]. Only accepts a marker whose number is
// exactly the previous accepted tossup's number + 1 (starting at 1) —
// rejects bonus-block restarts and stray in-question numerals (a date, a
// stat) by construction.
function findTossupSpans(plain) {
  const markerRe = /(?:^|\n)\s*(\d{1,3})[.)]\s+/g;
  const candidates = [];
  let m;
  while ((m = markerRe.exec(plain))) candidates.push({ num: Number(m[1]), start: m.index, contentStart: m.index + m[0].length });

  // EVERY candidate marker is a hard boundary, whether or not it turns out
  // to be a real (sequential) tossup start — a common convention pairs
  // each tossup with a bonus that reuses its own number right after it
  // (e.g. "1. <tossup> ANSWER: ... 1. <bonus...>"). If a rejected/
  // non-sequential marker doesn't still end the previous span, its content
  // silently gets absorbed into that tossup's answer text instead of
  // being separately excluded by looksLikeBonus().
  for (let i = 0; i < candidates.length; i++) {
    candidates[i].end = i + 1 < candidates.length ? candidates[i + 1].start : plain.length;
  }

  const spans = [];
  let expected = 1;
  for (const c of candidates) {
    if (c.num !== expected) continue;
    spans.push(c);
    expected++;
  }
  return spans;
}

// Some packets label tossups/bonuses explicitly ("Tossup 15:" / "Bonus 15 -")
// instead of bare "N." numbering, and REUSE the tossup's own number for its
// bonus (same convention as the bare-numbered paired case) — so a bonus
// block's own internal "ANSWER:" markers must not leak into the preceding
// tossup. Every Tossup/Bonus label is a hard boundary (mirrors
// findTossupSpans' all-candidates-are-boundaries approach); only
// "Tossup"-labeled spans are kept.
function findLabeledTossupSpans(text) {
  const markerRe = /(?:^|\n)\s*(Tossup|Bonus)\s*#?\s*\d{1,3}\s*[:.\-]?\s*/gi;
  const candidates = [];
  let m;
  while ((m = markerRe.exec(text))) candidates.push({ kind: m[1].toLowerCase(), start: m.index, contentStart: m.index + m[0].length });
  for (let i = 0; i < candidates.length; i++) {
    candidates[i].end = i + 1 < candidates.length ? candidates[i + 1].start : text.length;
  }
  return candidates.filter((c) => c.kind === "tossup");
}

// Word's native numbered-list feature (as opposed to an author typing "1."
// literally) stores the number in list metadata, not as visible text — an
// <ol>/<li> packet has NO numbering text for findTossupSpans to find at
// all. Fallback: treat each top-level <li> (in the ORIGINAL tagged text)
// as a tossup start, converted to plain-text coordinates. The span extends
// to the start of the NEXT <li>, since the answer paragraph is commonly a
// sibling <p> AFTER the list item, not nested inside it.
function findListItemSpans(original, map) {
  const opens = [...original.matchAll(/<li\b[^>]*>/gi)];
  return opens.map((m, i) => {
    const origStart = m.index + m[0].length;
    const origEnd = i + 1 < opens.length ? opens[i + 1].index : original.length;
    return { num: i + 1, contentStart: originalToPlainIndex(map, origStart), end: originalToPlainIndex(map, origEnd) };
  });
}

// Last-resort fallback: some packets (confirmed live — the whole "Let's
// Remember Some Guys" series) have NO numbering or list structure at
// all, just consecutive "question text ANSWER: answer text" paragraphs
// back to back. Splits purely on ANSWER-marker occurrences: each tossup
// runs from the end of the previous answer to the next paragraph break
// after THIS answer marker (toPlainWithMap already injects "\n" at every
// </p>/<br>/</li>, so this works for both DOCX and PDF).
function findAnswerDrivenSpans(plain) {
  const markers = [...plain.matchAll(/\bANSWER\b:?\s*/gi)];
  const spans = [];
  let questionStart = 0;
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    const answerStart = m.index + m[0].length;
    // The answer clause commonly wraps onto a second (or third) source
    // line — e.g. a long "(accept X; prompt on Y)" directive — so don't
    // stop at the FIRST line break if that would cut the clause off with
    // an unclosed paren/bracket (confirmed live: real answers silently
    // truncated mid-directive, e.g. "...accept KU for" with the closing
    // "Kansas)" stranded on the next source line). Keep extending line by
    // line while one remains open, capped against a genuinely malformed
    // or never-closed line.
    let end = plain.indexOf("\n", answerStart);
    if (end === -1) end = plain.length;
    for (let extra = 0; extra < 4 && end < plain.length; extra++) {
      const clause = plain.slice(answerStart, end);
      const opens = (clause.match(/[(\[]/g) || []).length;
      const closes = (clause.match(/[)\]]/g) || []).length;
      if (opens <= closes) break;
      const next = plain.indexOf("\n", end + 1);
      end = next === -1 ? plain.length : next;
    }
    spans.push({ num: i + 1, contentStart: questionStart, end });
    questionStart = end;
  }
  return spans;
}

// A span is a bonus (not a tossup) if it has 2+ "[10...]"-style part
// markers before its first answer marker — used to double check a
// candidate that already passed the strict-sequential-numbering filter,
// which normally rejects bonus-block restarts on its own, but not the
// "bonus paired right after its tossup, reusing the same number" style.
function looksLikeBonus(spanPlainText) {
  const beforeAnswer = spanPlainText.split(/\bANSWER\b:?/i)[0];
  return (beforeAnswer.match(/\[\s*10\s*[a-z]?\s*\]/gi) || []).length >= 2;
}

// net open count of <tagName> in original[0, pos) — used to detect a slice
// starting mid-span (e.g. bold wraps "Answer: Randall Cobb" as a whole, so
// slicing after "Answer:" starts inside an already-open <b>, dropping its
// opening tag while keeping the later closing one)
function openTagCountBefore(original, pos, tagName) {
  const re = new RegExp(`<(/?)${tagName}\\b[^>]*>`, "gi");
  let depth = 0, m;
  while ((m = re.exec(original)) && m.index < pos) {
    depth = m[1] === "/" ? Math.max(0, depth - 1) : depth + 1;
  }
  return depth;
}

const ANSWER_RE = /\bANSWER\b:?\s*/i;
const POWER_TOKEN_RE = /\(\s*\*\s*\)/;

// Rejects a segmentation where a span's content AFTER its first "ANSWER:"
// marker itself contains another "ANSWER:" — a strong signal the span
// boundary missed a real tossup/bonus start and silently swallowed extra
// content (e.g. a doc with only one stray "1." false-positive marker and
// no other numbering produces a single span spanning the entire rest of
// the file). The embedded check specifically requires the colon that
// every real marker in this corpus is written with ("ANSWER:") — the bare
// word "answer" legitimately recurs in ordinary prompt/accept-clause
// prose ("prompt if the answer is only part of..."), which a colon-less
// check false-positives on, wrongly distrusting an otherwise perfectly
// well-formed numbered file and routing it to a lossier fallback tier.
function spansAreClean(plain, spans) {
  if (!spans.length) return false;
  for (const span of spans) {
    const spanPlain = plain.slice(span.contentStart, span.end);
    const m = ANSWER_RE.exec(spanPlain);
    if (!m) continue;
    const afterAnswer = spanPlain.slice(m.index + m[0].length);
    if (/\bANSWER:\s/i.test(afterAnswer)) return false;
  }
  return true;
}

function parseTossupSpan(plain, original, map, span, sourceFormat, warnings) {
  const spanPlain = plain.slice(span.contentStart, span.end);
  const answerMatch = ANSWER_RE.exec(spanPlain);
  if (!answerMatch) return null; // no answer marker found — logged by caller

  const questionPlainEnd = span.contentStart + answerMatch.index;
  const answerPlainStart = span.contentStart + answerMatch.index + answerMatch[0].length;

  let questionRaw = plain.slice(span.contentStart, questionPlainEnd).replace(/\s+/g, " ").trim();
  const powerMatches = questionRaw.match(new RegExp(POWER_TOKEN_RE, "g")) || [];
  if (powerMatches.length > 1) {
    let seen = false;
    questionRaw = questionRaw.replace(new RegExp(POWER_TOKEN_RE, "g"), () => (seen ? "" : ((seen = true), "(*)"))).replace(/\s{2,}/g, " ").trim();
    warnings.push(`stripped ${powerMatches.length - 1} extra power mark(s)`);
  } else if (powerMatches.length === 0) {
    warnings.push("no (*) power mark found in source text");
  }

  const answerRaw = stripAuthorCredit(plain.slice(answerPlainStart, span.end).replace(/\s+/g, " ").trim());
  if (!answerRaw) return null;

  let answerDisplayRaw = answerRaw;
  if (sourceFormat === "docx") {
    // a doc where <b> already wraps the "ANSWER:" marker word itself is
    // bolding the whole answer LINE as visual flourish, not marking a
    // specific required span — confirmed on a real file where the bold
    // literally wrapped "Answer: Randall Cobb" in full (would otherwise
    // make "Cobb" alone only prompt instead of judge correct). Underline,
    // when present, is this file's real required-span signal instead.
    const markerPlainStart = span.contentStart + answerMatch.index;
    const markerOrigStart = markerPlainStart < map.length ? map[markerPlainStart] : original.length;
    const boldWrapsMarker = openTagCountBefore(original, markerOrigStart, "b") > 0;
    const answerOrigStart = answerPlainStart < map.length ? map[answerPlainStart] : original.length;
    const openB = openTagCountBefore(original, answerOrigStart, "b");
    const openU = openTagCountBefore(original, answerOrigStart, "u");
    let taggedAnswer = originalSliceForPlainRange(original, map, answerPlainStart, span.end);
    // block-level structural tags (mammoth emits zero literal whitespace at
    // these boundaries) become a literal space rather than being deleted —
    // dropping them merges adjacent words/parentheticals with no space once
    // tags are stripped for judging/display-text comparison
    taggedAnswer = taggedAnswer.replace(/<\/?(?:p|li|br|div|ol|ul)\b[^>]*>?/gi, " ");
    if (boldWrapsMarker) taggedAnswer = taggedAnswer.replace(/<\/?b\b[^>]*>/gi, "");
    // re-open any <b>/<u> span that was already open at the slice's start
    // (see openTagCountBefore) so the closing tag captured within this
    // slice isn't left dangling/unbalanced — <b> only when it's NOT the
    // whole-line stylistic wrap just stripped above
    let prefix = "";
    if (openB > 0 && !boldWrapsMarker) prefix += "<b>".repeat(openB);
    if (openU > 0) prefix += "<u>".repeat(openU);
    taggedAnswer = prefix + taggedAnswer;
    // some packets mark the required portion with underline only, no bold
    // at all — treat that the same as bold+underline so judging (which
    // only reads <b> depth) still picks up the required span
    if (!/<b[\s>]/i.test(taggedAnswer) && /<u[\s>]/i.test(taggedAnswer)) {
      taggedAnswer = taggedAnswer.replace(/<u\b([^>]*)>/gi, "<b><u$1>").replace(/<\/u>/gi, "</u></b>");
    }
    answerDisplayRaw = stripAuthorCredit(taggedAnswer.replace(/\s+/g, " ").trim());
  }

  return { questionRaw, answerRaw, answerDisplayRaw };
}

async function parsePdf(buf) {
  const parser = new PDFParse({ data: buf });
  const result = await parser.getText();
  await parser.destroy();
  return stripRepeatedLines(result.pages.map((p) => p.text));
}

async function parseDocx(buf) {
  const result = await mammoth.convertToHtml({ buffer: buf }, { styleMap: ["u => u"] });
  return result.value.replace(/<strong>/gi, "<b>").replace(/<\/strong>/gi, "</b>");
}

async function parseFile(entry) {
  const abs = path.join(__dirname, "..", entry.localPath);
  const buf = readFileSync(abs);
  const original = entry.ext === "docx" ? await parseDocx(buf) : await parsePdf(buf);
  const { plain, map } = toPlainWithMap(original);

  let spans = findTossupSpans(plain);
  let strategy = "numbered";
  if (!spansAreClean(plain, spans) && entry.ext === "docx" && /<li\b/i.test(original)) {
    const liSpans = findListItemSpans(original, map);
    if (spansAreClean(plain, liSpans)) { spans = liSpans; strategy = "<li>"; }
  }
  if (!spansAreClean(plain, spans)) {
    const labeled = findLabeledTossupSpans(plain);
    if (spansAreClean(plain, labeled)) { spans = labeled; strategy = "Tossup N:"; }
  }
  if (!spansAreClean(plain, spans)) {
    // guaranteed clean by construction (every span ends at the very next
    // ANSWER: occurrence), so this always terminates the fallback chain
    spans = findAnswerDrivenSpans(plain);
    strategy = "answer-marker";
  }

  const tossups = [];
  let skippedNoAnswer = 0, skippedBonus = 0;

  spans.forEach((span, i) => {
    const spanPlain = plain.slice(span.contentStart, span.end);
    if (looksLikeBonus(spanPlain)) { skippedBonus++; return; }
    const warnings = [];
    const parsed = parseTossupSpan(plain, original, map, span, entry.ext, warnings);
    if (!parsed) { skippedNoAnswer++; return; }
    tossups.push({
      packetLabel: entry.packetLabel,
      tossupNumber: i + 1,
      ...parsed,
      sourceFile: entry.filename,
      sourceFormat: entry.ext,
      parseWarnings: warnings,
    });
  });

  return { tossups, spansFound: spans.length, skippedNoAnswer, skippedBonus, strategy };
}

async function main() {
  if (!existsSync(MANIFEST_FILE)) {
    console.error(`${MANIFEST_FILE} not found — run scripts/qbp-fetch.mjs first.`);
    process.exit(1);
  }
  mkdirSync(PARSED_DIR, { recursive: true });
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));

  let totalTossups = 0;
  for (const [setId, files] of Object.entries(manifest)) {
    const outFile = path.join(PARSED_DIR, `${setId}.json`);
    if (existsSync(outFile) && !force) { console.log(`  ${setId}: already parsed (use --force to redo)`); continue; }
    if (!files.length) { console.log(`  ${setId}: no files to parse`); continue; }

    let allTossups = [];
    for (const entry of files) {
      try {
        const { tossups, spansFound, skippedNoAnswer, skippedBonus, strategy } = await parseFile(entry);
        allTossups.push(...tossups);
        console.log(`  ${setId}/${entry.filename}: ${spansFound} spans (${strategy}) -> ${tossups.length} tossups (${skippedBonus} bonus, ${skippedNoAnswer} no-answer-marker skipped)`);
      } catch (e) {
        console.log(`  ${setId}/${entry.filename}: PARSE FAILED — ${e.message}`);
      }
    }
    writeFileSync(outFile, JSON.stringify(allTossups, null, 1));
    totalTossups += allTossups.length;
  }

  console.log(`\nParsed ${totalTossups} tossups total across all sets.`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
