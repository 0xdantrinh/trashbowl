// TrashBowl — Protobowl-style realtime quizbowl server (Trash & Sports)
import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { judgeGuess } from "./lib/answer-check.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const VERSION = 4; // bumped when the client/server protocol changes

// ---------- Question bank ----------
function loadQuestions() {
  const files = ["data/questions.json", "data/original-sports.json", "data/ai-sports.json", "data/quizbowlpackets-sports.json"];
  let all = [];
  for (const f of files) {
    const p = path.join(__dirname, f);
    if (existsSync(p)) all = all.concat(JSON.parse(readFileSync(p, "utf8")));
  }
  // Sports-only for now — the rest of the Trash bank stays on disk for later
  all = all.filter((q) => q.subcategory === "Sports");
  for (const q of all) {
    q.words = q.question.split(/\s+/).filter(Boolean);
    q.powerIndex = q.words.findIndex((w) => w.includes("(*)"));
    if (!q.level) q.level = "College";
  }
  return all;
}
const QUESTIONS = loadQuestions();
const QBYID = new Map(QUESTIONS.map((q) => [q.id, q]));
const SUBCATS = [...new Set(QUESTIONS.map((q) => q.subcategory))].sort();
const SPORTS = [...new Set(QUESTIONS.filter((q) => q.sport).map((q) => q.sport))].sort();
const LEVELS = ["College", "High School", "Middle School"].filter((l) => QUESTIONS.some((q) => q.level === l));
console.log(`Loaded ${QUESTIONS.length} sports questions`, { sports: SPORTS.length, levels: LEVELS });

// ---------- Rooms ----------
const rooms = new Map();

const DEFAULTS = {
  speed: 135,          // ms per word
  answerTime: 8000,    // ms to answer after buzzing
  deadTime: 6000,      // ms after reading completes before question is dead
};

// How long an empty room (score, current question, settings) stays in memory
// after the last player disconnects, e.g. by switching to a different room.
const ROOM_EMPTY_GRACE_MS = 3 * 60 * 60 * 1000; // 3 hours

function makeRoom(name) {
  return {
    name,
    players: new Map(),
    settings: {
      speed: DEFAULTS.speed,
      levels: [], sports: [],             // empty = all
      allowMultiBuzz: true,
      allowSkip: true,
      allowPause: true,
    },
    state: "idle",        // idle | reading | buzzed | done
    paused: false,
    q: null,
    wordIndex: 0,
    readBase: 0,          // wordIndex when reading last (re)started
    readStartAt: null,    // timestamp of last (re)start; null when not ticking
    buzzer: null,
    buzzDeadline: 0,      // when the current buzzer's answer window ends
    promptCount: 0,       // prompts issued on the current buzz (capped)
    pendingGuess: "",     // live keystrokes from the buzzer — used if their time runs out before they hit Enter
    autoPaused: false,    // paused by the system (empty room), not a player
    lockedOut: new Set(),
    readTimer: null,
    answerTimer: null,
    deadTimer: null,
    deadDeadline: 0,      // for pausing during dead-time
    deadRemaining: 0,
    seen: new Set(),
    qNumber: 0,
    emptyTimer: null,   // pending deletion once everyone's been gone a while
    history: [],        // chat/buzz/question feed items, newest first — replayed to (re)joining clients
  };
}

const HISTORY_LIMIT = 600; // matches the client's own feed cap

function pushHistory(room, item) {
  room.history.unshift(item);
  if (room.history.length > HISTORY_LIMIT) room.history.length = HISTORY_LIMIT;
}

// every player-facing chat/system line goes through here so it's both
// broadcast live and recorded for players who join/reconnect afterward
function broadcastChat(room, msg) {
  broadcast(room, { type: "chat", ...msg });
  pushHistory(room, msg.system
    ? { kind: "system", text: msg.text }
    : { kind: "chat", player: msg.player, playerId: msg.playerId, text: msg.text });
}

function getRoom(name) {
  if (!rooms.has(name)) rooms.set(name, makeRoom(name));
  return rooms.get(name);
}

// A player can have several live sockets (multiple tabs sharing one
// clientKey); every one of them gets every broadcast. A tab that isn't the
// most recent joiner must still see the game, or its clicks look dead.
function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values())
    for (const ws of p.sockets)
      if (ws.readyState === 1) ws.send(data);
}

function sendToPlayer(player, msg) {
  const data = JSON.stringify(msg);
  for (const ws of player.sockets) if (ws.readyState === 1) ws.send(data);
}

// Names are unique per room (case-insensitive): a second "John Madden"
// becomes "John Madden 2". selfId exempts the player from their own name.
function uniqueName(room, desired, selfId) {
  const base = desired.slice(0, 28).trim() || "player";
  const taken = (nm) => [...room.players.values()]
    .some((p) => p.id !== selfId && p.name.toLowerCase() === nm.toLowerCase());
  let name = base;
  for (let n = 2; taken(name); n++) name = `${base} ${n}`;
  return name;
}

function statPack(p) {
  return {
    id: p.id, name: p.name, score: p.score, online: p.online,
    correct: p.correct, correctStreak: p.correctStreak, correctBest: p.correctBest,
    interrupts: p.interrupts, interruptStreak: p.interruptStreak, interruptBest: p.interruptBest,
    seen: p.seen,
  };
}

function syncState(room) {
  broadcast(room, {
    type: "sync",
    state: room.state,
    paused: room.paused,
    players: [...room.players.values()].map(statPack),
    settings: room.settings,
    qNumber: room.qNumber,
    buzzer: room.buzzer ? room.players.get(room.buzzer)?.name : null,
    buzzerId: room.buzzer,
    buzzRemainMs: room.buzzDeadline ? Math.max(0, room.buzzDeadline - Date.now()) : 0,
  });
}

// ---------- Game flow ----------
function pickQuestion(room) {
  let pool = QUESTIONS.filter((q) => !room.seen.has(q.id));
  if (room.settings.levels.length)
    pool = pool.filter((q) => room.settings.levels.includes(q.level));
  if (room.settings.sports.length)
    pool = pool.filter((q) => room.settings.sports.includes(q.sport));
  if (!pool.length) { room.seen.clear(); return pickQuestion(room); }
  return pool[Math.floor(Math.random() * pool.length)];
}

function clearTimers(room) {
  for (const t of ["readTimer", "answerTimer", "deadTimer"]) {
    if (room[t]) { clearTimeout(room[t]); clearInterval(room[t]); room[t] = null; }
  }
}

function startQuestion(room) {
  clearTimers(room);
  const q = pickQuestion(room);
  room.seen.add(q.id);
  room.q = q;
  room.qNumber++;
  room.state = "reading";
  room.paused = false;
  room.wordIndex = 0;
  room.buzzer = null;
  room.lockedOut = new Set();
  for (const p of room.players.values()) if (p.online) p.seen++;
  broadcast(room, {
    type: "question_start",
    qNumber: room.qNumber,
    qid: q.id,
    words: q.words,
    revealed: 0,
    total: q.words.length,
    category: q.category,
    subcategory: q.subcategory,
    sport: q.sport || null,
    level: q.level,
    set: q.set,
    packet: q.packet,
    powerIndex: q.powerIndex,
    speed: room.settings.speed,
    deadTime: DEFAULTS.deadTime,
    ...(process.env.TB_DEBUG ? { debugAnswer: q.answer } : {}),
  });
  syncState(room);
  startReading(room);
}

function armDeadTimer(room, ms) {
  room.deadDeadline = Date.now() + ms;
  room.deadTimer = setTimeout(() => finishQuestion(room, null), ms);
}

// Reading is clock-based, not streamed: clients get the full word list up
// front plus a "reading" message ({from, elapsed, speed}) and reveal words on
// their own clock, so word display stays smooth regardless of network jitter.
// The server keeps the authoritative position via readBase/readStartAt and
// computes it on demand (at buzz/pause time) instead of ticking per word.
function currentWordIndex(room) {
  if (!room.q) return room.wordIndex;
  if (room.readStartAt == null) return room.wordIndex;
  const elapsed = Date.now() - room.readStartAt;
  return Math.min(room.q.words.length, room.readBase + Math.floor(elapsed / room.settings.speed));
}

function startReading(room) {
  if (room.readTimer) { clearTimeout(room.readTimer); room.readTimer = null; }
  room.readBase = room.wordIndex;
  room.readStartAt = Date.now();
  broadcast(room, { type: "reading", from: room.readBase, elapsed: 0, speed: room.settings.speed });
  const remaining = room.q.words.length - room.wordIndex;
  room.readTimer = setTimeout(() => {
    room.readTimer = null;
    room.wordIndex = room.q.words.length;
    room.readStartAt = null;
    armDeadTimer(room, DEFAULTS.deadTime);
    broadcast(room, { type: "reading_done" });
  }, remaining * room.settings.speed);
}

function buzz(room, player) {
  if (room.state !== "reading" || room.paused) return;
  if (room.lockedOut.has(player.id)) return;
  room.wordIndex = currentWordIndex(room);
  room.readStartAt = null;
  room.state = "buzzed";
  room.buzzer = player.id;
  room.promptCount = 0;
  room.pendingGuess = "";
  if (room.readTimer) { clearTimeout(room.readTimer); room.readTimer = null; }
  if (room.deadTimer) { clearTimeout(room.deadTimer); room.deadTimer = null; }
  broadcast(room, {
    type: "buzz", player: player.name, playerId: player.id,
    wordIndex: room.wordIndex, answerTime: DEFAULTS.answerTime,
  });
  room.buzzDeadline = Date.now() + DEFAULTS.answerTime;
  room.answerTimer = setTimeout(() => judgeAnswer(room, player, room.pendingGuess), DEFAULTS.answerTime);
}

function judgeAnswer(room, player, guess) {
  if (room.state !== "buzzed" || room.buzzer !== player.id) return;
  clearTimeout(room.answerTimer); room.answerTimer = null;
  room.buzzDeadline = 0;
  const q = room.q;
  let result = judgeGuess(guess, q.answer, q.answerDisplay); // "correct" | "prompt" | "incorrect"
  // like a live moderator, prompt at most twice per buzz — a third
  // still-too-vague answer is ruled wrong instead of stalling the room
  if (result === "prompt" && room.promptCount >= 2) result = "incorrect";
  const interrupted = room.wordIndex < q.words.length;
  const inPower = q.powerIndex >= 0 && room.wordIndex <= q.powerIndex;

  if (result === "correct") {
    const pts = inPower ? 15 : 10;
    player.score += pts;
    player.correct++;
    player.correctStreak++;
    player.correctBest = Math.max(player.correctBest, player.correctStreak);
    player.interruptStreak = 0;
    broadcast(room, {
      type: "judged", verdict: "correct", correct: true, player: player.name, playerId: player.id,
      guess, points: pts, power: inPower, interrupted, wordIndex: room.wordIndex,
    });
    pushHistory(room, { kind: "buzz", player: player.name, playerId: player.id, guess, verdict: "correct" });
    finishQuestion(room, player.id);
  } else if (result === "prompt") {
    // needs more — buzzer stays with this player, no points/penalty either way
    room.promptCount++;
    broadcast(room, {
      type: "judged", verdict: "prompt", correct: false, player: player.name, playerId: player.id,
      guess, points: 0, power: false, interrupted, wordIndex: room.wordIndex, answerTime: DEFAULTS.answerTime,
    });
    room.buzzDeadline = Date.now() + DEFAULTS.answerTime;
    room.answerTimer = setTimeout(() => judgeAnswer(room, player, room.pendingGuess), DEFAULTS.answerTime);
  } else {
    const pts = interrupted ? -5 : 0;
    player.score += pts;
    if (interrupted) {
      player.interrupts++;
      player.interruptStreak++;
      player.interruptBest = Math.max(player.interruptBest, player.interruptStreak);
    }
    player.correctStreak = 0;
    if (!room.settings.allowMultiBuzz) room.lockedOut.add(player.id);
    broadcast(room, {
      type: "judged", verdict: "incorrect", correct: false, player: player.name, playerId: player.id,
      guess, points: pts, power: false, interrupted, wordIndex: room.wordIndex,
    });
    pushHistory(room, { kind: "buzz", player: player.name, playerId: player.id, guess, verdict: "wrong" });
    room.buzzer = null;
    const active = [...room.players.values()].filter((p) => p.online);
    if (!room.settings.allowMultiBuzz && active.length &&
        active.every((p) => room.lockedOut.has(p.id))) {
      finishQuestion(room, null);
      return;
    }
    room.state = "reading";
    syncState(room);
    if (room.wordIndex >= q.words.length) armDeadTimer(room, DEFAULTS.deadTime);
    else startReading(room);
  }
}

function finishQuestion(room, winnerId) {
  clearTimers(room);
  room.state = "done";
  room.paused = false;
  room.buzzer = null;
  broadcast(room, {
    type: "question_end",
    qid: room.q.id,
    answer: room.q.answerDisplay || room.q.answer,
    answerText: room.q.answer,
    fullQuestion: room.q.question,
    winner: winnerId ? room.players.get(winnerId)?.name : null,
    set: room.q.set,
    packet: room.q.packet,
    category: room.q.category,
    subcategory: room.q.subcategory,
    sport: room.q.sport || null,
    level: room.q.level,
  });
  pushHistory(room, {
    kind: "question",
    qid: room.q.id,
    set: room.q.set,
    packet: room.q.packet,
    category: room.q.category,
    subcategory: room.q.subcategory,
    sport: room.q.sport || null,
    level: room.q.level,
    answer: room.q.answerDisplay || room.q.answer,
    question: room.q.question,
  });
  syncState(room);
}

// freezes the reading clock: folds the current position into wordIndex,
// stops the completion timer, and banks any remaining dead time
function haltReadingClock(room) {
  room.wordIndex = currentWordIndex(room);
  room.readStartAt = null;
  if (room.readTimer) { clearTimeout(room.readTimer); room.readTimer = null; }
  if (room.deadTimer) {
    clearTimeout(room.deadTimer);
    room.deadTimer = null;
    room.deadRemaining = Math.max(0, room.deadDeadline - Date.now());
  } else {
    room.deadRemaining = 0;
  }
}

function pauseGame(room, player) {
  if (!room.settings.allowPause) return;
  if (room.state !== "reading" || room.paused) return;
  room.paused = true;
  room.autoPaused = false; // a deliberate pause — don't auto-resume on join
  room.pausedAt = Date.now();
  haltReadingClock(room);
  broadcast(room, { type: "paused", player: player.name, wordIndex: room.wordIndex });
  syncState(room);
}

function resumeGame(room, player) {
  if (room.state !== "reading" || !room.paused) return;
  room.paused = false;
  room.autoPaused = false;
  const secs = Math.round((Date.now() - room.pausedAt) / 1000);
  broadcast(room, { type: "resumed", player: player.name, pausedFor: secs });
  if (room.wordIndex >= room.q.words.length) armDeadTimer(room, room.deadRemaining || DEFAULTS.deadTime);
  else startReading(room);
  syncState(room);
}

// Silently pauses an in-progress question when the last player disconnects,
// so the room's score/question/settings survive them switching lobbies —
// distinct from pauseGame(), which is the user-facing button and can be
// disabled by room settings; this system-level halt always applies.
function haltForEmpty(room) {
  if (room.state !== "reading" || room.paused) return;
  room.paused = true;
  room.autoPaused = true;
  room.pausedAt = Date.now();
  haltReadingClock(room);
  // no broadcast — nobody is connected to see it; the join handler
  // auto-resumes from the frozen wordIndex when someone comes back.
}

// ---------- HTTP + WS ----------
const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/stats", (_req, res) => {
  res.json({
    version: VERSION,
    questions: QUESTIONS.length,
    subcategories: SUBCATS,
    sports: SPORTS,
    levels: LEVELS,
    rooms: [...rooms.values()]
      .map((r) => ({ name: r.name, players: [...r.players.values()].filter((p) => p.online).length }))
      .filter((r) => r.players > 0),
  });
});

app.get("/api/search", (req, res) => {
  const q = String(req.query.q || "").toLowerCase().trim();
  if (q.length < 2) return res.json({ results: [] });
  const results = [];
  for (const question of QUESTIONS) {
    if (question.answer.toLowerCase().includes(q) || question.question.toLowerCase().includes(q)) {
      results.push({
        qid: question.id,
        set: question.set, packet: question.packet,
        category: question.category, subcategory: question.subcategory,
        sport: question.sport || null, level: question.level,
        answer: question.answerDisplay || question.answer,
        question: question.question,
      });
      if (results.length >= 30) break;
    }
  }
  res.json({ results });
});

app.get("/api/question/:id", (req, res) => {
  const q = QBYID.get(req.params.id);
  if (!q) return res.status(404).json({ error: "not found" });
  res.json({
    qid: q.id, set: q.set, packet: q.packet, category: q.category,
    subcategory: q.subcategory, sport: q.sport || null, level: q.level,
    answer: q.answerDisplay || q.answer, question: q.question,
  });
});

// room URLs like protobowl.com/roomname
app.get("/:room([\\w-]+)", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

// Heartbeat: hosting proxies (e.g. Render's) silently drop WebSocket
// connections they consider idle. Ping every 30s so the connection always has
// traffic, and terminate peers that stop answering so their player row goes
// offline promptly instead of lingering until a failed send.
const HEARTBEAT_MS = 30000;
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on("close", () => clearInterval(heartbeat));

let nextId = 1;
wss.on("connection", (ws) => {
  let room = null;
  let player = null;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    ws.isAlive = true;

    // app-level keepalive from the client (belt to the ws-ping suspenders —
    // some proxies only count client-initiated traffic)
    if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }

    if (msg.type === "join") {
      const roomName = String(msg.room || "lobby").slice(0, 32).replace(/[^\w-]/g, "") || "lobby";
      const name = String(msg.name || "player").slice(0, 32).trim() || "player";
      room = getRoom(roomName);
      if (room.emptyTimer) { clearTimeout(room.emptyTimer); room.emptyTimer = null; }
      const existing = msg.clientKey && [...room.players.values()].find((p) => p.clientKey === msg.clientKey);
      const firstSocket = !existing || existing.sockets.size === 0;
      if (existing) {
        player = existing;
      } else {
        player = {
          id: String(nextId++), clientKey: msg.clientKey || null, name,
          sockets: new Set(),
          score: 0, correct: 0, correctStreak: 0, correctBest: 0,
          interrupts: 0, interruptStreak: 0, interruptBest: 0,
          seen: 0, online: true,
        };
        room.players.set(player.id, player);
      }
      player.name = uniqueName(room, name, player.id);
      player.sockets.add(ws);
      player.online = true;
      // the system paused this room when it emptied out — pick the game back
      // up automatically now that someone is here, instead of ambushing them
      // with a paused room where buzzing silently does nothing
      if (room.autoPaused && room.paused && room.state === "reading") {
        room.autoPaused = false;
        room.paused = false;
        broadcast(room, { type: "resumed", player: player.name, pausedFor: Math.round((Date.now() - room.pausedAt) / 1000) });
        if (room.wordIndex >= room.q.words.length) armDeadTimer(room, room.deadRemaining || DEFAULTS.deadTime);
        else startReading(room);
      }
      ws.send(JSON.stringify({
        type: "joined", playerId: player.id, name: player.name, room: room.name, version: VERSION,
        subcategories: SUBCATS, sports: SPORTS, levels: LEVELS,
        settings: room.settings,
        questionCount: QUESTIONS.length,
      }));
      ws.send(JSON.stringify({ type: "history", items: room.history }));
      if (room.q && room.state !== "idle") {
        ws.send(JSON.stringify({
          type: "question_start", qNumber: room.qNumber, qid: room.q.id,
          words: room.q.words,
          revealed: currentWordIndex(room),
          total: room.q.words.length,
          category: room.q.category, subcategory: room.q.subcategory,
          sport: room.q.sport || null, level: room.q.level,
          set: room.q.set, packet: room.q.packet,
          powerIndex: room.q.powerIndex, speed: room.settings.speed,
          deadTime: DEFAULTS.deadTime,
          paused: room.paused,
        }));
        // mid-read rejoin: hand them the live reading clock so they tick along
        if (room.state === "reading" && !room.paused && room.readStartAt != null) {
          ws.send(JSON.stringify({
            type: "reading", from: room.readBase,
            elapsed: Date.now() - room.readStartAt,
            speed: room.settings.speed,
          }));
        }
        if (room.state === "done") {
          ws.send(JSON.stringify({
            type: "question_end", qid: room.q.id,
            answer: room.q.answerDisplay || room.q.answer,
            answerText: room.q.answer,
            fullQuestion: room.q.question, winner: null,
            set: room.q.set, packet: room.q.packet,
            category: room.q.category, subcategory: room.q.subcategory,
            sport: room.q.sport || null, level: room.q.level,
          }));
        }
      }
      // announce only the first tab/socket — a second tab or a quick
      // reconnect shouldn't spam "joined the room" at everyone
      if (firstSocket) broadcastChat(room, { system: true, text: `${player.name} joined the room` });
      syncState(room);
      return;
    }

    if (!room || !player) return;

    switch (msg.type) {
      case "next":
        if (room.state === "idle" || room.state === "done") startQuestion(room);
        break;
      case "skip":
        if (room.settings.allowSkip && room.state === "reading" && !room.paused) {
          broadcastChat(room, { system: true, text: `${player.name} skipped the question` });
          finishQuestion(room, null);
        }
        break;
      case "pause": pauseGame(room, player); break;
      case "resume": resumeGame(room, player); break;
      case "buzz": buzz(room, player); break;
      case "answer":
        judgeAnswer(room, player, String(msg.text || "").slice(0, 200));
        break;
      case "typing": {
        // live keystroke broadcast (guess while buzzed, or chat)
        const kind = msg.kind === "guess" ? "guess" : "chat";
        if (kind === "guess" && room.buzzer !== player.id) break;
        const text = String(msg.text || "").slice(0, 200);
        // keep the buzzer's latest keystrokes so a timeout can submit
        // whatever they'd typed instead of an empty guess
        if (kind === "guess") room.pendingGuess = text;
        broadcast(room, {
          type: "typing", kind, player: player.name, playerId: player.id,
          text,
        });
        break;
      }
      case "chat": {
        const text = String(msg.text || "").slice(0, 400).trim();
        if (text) broadcastChat(room, { player: player.name, playerId: player.id, text });
        break;
      }
      case "settings": {
        const s = room.settings;
        if (Array.isArray(msg.levels)) s.levels = msg.levels.filter((x) => LEVELS.includes(x));
        if (Array.isArray(msg.sports)) s.sports = msg.sports.filter((x) => SPORTS.includes(x));
        const oldSpeed = s.speed;
        if (typeof msg.speed === "number") s.speed = Math.min(400, Math.max(60, msg.speed));
        for (const k of ["allowMultiBuzz", "allowSkip", "allowPause"])
          if (typeof msg[k] === "boolean") s[k] = msg[k];
        // speed changed mid-read: fold position at the old cadence and restart
        // the clock so every client re-syncs at the new one
        if (s.speed !== oldSpeed && room.state === "reading" && !room.paused && room.readStartAt != null) {
          const elapsed = Date.now() - room.readStartAt;
          room.wordIndex = Math.min(room.q.words.length, room.readBase + Math.floor(elapsed / oldSpeed));
          startReading(room);
        }
        syncState(room);
        break;
      }
      case "rename": {
        const wanted = String(msg.name || "").slice(0, 32).trim();
        if (!wanted) break;
        const name = uniqueName(room, wanted, player.id);
        if (name !== player.name) {
          broadcastChat(room, { system: true, text: `${player.name} is now known as ${name}` });
          player.name = name;
          syncState(room);
        }
        // always confirm the authoritative name (it may have been suffixed)
        sendToPlayer(player, { type: "renamed", name: player.name });
        break;
      }
      case "reset_score": {
        Object.assign(player, {
          score: 0, correct: 0, correctStreak: 0, correctBest: 0,
          interrupts: 0, interruptStreak: 0, interruptBest: 0, seen: 0,
        });
        broadcastChat(room, { system: true, text: `${player.name} reset their score` });
        syncState(room);
        break;
      }
    }
  });

  ws.on("close", () => {
    if (room && player) {
      player.sockets.delete(ws);
      if (player.sockets.size > 0) return; // another tab still holds this player
      player.online = false;
      if (room.state === "buzzed" && room.buzzer === player.id) judgeAnswer(room, player, "");
      broadcastChat(room, { system: true, text: `${player.name} left the room` });
      syncState(room);
      if (![...room.players.values()].some((p) => p.online)) {
        // Room is empty, but keep it (scores, current question, settings)
        // around for a while in case someone switched lobbies and comes
        // back — only the interval loops stop actively broadcasting.
        haltForEmpty(room);
        if (room.emptyTimer) clearTimeout(room.emptyTimer);
        room.emptyTimer = setTimeout(() => {
          clearTimers(room);
          rooms.delete(room.name);
        }, ROOM_EMPTY_GRACE_MS);
      }
    }
  });
});

server.listen(PORT, () => console.log(`TrashBowl running at http://localhost:${PORT}`));
