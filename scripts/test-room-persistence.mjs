// Reproduces: play in /swag, switch to another room, come back to /swag —
// score, current question, and settings should still be there (bug fix).
import { spawn } from "child_process";
import WebSocket from "ws";
import assert from "assert";

const server = spawn("node", ["server.js"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, PORT: "3125" },
});
let out = "";
server.stdout.on("data", (d) => (out += d));
await new Promise((r) => { const iv = setInterval(() => out.includes("running") && (clearInterval(iv), r()), 100); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client(clientKey) {
  const ws = new WebSocket("ws://localhost:3125");
  const c = { ws, msgs: [] };
  ws.on("message", (raw) => c.msgs.push(JSON.parse(raw)));
  return new Promise((res) => ws.on("open", () => res(c)));
}
async function until(c, pred, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const m = c.msgs.find(pred);
    if (m) return m;
    await wait(40);
  }
  throw new Error("timeout waiting for message");
}

const key = "same-browser-" + Math.random();

// --- session 1: join /swag, tweak settings, score a point, leave mid-question ---
let c1 = await client();
c1.ws.send(JSON.stringify({ type: "join", room: "swag", name: "Daniel", clientKey: key }));
await until(c1, (m) => m.type === "joined");
// allowSkip:false is the toggle under test; allowMultiBuzz stays true so a
// wrong buzz doesn't lock out our lone player and auto-finish the question
// (that's a separate, correct behavior — tested in test-e2e.mjs already).
c1.ws.send(JSON.stringify({ type: "settings", speed: 60, sports: ["football"], allowSkip: false }));
await until(c1, (m) => m.type === "sync" && m.settings.speed === 60);
c1.ws.send(JSON.stringify({ type: "next" }));
const qs = await until(c1, (m) => m.type === "question_start");
await until(c1, (m) => m.type === "word" && m.i >= 2);
c1.ws.send(JSON.stringify({ type: "buzz" }));
await until(c1, (m) => m.type === "buzz");
c1.ws.send(JSON.stringify({ type: "answer", text: "wrong on purpose, expect a neg" }));
const judged1 = await until(c1, (m) => m.type === "judged");
assert(judged1.correct === false, "sanity: guess should be wrong");
// confirm the question is genuinely still being read (not auto-finished)
await until(c1, (m) => m.type === "word" && m.i > judged1.wordIndex);
const scoreAfterNeg = -5;
c1.ws.close();
await wait(400); // let the server register the close
console.log("✓ played in /swag: settings changed, negged once, question still mid-flight");

// --- meanwhile: play a different room entirely (simulates switching lobbies) ---
let cOther = await client();
cOther.ws.send(JSON.stringify({ type: "join", room: "some-other-room", name: "Daniel", clientKey: "different-room-key" }));
await until(cOther, (m) => m.type === "joined");
cOther.ws.send(JSON.stringify({ type: "next" }));
await until(cOther, (m) => m.type === "question_start");
cOther.ws.close();
console.log("✓ visited a different room in between");

// --- session 2: come back to /swag a bit later with the same clientKey ---
await wait(500);
let c2 = await client();
c2.ws.send(JSON.stringify({ type: "join", room: "swag", name: "Daniel", clientKey: key }));
const joined2 = await until(c2, (m) => m.type === "joined");
assert(joined2.settings.speed === 60, `speed setting lost on return (got ${joined2.settings.speed})`);
assert.deepStrictEqual(joined2.settings.sports, ["football"], "sport filter lost on return");
assert(joined2.settings.allowSkip === false, "allowSkip setting lost on return");
console.log("✓ room settings survived leaving and coming back");

const qstart2 = await until(c2, (m) => m.type === "question_start");
assert(qstart2.qid === qs.qid, "same in-progress question should still be there on return");
assert(qstart2.paused === true, "question should be auto-paused while the room was empty");
console.log("✓ same question still in progress, and marked paused");

const sync2 = await until(c2, (m) => m.type === "sync");
const me = sync2.players.find((p) => p.name === "Daniel");
assert(me.score === scoreAfterNeg, `score lost on return (got ${me?.score}, expected ${scoreAfterNeg})`);
assert(me.interrupts === 1, "interrupt count lost on return");
console.log("✓ score and stats survived leaving and coming back");

// resume and confirm the question is still playable (re-enable skip first,
// since we intentionally left the room with allowSkip:false)
c2.ws.send(JSON.stringify({ type: "resume" }));
await until(c2, (m) => m.type === "resumed");
c2.ws.send(JSON.stringify({ type: "settings", allowSkip: true }));
await until(c2, (m) => m.type === "sync" && m.settings.allowSkip === true);
c2.ws.send(JSON.stringify({ type: "skip" }));
await until(c2, (m) => m.type === "question_end");
console.log("✓ resumed question is still playable after returning");

console.log("\nALL ROOM-PERSISTENCE TESTS PASSED");
c2.ws.close();
server.kill();
process.exit(0);
