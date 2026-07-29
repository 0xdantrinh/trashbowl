// Verifies correct-answer scoring: 15 in power, 10 after. Requires TB_DEBUG server.
import { spawn } from "child_process";
import WebSocket from "ws";
import assert from "assert";

const server = spawn("node", ["server.js"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, PORT: "3124", TB_DEBUG: "1" },
});
let out = "";
server.stdout.on("data", (d) => (out += d));
await new Promise((r) => { const iv = setInterval(() => out.includes("running") && (clearInterval(iv), r()), 100); });

const ws = new WebSocket("ws://localhost:3124");
const msgs = [];
ws.on("message", (raw) => msgs.push(JSON.parse(raw)));
await new Promise((r) => ws.on("open", r));
ws.send(JSON.stringify({ type: "join", room: "scoretest", name: "solo" }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const m = msgs.find(pred);
    if (m) return m;
    await wait(40);
  }
  throw new Error("timeout");
}
await until((m) => m.type === "joined");
ws.send(JSON.stringify({ type: "settings", speed: 60 }));

// Test 1: buzz early (in power if powerIndex exists) with correct answer
msgs.length = 0;
ws.send(JSON.stringify({ type: "next" }));
const qs = await until((m) => m.type === "question_start");
await until((m) => m.type === "word" && m.i >= 2);
ws.send(JSON.stringify({ type: "buzz" }));
await until((m) => m.type === "buzz");
ws.send(JSON.stringify({ type: "answer", text: qs.debugAnswer.split(/[\[\(]/)[0] }));
const j = await until((m) => m.type === "judged");
assert(j.correct, `correct answer accepted (gave "${qs.debugAnswer}")`);
const expected = qs.powerIndex >= 0 ? 15 : 10;
assert(j.points === expected, `early buzz points: got ${j.points}, powerIndex=${qs.powerIndex}`);
console.log(`✓ early correct buzz scored ${j.points}${j.power ? " (power)" : ""}`);

// Test 2: buzz after reading done → 10
msgs.length = 0;
ws.send(JSON.stringify({ type: "next" }));
const qs2 = await until((m) => m.type === "question_start");
await until((m) => m.type === "reading_done", 90000);
ws.send(JSON.stringify({ type: "buzz" }));
await until((m) => m.type === "buzz");
ws.send(JSON.stringify({ type: "answer", text: qs2.debugAnswer.split(/[\[\(]/)[0] }));
const j2 = await until((m) => m.type === "judged");
assert(j2.correct && j2.points === 10, `late buzz = 10, got ${j2.points} correct=${j2.correct} ans="${qs2.debugAnswer}"`);
console.log("✓ post-power correct buzz scored 10");

const sync = [...msgs].reverse().find((m) => m.type === "sync");
console.log("✓ final score:", sync.players[0].score);
console.log("\nSCORING TESTS PASSED");
ws.close(); server.kill(); process.exit(0);
