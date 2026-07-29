// Answer checking: parses quizbowl answer lines and fuzzy-matches player guesses.

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

// Extract acceptable answer strings from a quizbowl answer line.
export function extractCandidates(answerLine) {
  const candidates = new Set();
  const line = answerLine || "";

  // Main answer: text before first bracket/paren directive
  const main = line.split(/[\[\(]/)[0].trim();
  if (main) candidates.add(main);

  // Bracketed directives
  const brackets = line.match(/\[([^\]]+)\]/g) || [];
  for (const b of brackets) {
    const inner = b.slice(1, -1);
    // split clauses on ; or ,
    for (const clause of inner.split(/[;,]/)) {
      const c = clause.trim();
      if (/do not|don't|reject|prompt/i.test(c)) continue; // skip prompts/rejects
      const m = c.match(/^(?:or|accept|also accept)\s+(.+)$/i);
      if (m) candidates.add(m[1].replace(/\b(before|until|after)\b.*$/i, "").trim());
    }
  }

  const out = new Set();
  for (const c of candidates) {
    const n = normalize(c);
    if (n) out.add(n);
    // Surname / last-word variant for multiword proper answers
    const words = n.split(" ");
    if (words.length > 1) {
      const last = words[words.length - 1];
      if (last.length >= 4) out.add(last);
    }
  }
  return [...out];
}

export function checkAnswer(guess, answerLine) {
  const g = normalize(guess);
  if (!g) return false;
  const candidates = extractCandidates(answerLine);
  for (const c of candidates) {
    if (g === c) return true;
    // containment either way (guard against trivially short strings)
    if (c.length >= 4 && g.length >= 4 && (c.includes(g) || g.includes(c))) {
      const shorter = Math.min(c.length, g.length);
      if (shorter >= 4 && shorter / Math.max(c.length, g.length) > 0.3) return true;
    }
    // fuzzy
    const dist = levenshtein(g, c);
    if (dist <= Math.max(1, Math.floor(c.length / 5))) return true;
  }
  return false;
}
