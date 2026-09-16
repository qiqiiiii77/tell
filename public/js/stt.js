/**
 * stt.js — AssemblyAI Streaming STT v3, running in parallel with the agent.
 *
 * Why a second transcription of the same audio?
 *
 * The Voice Agent API returns `transcript.user` as a plain string. That is all
 * an agent needs to answer a question, and it is useless for deciding whether
 * the person meant it. Streaming v3 returns the same speech as words carrying
 * millisecond start/end times and a per-word confidence — the pauses, the
 * "uh", and the model's own uncertainty. That is the gate's raw material.
 *
 * NOTE — `language_detection` is deliberately NOT set here.
 * Setting it silently disables disfluency preservation: the same audio comes
 * back with the fillers stripped and no warning anywhere in the response. We
 * found this by diffing two transcripts of one file (413 words vs 401) while
 * building this project; it is not in AssemblyAI's documentation. Since the
 * fillers ARE the signal, we pin the language explicitly instead.
 * See docs/evidence.md.
 */

import { STT_RATE } from "./dsp.js";

const WS_BASE = "wss://streaming.assemblyai.com/v3/ws";

/** 100 ms of 16 kHz PCM16 — comfortably inside the API's 50–1000 ms window. */
const FLUSH_SAMPLES = STT_RATE / 10;

export class SttClient {
  /**
   * @param {object} cb
   * @param {(turn:object)=>void} cb.onTurn     finalised turn: {words, text, startMs, endMs}
   * @param {(turn:object)=>void} cb.onPartial
   * @param {()=>void} cb.onOpen
   * @param {(e:object)=>void} cb.onError
   */
  constructor(cb = {}) {
    Object.assign(this, cb);
    this.ws = null;
    this.open = false;
    this.epochMs = 0; // wall-clock time of the first audio sample
    // Streaming v3 rejects any frame outside 50–1000 ms with error 3007 and
    // closes the socket. Our capture blocks are ~21 ms, so we accumulate.
    // This constraint is not in the docs; we hit it in tools/simulate-call.mjs.
    this.pending = new Int16Array(FLUSH_SAMPLES * 2);
    this.pendingLen = 0;

    // Every finalised word of the whole call, in STT stream time.
    //
    // We do NOT use Streaming v3's own end-of-turn segmentation. It ends a turn
    // on silence — including the 900 ms hesitation in the middle of "uh… yeah,
    // I've been taking them", which it splits into three turns. That silence is
    // the single strongest thing the gate measures, so letting the transcriber
    // use it as a delimiter destroys the evidence before we can read it.
    //
    // Turn-taking belongs to the Voice Agent API, which owns the conversation.
    // This socket is an instrument, not a second referee.
    this.words = [];
    this.seen = new Set();
  }

  async connect() {
    const r = await fetch("/api/stt-token");
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "could not mint an STT token");

    const params = new URLSearchParams({
      sample_rate: String(STT_RATE),
      encoding: "pcm_s16le",
      speech_model: "universal-3-5-pro",
      language_code: "en", // NOT language_detection — see the note above
      format_turns: "false", // formatting rewrites disfluencies out of the text
      token: data.token,
    });

    this.ws = new WebSocket(`${WS_BASE}?${params}`);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("open", () => {
      this.open = true;
      this.epochMs = performance.now();
      this.onOpen?.();
    });
    this.ws.addEventListener("message", (e) => this.#handle(e.data));
    this.ws.addEventListener("error", (e) => this.onError?.({ message: "stt socket error", raw: e }));
    this.ws.addEventListener("close", (e) => {
      this.open = false;
      if (e.code !== 1000) this.onError?.({ message: `stt socket closed (${e.code})` });
    });
    return this;
  }

  /** Accepts arbitrarily small PCM16 blocks and emits 100 ms frames. */
  sendAudio(arrayBuffer) {
    if (!this.open || this.ws.readyState !== WebSocket.OPEN) return;
    const incoming = new Int16Array(arrayBuffer);

    let read = 0;
    while (read < incoming.length) {
      const room = this.pending.length - this.pendingLen;
      const take = Math.min(room, incoming.length - read);
      this.pending.set(incoming.subarray(read, read + take), this.pendingLen);
      this.pendingLen += take;
      read += take;

      while (this.pendingLen >= FLUSH_SAMPLES) {
        const frame = this.pending.slice(0, FLUSH_SAMPLES);
        this.ws.send(frame.buffer);
        this.pending.copyWithin(0, FLUSH_SAMPLES, this.pendingLen);
        this.pendingLen -= FLUSH_SAMPLES;
      }
    }
  }

  #handle(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type !== "Turn") return;

    const words = (msg.words || []).map((w) => ({
      text: w.text,
      start: w.start,
      end: w.end,
      confidence: typeof w.confidence === "number" ? w.confidence : null,
    }));
    if (!words.length) return;

    if (!msg.end_of_turn) {
      this.onPartial?.({ words, text: msg.transcript || "" });
      return;
    }

    // Append finalised words, deduped — v3 can resend a word across turns.
    let added = 0;
    for (const w of words) {
      const key = `${w.start}|${w.text}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.words.push(w);
      added++;
    }
    if (!added) return;
    this.words.sort((a, b) => a.start - b.start);
    this.onWords?.(this.words);
  }

  /**
   * Words spoken inside a window, in STT stream time (ms since this socket
   * opened). Pauses between them are preserved, including pauses that v3 chose
   * to treat as turn boundaries.
   */
  wordsBetween(fromMs, toMs) {
    return this.words.filter((w) => w.end >= fromMs && w.start <= toMs);
  }

  /** Convert a performance.now() timestamp into this socket's stream time. */
  toStreamMs(perfMs) {
    return perfMs - this.epochMs;
  }

  close() {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "Terminate" }));
      this.ws?.close();
    } catch { /* best effort */ }
    this.open = false;
  }
}
