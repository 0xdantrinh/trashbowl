// Answer checking: parses quizbowl answer lines and fuzzy-matches player guesses.
//
// Quizbowl convention: the packet's answerDisplay marks the minimum required
// part of an answer in <b><u>...</u></b>. Anything outside that markup (e.g.
// a bare first name when only the surname is bolded) is not wrong, but isn't
// specific enough either — it should be PROMPTED, not instantly judged.
// Explicit "prompt on X" / "do not accept X" prose in the answer line can
// override that default in either direction (e.g. bolded "Manning" still
// gets prompted because the answer line says so, due to Eli Manning).

export function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[“”"'’‘().,:;!?\-–—_/\\]/g, " ")
    .replace(/\b(the|a|an|of)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

// single-word fuzzy comparison (typos/plurals) — never matches across words
function wordMatch(gw, cw) {
  if (gw === cw) return true;
  if (Math.min(gw.length, cw.length) < 4) return false;
  return levenshtein(gw, cw) <= (Math.max(gw.length, cw.length) >= 8 ? 2 : 1);
}

// how many of the candidate phrase's words the guess covers
function coverage(gWords, c) {
  const cWords = c.split(" ");
  let covered = 0, coveredSignificant = false;
  for (const cw of cWords) {
    if (gWords.some((gw) => wordMatch(gw, cw))) {
      covered++;
      if (cw.length >= 4) coveredSignificant = true;
    }
  }
  return { covered, total: cWords.length, coveredSignificant };
}

// whole-phrase fuzzy with spaces removed, so "superbowl" == "super bowl".
// Kept tight: a distance-2 allowance on shorter strings would let a dropped
// required token slip through ("guerrero" vs "guerrero jr").
function squishMatch(g, c) {
  const a = g.replace(/ /g, ""), b = c.replace(/ /g, "");
  if (a === b) return true;
  return levenshtein(a, b) <= (b.length >= 12 ? 2 : 1);
}

function unquote(s) {
  return (s || "").trim().replace(/^[“"]+|[”"]+$/g, "").trim();
}

// "X or Y or Z" -> ["X", "Y", "Z"]
function splitOr(text) {
  return text.split(/\s+or\s+/i).map((s) => s.trim()).filter(Boolean);
}

// Cut off trailing qualifiers that describe *when*/*how* a directive applies
// rather than the acceptable text itself, e.g. "X before mentioned", "X alone".
function stripQualifiers(s) {
  return s
    .replace(/\b(before|until|after|with|by)\b.*$/i, "")
    .replace(/\balone\b\s*$/i, "")
    .trim();
}

function add(raw, out) {
  const n = normalize(raw);
  if (n) out.add(n);
}

// Strip <b>/<u>/etc tags from packet HTML, keeping a per-character flag for
// whether each surviving character sat inside a <b> (bold) tag.
function stripBoldMask(html) {
  let text = "";
  const bold = [];
  let depth = 0;
  let i = 0;
  while (i < html.length) {
    if (html[i] === "<") {
      const end = html.indexOf(">", i);
      if (end === -1) { text += html[i]; bold.push(depth > 0); i++; continue; }
      const tag = html.slice(i + 1, end);
      if (/^b(\s|$)/i.test(tag)) depth++;
      else if (/^\/b(\s|$)/i.test(tag)) depth = Math.max(0, depth - 1);
      i = end + 1;
      continue;
    }
    text += html[i];
    bold.push(depth > 0);
    i++;
  }
  return { text, bold };
}

const WORD_RE = /[\p{L}\p{N}'’.-]+/gu;

// Split text[start,end) into contiguous bold/non-bold word runs. Two bold
// word-spans only merge into one run if the gap between them (e.g. a space)
// is itself fully bold — that's how the packet format distinguishes "Green
// Bay Packers" (one bold run, said together) from "Green Bay" + "Packers"
// (two independently-bolded, independently-sufficient answers).
function classifyBoldRuns(text, bold, start, end) {
  WORD_RE.lastIndex = start;
  const spans = [];
  let m;
  while ((m = WORD_RE.exec(text)) && m.index < end) {
    if (m.index >= start) spans.push({ start: m.index, end: m.index + m[0].length, word: m[0] });
  }
  const runs = [];
  let cur = null;
  for (const sp of spans) {
    const chars = bold.slice(sp.start, sp.end);
    const isBold = chars.filter(Boolean).length / chars.length > 0.5;
    let merge = false;
    if (cur && cur.isBold === isBold) {
      merge = isBold ? bold.slice(cur.end, sp.start).every(Boolean) : true;
    }
    if (merge) { cur.words.push(sp.word); cur.end = sp.end; }
    else { cur = { isBold, words: [sp.word], end: sp.end }; runs.push(cur); }
  }
  if (!runs.some((r) => r.isBold)) {
    // no bold markup in this span at all — treat the whole phrase as required
    return { required: [text.slice(start, end)], extra: [] };
  }
  return {
    required: runs.filter((r) => r.isBold).map((r) => r.words.join(" ")),
    extra: runs.filter((r) => !r.isBold).map((r) => r.words.join(" ")),
  };
}

// Parse a quizbowl answer line (+ optional bolded answerDisplay) into
// accept/prompt/reject candidate sets.
export function parseAnswerLine(answerLine, answerDisplay) {
  const rawLine = answerLine || "";
  let { text, bold } = stripBoldMask(answerDisplay || rawLine);
  // some packet formats only bold the main phrase and omit accept/prompt
  // directives from answerDisplay entirely — recover them from the raw
  // answer line (with no bold info) so those directives still get parsed.
  if (rawLine.length > text.length && rawLine.startsWith(text)) {
    bold = bold.concat(new Array(rawLine.length - text.length).fill(false));
    text = rawLine;
  } else if (!text) {
    text = rawLine;
    bold = new Array(rawLine.length).fill(false);
  }
  const line = text;

  const explicitAccept = new Set();
  const explicitPrompt = new Set();
  const reject = new Set();
  const boldRequired = new Set();
  const boldExtra = new Set();

  // a leading "(Optional word) real answer" marks the parenthetical as
  // droppable, not a directive — e.g. "(American) football" == "football".
  const leadingOptional = line.match(/^(?:\[([^\]]*)\]|\(([^)]*)\))\s*/);
  const leadingOptText = leadingOptional ? (leadingOptional[1] ?? leadingOptional[2]) : null;
  const mainStart = leadingOptional ? leadingOptional[0].length : 0;
  const restBracketIdx = line.slice(mainStart).search(/[\[(]/);
  const mainEnd = restBracketIdx === -1 ? line.length : mainStart + restBracketIdx;
  const main = line.slice(mainStart, mainEnd).trim();
  if (main) {
    add(main, explicitAccept);
    if (leadingOptText) add(leadingOptText.trim() + " " + main, explicitAccept);
    const { required, extra } = classifyBoldRuns(line, bold, mainStart, mainEnd);
    for (const r of required) if (normalize(r).length >= 3) add(r, boldRequired);
    for (const r of extra) if (normalize(r).length >= 3) add(r, boldExtra);
  }

  // brackets may contain parens ("[... on \"(University of) Michigan\"]"),
  // so the two directive styles are matched separately
  for (const block of line.matchAll(/\[([^\]]*)\]|\(([^)]*)\)/g)) {
    const blockStart = block.index;
    const inner = block[1] ?? block[2];
    for (const rawClause of inner.split(/[;,]/)) {
      const clause = rawClause.trim();
      if (!clause) continue;

      const rejectMatch =
        clause.match(/^do\s*n[o']t\s+(?:accept|prompt)(?:\s*(?:\/|or)\s*(?:accept|prompt))?\s*(?:on)?\s+(.+)$/i) ||
        clause.match(/^reject\s+(.+)$/i);
      if (rejectMatch) {
        const t = stripQualifiers(unquote(rejectMatch[1]));
        for (const part of splitOr(t)) {
          add(unquote(part), reject);
          // "(University of) Michigan" also rejects plain "Michigan"
          const noParen = part.replace(/\([^)]*\)/g, " ").trim();
          if (noParen && noParen !== part) add(unquote(noParen), reject);
        }
        continue;
      }
      // unparsed negative form — drop the clause entirely rather than misfile it
      if (/^do\s*n[o']t\b/i.test(clause) || /\breject\b/i.test(clause)) continue;

      const promptMatch = clause.match(/^prompt on\s+(.+)$/i);
      if (promptMatch) {
        let t = stripQualifiers(unquote(promptMatch[1]));
        const like = t.match(/^(?:less|more)?\s*specific (?:answers?|portions?)\s*(?:like|such as)\s+(.+)$/i);
        if (like) t = like[1];
        else if (/^(less specific|more specific|partial answer|specific portion)/i.test(t)) continue;
        for (const part of splitOr(t)) add(unquote(part), explicitPrompt);
        continue;
      }

      const acceptMatch = clause.match(/^(?:or|accept|also accept)\s+(.+)$/i);
      if (acceptMatch) {
        const raw = acceptMatch[1].trim();
        const t = stripQualifiers(unquote(raw));
        for (const part of splitOr(t)) add(unquote(part), explicitAccept);
        const idx = line.indexOf(raw, blockStart);
        if (idx !== -1) {
          const { required, extra } = classifyBoldRuns(line, bold, idx, idx + raw.length);
          for (const r of required) if (normalize(r).length >= 3) add(r, boldRequired);
          for (const r of extra) if (normalize(r).length >= 3) add(r, boldExtra);
        }
      }
    }
  }

  // explicit prose always overrides the bold-derived default in both directions
  for (const c of explicitPrompt) boldRequired.delete(c);
  for (const c of explicitAccept) boldExtra.delete(c);

  const accept = new Set([...explicitAccept, ...boldRequired]);
  const prompt = new Set([...boldExtra, ...explicitPrompt]);
  for (const c of accept) prompt.delete(c);

  // strict: the packet marked the minimum required part in bold, so partial
  // phrases must be prompted; without markup we fall back to lenient
  // conventions (surname alone is enough for a multiword answer)
  return { accept: [...accept], prompt: [...prompt], reject: [...reject], strict: bold.some(Boolean) };
}

export function extractCandidates(answerLine) {
  return parseAnswerLine(answerLine).accept;
}

// Judge a guess against a quizbowl answer line: "correct" | "prompt" | "incorrect".
// A guess is correct only if it covers EVERY word of some accepted phrase
// ("carolina" alone never scores against "South Carolina"); covering part of
// a required phrase earns a prompt, matching how a human moderator rules.
export function judgeGuess(guess, answerLine, answerDisplay) {
  const g = normalize(guess);
  if (!g) return "incorrect";
  const { accept, prompt, reject, strict } = parseAnswerLine(answerLine, answerDisplay);
  const gWords = g.split(" ");

  const fullMatch = (c) => {
    if (g === c || squishMatch(g, c)) return true;
    const { covered, total } = coverage(gWords, c);
    if (covered === total) return true;
    // no bold markup to say otherwise → surname/last-word alone suffices
    if (!strict && total > 1) {
      const last = c.split(" ").pop();
      if (last.length >= 4 && gWords.some((gw) => wordMatch(gw, last))) return true;
    }
    return false;
  };

  // explicit negatives win, but only on the exact phrase — substring or fuzzy
  // rejection would kill legitimate answers ("water polo" when bare "polo" is
  // rejected; "baseketball" when "basketball" is rejected)
  for (const c of reject) if (g === c || g.replace(/ /g, "") === c.replace(/ /g, "")) return "incorrect";
  for (const c of accept) if (fullMatch(c)) return "correct";
  for (const c of prompt) if (fullMatch(c)) return "prompt";
  // partial coverage of a required phrase (a real word of it, not scraps)
  for (const c of accept) {
    const { covered, total, coveredSignificant } = coverage(gWords, c);
    if (covered > 0 && covered < total && coveredSignificant) return "prompt";
  }
  return "incorrect";
}

export function checkAnswer(guess, answerLine) {
  return judgeGuess(guess, answerLine) === "correct";
}
