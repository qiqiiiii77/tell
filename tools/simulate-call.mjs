#!/usr/bin/env node
/**
 * simulate-call.mjs — the whole product, end to end, without a microphone.
 *
 * Synthesises a patient with macOS `say` (including real silences), then streams
 * that audio to BOTH AssemblyAI sockets at once, exactly as the browser does:
 *
 *   24 kHz -> Voice Agent API   (the conversation + tool calls)
 *   16 kHz -> Streaming STT v3  (word timings + per-word confidence)
 *
 * Tool calls are resolved by the real gate from public/js/gate.js — no mocks.
 * Run it and you see the agent refuse to record a hesitant "yes", ask a
 * follow-up it chose from the signal, and record the disclosure that follows.
 *
 *   node tools/simulate-call.mjs
 *   node tools/simulate-call.mjs --honest     (patient answers cleanly instead)
 *
 * Requires macOS for `say`/`afconvert`. Pre-rendered WAVs in samples/audio/ are
 * used when present, so the simulation is reproducible on any platform.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { PatientBaseline, certaintyForTurn, gateDecision, refusalMessage } from "../public/js/gate.js";
import { downsample, detectPitch } from "../public/js/dsp.js";
import { arousalFromFrames } from "../public/js/acoustics.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const AUDIO_DIR = join(ROOT, "samples", "audio");

const AGENT_RATE = 24000;
const STT_RATE = 16000;
const CHUNK_MS = 20;
const TAIL_SILENCE_MS = 1300; // both APIs need trailing silence to close a turn

const HONEST = process.argv.includes("--honest");

const C = {
  dim: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", r: "\x1b[31m",
  y: "\x1b[33m", c: "\x1b[36m", m: "\x1b[35m", x: "\x1b[0m",
};

/* ------------------------------------------------------------------ *
 * The scripted patient
 * ------------------------------------------------------------------ */

const SCRIPT = HONEST
  ? [
      { id: "consent", say: "Yes, now is fine.", reactionMs: 400, waitFor: /okay time|good time|minute|talk/i },
      { id: "adherence", say: "Yes, I took every dose this week.", reactionMs: 450,
        waitFor: /prescribed|taking (it|them|the|your)|every dose/i },
      { id: "sideeffects", say: "No, no side effects at all.", reactionMs: 420, waitFor: /side effect|noticed any/i },
    ]
  : [
      { id: "consent", say: "Yeah, sure, now is fine.", reactionMs: 420,
        waitFor: /okay time|good time|minute|talk/i },
      // The whole product exists for this line: a "yes" with a 900 ms hole in it.
      { id: "adherence", say: "Uh [[slnc 900]] yeah, yeah, I've been taking them.", reactionMs: 1900,
        waitFor: /prescribed|taking (it|them|the|your)|every dose/i },
      { id: "disclosure", say: "Okay, honestly, I missed Tuesday and Wednesday. I was away from home.", reactionMs: 500,
        waitFor: /which|what day|how many|walk me|day at a time|missed/i },
      { id: "sideeffects", say: "No, nothing like that.", reactionMs: 430,
        waitFor: /side effect|noticed any/i },
    ];

/* ------------------------------------------------------------------ *
 * Audio
 * ------------------------------------------------------------------ */

function renderUtterance(id, text) {
  mkdirSync(AUDIO_DIR, { recursive: true });
  const wav = join(AUDIO_DIR, `${id}.wav`);
  if (existsSync(wav)) return wav;
  const aiff = join(AUDIO_DIR, `${id}.aiff`);
  execFileSync("say", ["-v", "Samantha", "-o", aiff, text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${AGENT_RATE}`, "-c", "1", aiff, wav]);
  return wav;
}

/** Minimal WAV reader: finds the data chunk and returns Int16 samples. */
function readWavPCM16(path) {
  const buf = readFileSync(path);
  let off = 12; // past "RIFF....WAVE"
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      const bytes = buf.subarray(off + 8, off + 8 + size);
      const out = new Int16Array(bytes.length >> 1);
      for (let i = 0; i < out.length; i++) out[i] = bytes.readInt16LE(i * 2);
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${path}`);
}

const i16ToF32 = (i16) => {
  const f = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
  return f;
};
const f32ToI16 = (f32) => {
  const o = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    o[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return o;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How much audio we have streamed, in ms. This is the clock both APIs use. */
const audioMs = () => (state.sentSamples / AGENT_RATE) * 1000;

/**
 * Streaming v3 rejects frames outside 50–1000 ms (error 3007, socket closed).
 * Our 20 ms chunks have to be accumulated first — the same buffering the
 * browser client does in public/js/stt.js.
 */
const STT_FLUSH = STT_RATE / 10; // 100 ms
let sttBuf = new Int16Array(STT_FLUSH * 2);
let sttLen = 0;
function sttSend(ws, i16) {
  let read = 0;
  while (read < i16.length) {
    const take = Math.min(sttBuf.length - sttLen, i16.length - read);
    sttBuf.set(i16.subarray(read, read + take), sttLen);
    sttLen += take; read += take;
    while (sttLen >= STT_FLUSH) {
      const frame = sttBuf.slice(0, STT_FLUSH);
      if (ws.readyState === WebSocket.OPEN) ws.send(frame.buffer);
      sttBuf.copyWithin(0, STT_FLUSH, sttLen);
      sttLen -= STT_FLUSH;
    }
  }
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const env = readFileSync(join(ROOT, ".env"), "utf8");
const KEY = (env.match(/ASSEMBLYAI_API_KEY\s*=\s*([A-Za-z0-9]{32})/) || [])[1];
if (!KEY) { console.error("No ASSEMBLYAI_API_KEY in .env"); process.exit(1); }

const state = {
  baseline: new PatientBaseline(),
  words: [],
  seen: new Set(),
  userStoppedAt: null,
  userStartAudioMs: null,
  userStopAudioMs: null,
  sentSamples: 0,
  askedAdherence: false,
  gatedStopAt: null,
  attempts: new Map(),
  facts: [],
  gateEvents: [],
  agentEndedAt: null,
  userStartedAt: null,
  sttEpoch: 0,
  micEpoch: 0,
  frames: [],
  transcript: [],
};

/* ------------------------------------------------------------------ *
 * Streaming STT
 * ------------------------------------------------------------------ */

async function mintToken(url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  return (await r.json()).token;
}

async function connectStt() {
  const token = await mintToken("https://streaming.assemblyai.com/v3/token?expires_in_seconds=120");
  const params = new URLSearchParams({
    sample_rate: String(STT_RATE), encoding: "pcm_s16le",
    speech_model: "universal-3-5-pro", language_code: "en",
    format_turns: "false", token,
  });
  const ws = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${params}`);
  ws.binaryType = "arraybuffer";

  await new Promise((res, rej) => {
    ws.addEventListener("open", () => { state.sttEpoch = performance.now(); res(); });
    ws.addEventListener("error", rej);
  });

  ws.addEventListener("message", (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "Error") { console.error(`${C.r}[stt] ${msg.error}${C.x}`); return; }
    if (msg.type !== "Turn" || !msg.end_of_turn) return;

    let added = 0;
    for (const w of msg.words || []) {
      const key = `${w.start}|${w.text}`;
      if (state.seen.has(key)) continue;
      state.seen.add(key);
      state.words.push({
        text: w.text, start: w.start, end: w.end,
        confidence: typeof w.confidence === "number" ? w.confidence : null,
      });
      added++;
    }
    if (!added) return;
    state.words.sort((a, b) => a.start - b.start);
  });

  return ws;
}

/**
 * Same as public/js/app.js: turn boundaries come from the Voice Agent API,
 * words come from Streaming v3, and pauses v3 treated as turn ends are stitched
 * back together — they are the evidence, not a delimiter.
 */
async function captureUserTurn(timeoutMs) {
  if (state.userStartAudioMs === null) return null;
  // Window in AUDIO time (how much audio the socket has received), not wall
  // time. Streaming v3 timestamps everything against the audio it has been
  // given, so the two only agree while the line is continuously open.
  const from = state.userStartAudioMs - 250;
  const to = (state.userStopAudioMs ?? audioMs()) + 250;

  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const last = state.words[state.words.length - 1];
    if (last && last.end >= to - 500) break;
    await sleep(100);
  }

  const words = state.words.filter((w) => w.end >= from && w.start <= to);
  if (!words.length) return null;

  const t0 = words[0].start;
  console.log(`${C.dim}   [stt] ${words.length} words: "${words.map((w) => w.text).join(" ")}"${C.x}`);

  return {
    words: words.map((w) => ({ ...w, start: w.start - t0, end: w.end - t0 })),
    onsetMs: state.userStartedAt !== null && state.agentEndedAt !== null
      ? Math.max(0, state.userStartedAt - state.agentEndedAt) : null,
    // Frames share the audio clock, so no rebasing is needed here.
    arousal: arousalFromFrames(
      state.frames.filter((f) => f.tMs >= words[0].start && f.tMs <= words[words.length - 1].end)
    ),
  };
}

/* ------------------------------------------------------------------ *
 * Voice Agent
 * ------------------------------------------------------------------ */

function agentConfig() {
  const raw = readFileSync(join(ROOT, "agent", "tell.jsonc"), "utf8");
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
}

async function resolveTool(call) {
  const { name, arguments: args } = call;
  console.log(`${C.m}   [tool.call] ${name} ${JSON.stringify(args)}${C.x}`);

  if (name === "flag_for_clinician") {
    state.facts.push({ field: "ESCALATION", value: args.reason, certainty: 1, flagged: true });
    return { escalated: true, ticket: "esc_sim" };
  }

  const material = name === "record_adherence";

  if (name === "record_adherence" && !state.askedAdherence) {
    console.log(`   ${C.r}GATE · REJECTED (structural)${C.x} ${C.dim}no adherence question was asked yet${C.x}\n`);
    return {
      recorded: false,
      error:
        "REJECTED: you have not asked the adherence question yet, so there is no answer to record. " +
        "Ask whether they have been taking it as prescribed, and call this only once they reply to that.",
    };
  }

  const turn = await captureUserTurn(2500);
  if (!turn) {
    return { recorded: false, error: "No usable audio was captured for that answer. Ask the patient to repeat it." };
  }
  state.gatedStopAt = state.userStoppedAt;

  const scored = certaintyForTurn(turn, state.baseline);
  if (process.env.DEBUG_GATE) {
    console.log(`${C.dim}   [gate] onsetMs=${turn.onsetMs} words=` +
      turn.words.map((w) => `${w.text}(${w.start}-${w.end},${w.confidence})`).join(" ") + C.x);
    console.log(`${C.dim}   [gate] ${scored.components.map((c) => `${c.key}=${c.doubt}`).join(" ")}${C.x}`);
  }
  const attempt = state.attempts.get(args.medication || name) || 0;
  const decision = gateDecision(scored, { material, attempt });
  state.baseline.observe(turn);

  const claim = name === "record_adherence"
    ? `${args.medication}: ${args.answer}${args.missed_days ? ` (${args.missed_days})` : ""}`
    : `${args.symptom} — ${args.severity}`;

  const pct = Math.round(decision.certainty * 100);
  const head = decision.allow
    ? `${C.g}GATE · RECORDED${decision.flagged ? " (flagged)" : ""}${C.x}`
    : `${C.r}GATE · REFUSED${C.x}`;
  console.log(`\n   ${head}  ${C.b}${pct}%${C.x} certain   ${C.dim}${claim}${C.x}`);
  for (const e of scored.evidence) console.log(`      ${C.y}·${C.x} ${e}`);
  if (!scored.baselined) console.log(`      ${C.dim}(no personal baseline yet)${C.x}`);

  state.gateEvents.push({ claim, ...decision });

  if (!decision.allow) {
    state.attempts.set(args.medication || name, attempt + 1);
    console.log(`      ${C.y}→ probe:${C.x} ${decision.probe}\n`);
    return { recorded: false, error: refusalMessage(decision) };
  }
  state.facts.push({
    field: name === "record_adherence" ? "Adherence" : "Side effect",
    value: claim, certainty: decision.certainty, flagged: !!decision.flagged,
    patientWords: args.patient_words,
  });
  console.log("");
  return { recorded: true, record_id: `f_${state.facts.length}`, certainty: decision.certainty };
}

async function connectAgent() {
  const ws = new WebSocket("wss://agents.assemblyai.com/v1/ws", {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  const ready = { resolve: null };
  const readyP = new Promise((r) => { ready.resolve = r; });
  const replyDone = [];

  const api = {
    ws,
    ready: readyP,
    lastEvent: null,
    pending: [],
    waitReplyDone: () => new Promise((r) => replyDone.push(r)),
    send: (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o)),
  };

  const flush = () => {
    if (api.lastEvent !== "reply.done" || !api.pending.length) return;
    for (const t of api.pending) {
      api.send({ type: "tool.result", call_id: t.call_id, result: JSON.stringify(t.result) });
    }
    api.pending.length = 0;
  };

  ws.addEventListener("open", () => api.send({ type: "session.update", session: agentConfig() }));

  ws.addEventListener("message", async (e) => {
    const ev = JSON.parse(e.data);
    switch (ev.type) {
      case "session.ready":
        ready.resolve(ev);
        break;
      case "transcript.agent":
        state.transcript.push({ who: "agent", text: ev.text });
        if (/taking (it|them|the|your)|as prescribed|missed (any|a)|every dose/i.test(ev.text)) {
          state.askedAdherence = true;
        }
        console.log(`${C.c}🔊 Tell:${C.x}    ${ev.text}`);
        break;
      case "transcript.user":
        state.transcript.push({ who: "patient", text: ev.text });
        break;
      case "reply.started":
        api.lastEvent = ev.type;
        break;
      case "reply.done":
        api.lastEvent = "reply.done";
        state.agentEndedAt = performance.now();
        flush();
        if (!api.pending.length) { for (const r of replyDone.splice(0)) r(ev); }
        break;
      case "tool.call": {
        const result = await resolveTool(ev);
        api.pending.push({ call_id: ev.call_id, result });
        flush();
        break;
      }
      case "session.error":
        console.error(`${C.r}[agent error]${C.x} ${ev.code}: ${ev.message}`);
        break;
    }
  });

  await readyP;
  return api;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

(async () => {
  console.log(`\n${C.b}Tell — simulated adherence call${C.x} ${C.dim}(${HONEST ? "honest" : "hesitant"} patient)${C.x}\n`);

  console.log(`${C.dim}Rendering patient audio…${C.x}`);
  for (const line of SCRIPT) line.wav = renderUtterance(line.id + (HONEST ? "_h" : ""), line.say);

  const stt = await connectStt();
  const agent = await connectAgent();
  state.micEpoch = performance.now();
  console.log(`${C.dim}Both sockets open.${C.x}\n`);

  await agent.waitReplyDone(); // the greeting

  const PER_CHUNK = (AGENT_RATE * CHUNK_MS) / 1000;
  const SILENCE = new Int16Array(PER_CHUNK);

  /** Send exactly one chunk to both sockets and advance the audio clock. */
  async function pushChunk(slice) {
    const f32 = i16ToF32(slice);
    let sum = 0;
    for (let k = 0; k < f32.length; k++) sum += f32[k] * f32[k];
    const rms = Math.sqrt(sum / f32.length);
    state.frames.push({
      tMs: audioMs(),
      db: Math.round(20 * Math.log10(rms + 1e-9) * 10) / 10,
      hz: rms > 0.01 ? detectPitch(f32, AGENT_RATE) : null,
    });

    agent.send({
      type: "input.audio",
      audio: Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString("base64"),
    });
    sttSend(stt, f32ToI16(downsample(f32, AGENT_RATE, STT_RATE)));
    state.sentSamples += slice.length;
    await sleep(CHUNK_MS);
  }

  /** Hold the line open with silence until `promise` settles (or we time out). */
  async function holdLine(promise, capMs) {
    let done = false;
    const p = Promise.resolve(promise).then(() => { done = true; });
    const until = performance.now() + capMs;
    while (!done && performance.now() < until) await pushChunk(SILENCE);
    await Promise.race([p, sleep(0)]);
  }

  /** Hold the line with silence until the agent says something matching `re`. */
  async function waitForAgentMatch(re, capMs = 20000) {
    if (!re) return;
    const until = performance.now() + capMs;
    while (performance.now() < until) {
      if (state.transcript.some((t) => t.who === "agent" && re.test(t.text) && !t.used)) {
        for (const t of state.transcript) if (t.who === "agent" && re.test(t.text)) t.used = true;
        return;
      }
      await pushChunk(SILENCE);
    }
    console.log(`${C.y}   (timed out waiting for the agent to ask ${re})${C.x}`);
  }

  for (const line of SCRIPT) {
    // Do not answer a question the agent has not asked yet.
    await waitForAgentMatch(line.waitFor);
    // The agent has finished speaking; the reaction clock starts here.
    state.agentEndedAt = performance.now();

    // A real phone line never goes quiet — the mic keeps streaming while the
    // patient thinks. Sending nothing would stall the API's audio clock and
    // desynchronise every timestamp the gate depends on.
    for (let t = 0; t < line.reactionMs; t += CHUNK_MS) await pushChunk(SILENCE);

    state.userStartedAt = performance.now();
    state.userStartAudioMs = audioMs();
    console.log(`${C.b}🗣  Patient:${C.x} ${line.say.replace(/\[\[slnc (\d+)\]\]/g, "$1ms…")}` +
                `  ${C.dim}(${line.reactionMs}ms to start)${C.x}`);

    const pcm = readWavPCM16(line.wav);
    for (let i = 0; i < pcm.length; i += PER_CHUNK) {
      await pushChunk(pcm.subarray(i, Math.min(i + PER_CHUNK, pcm.length)));
    }
    state.userStoppedAt = performance.now();
    state.userStopAudioMs = audioMs();

    for (let t = 0; t < TAIL_SILENCE_MS; t += CHUNK_MS) await pushChunk(SILENCE);
    await holdLine(agent.waitReplyDone(), 12000);

    // Turns nothing gated define this patient's normal pace.
    if (state.gatedStopAt !== state.userStoppedAt) {
      const ordinary = await captureUserTurn(300);
      if (ordinary) state.baseline.observe(ordinary);
    }
  }

  agent.send({ type: "session.end" });
  try { stt.send(JSON.stringify({ type: "Terminate" })); } catch {}

  await sleep(1200);

  console.log(`\n${C.b}════════ CLINICAL RECORD ════════${C.x}`);
  if (!state.facts.length) console.log("  (nothing recorded)");
  for (const f of state.facts) {
    console.log(`  ${f.flagged ? C.y + "⚑" + C.x : " "} ${C.b}${f.field}${C.x}: ${f.value}` +
                `  ${C.dim}certainty ${Math.round(f.certainty * 100)}%${C.x}`);
    if (f.patientWords) console.log(`      ${C.dim}"${f.patientWords}"${C.x}`);
  }
  const refused = state.gateEvents.filter((g) => !g.allow).length;
  console.log(`\n${C.dim}  ${state.gateEvents.length} gate decisions, ${refused} refused.${C.x}`);
  console.log(`${C.dim}  Baseline: ${JSON.stringify(state.baseline.snapshot())}${C.x}\n`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
