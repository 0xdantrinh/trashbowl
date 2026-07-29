// Auto-tags Sports questions with a specific sport (football, baseball, ...) by keyword.
// Usage: node scripts/tag-sports.mjs
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RULES = [
  ["football", /\b(nfl|quarterback|touchdown|super bowl|wide receiver|linebacker|end zone|field goal|running back|heisman|offensive line|cornerback|tight end|interception|punt)\b/i],
  ["basketball", /\b(nba|wnba|three-point|dunk|rebound|point guard|free throw|jump shot|final four|march madness|backboard|layup|alley-oop)\b/i],
  ["baseball", /\b(mlb|home run|pitcher|inning|world series|shortstop|strikeout|batting|outfielder|no-hitter|grand slam(?! title)|fastball|bullpen|rbi)\b/i],
  ["soccer", /\b(fifa|premier league|world cup|goalkeeper|midfielder|striker|la liga|champions league|penalty kick|offside|serie a|bundesliga|mls)\b/i],
  ["hockey", /\b(nhl|stanley cup|puck|goalie|hat trick|slapshot|power play|blue line|zamboni|defenseman)\b/i],
  ["tennis", /\b(wimbledon|us open(?!.*golf)|french open|australian open|grand slam title|baseline|tiebreak|atp|wta|serve-and-volley|doubles)\b/i],
  ["golf", /\b(pga|masters|birdie|bogey|fairway|putt|tee shot|ryder cup|british open|augusta|major championship)\b/i],
  ["olympics", /\b(olympic|gold medal|track and field|swimmer|gymnast|sprinter|marathon|decathlon|figure skat)\b/i],
  ["combat", /\b(ufc|boxing|heavyweight|knockout|wrestlemania|wwe|mma|middleweight|wrestler)\b/i],
  ["racing", /\b(nascar|formula one|formula 1|grand prix|indy 500|daytona|pit stop|pole position)\b/i],
];

function tag(q) {
  const text = `${q.question} ${q.answer}`;
  const scores = RULES.map(([name, re]) => {
    const matches = text.match(new RegExp(re.source, "gi")) || [];
    return [name, matches.length];
  }).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return scores.length ? scores[0][0] : "other";
}

for (const file of ["questions.json", "original-sports.json"]) {
  const p = path.join(__dirname, "..", "data", file);
  let qs;
  try { qs = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
  const counts = {};
  for (const q of qs) {
    if (q.subcategory === "Sports" && !q.sport) q.sport = tag(q);
    if (q.sport) counts[q.sport] = (counts[q.sport] || 0) + 1;
  }
  writeFileSync(p, JSON.stringify(qs, null, 1));
  console.log(file, counts);
}
