/**
 * agent.js — AssemblyAI Voice Agent API client.
 *
 * Owns the conversation: turn-taking, VAD, the LLM, TTS playback and tool calls.
 * It deliberately knows nothing about the certainty gate — it just hands tool
 * calls to an async resolver and waits. That wait is what makes the whole design
 * race-free: we control when `tool.result` goes back, so the gate can take as
 * long as it needs to hear the patient properly before the agent may continue.
 */

const WS_URL = "wss://agents.assemblyai.com/v1/ws";
const PLAYBACK_RATE = 24000; // the API always returns PCM16 @ 24 kHz

export class AgentClient {
  /**
   * @param {object} cb
   * @param {(e:object)=>void} cb.onReady
   * @param {(text:string)=>void} cb.onAgentSaid
   * @param {(text:string)=>void} cb.onUserSaid
   * @param {()=>void} cb.onUserSpeechStart
   * @param {()=>void} cb.onUserSpeechStop
   * @param {()=>void} cb.onAgentSpeechStart
   * @param {()=>void} cb.onAgentSpeechEnd
   * @param {(call:object)=>Promise<object>} cb.resolveTool  returns the tool result
   * @param {(e:object)=>void} cb.onError
   * @param {(e:object)=>void} cb.onEvent   raw event tap, for the debug log
   */
  constructor(cb = {}) {
    Object.assign(this, cb);
    this.ws = null;
    this.ready = false;
    this.sessionId = null;
    this.playCtx = null;
    this.playhead = 0;
    this.sources = new Set();
    this.lastEvent = null;
    this.pending = [];
    this.agentSpeaking = false;
  }

  async connect(sessionConfig) {
    const r = await fetch("/api/agent-token");
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "could not mint an agent token");

    this.playCtx = new AudioContext();
    if (this.playCtx.state === "suspended") await this.playCtx.resume();
    this.playhead = this.playCtx.currentTime;

    const url = new URL(WS_URL);
    url.searchParams.set("token", data.token);
    this.ws = new WebSocket(url);

    this.ws.addEventListener("open", () => {
      this.#send({ type: "session.update", session: sessionConfig });
    });
    this.ws.addEventListener("message", (e) => this.#handle(JSON.parse(e.data)));
    this.ws.addEventListener("error", (e) => this.onError?.({ message: "agent socket error", raw: e }));
    this.ws.addEventListener("close", (e) => {
      this.ready = false;
      if (e.code !== 1000) this.onError?.({ message: `agent socket closed (${e.code})` });
    });

    // A bare close leaves the session in a billable 30s resume window.
    this._onPageHide = () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "session.end" }));
      }
    };
    window.addEventListener("pagehide", this._onPageHide);
    return this;
  }

  #send(o) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  sendAudio(arrayBuffer) {
    if (!this.ready) return;
    const bytes = new Uint8Array(arrayBuffer);
    let bin = "";
    const CHUNK = 0x8000; // String.fromCharCode blows the stack on big arrays
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    this.#send({ type: "input.audio", audio: btoa(bin) });
  }

  /** Nudge the agent to speak without the patient having said anything. */
  say(instructions) {
    this.#send({ type: "reply.create", instructions });
  }

  end() {
    this.#send({ type: "session.end" });
  }

  async #handle(e) {
    this.onEvent?.(e);

    switch (e.type) {
      case "session.ready":
        this.ready = true;
        this.sessionId = e.session_id;
        this.onReady?.(e);
        break;

      case "input.speech.started":
        this.lastEvent = e.type;
        this.onUserSpeechStart?.();
        break;

      case "input.speech.stopped":
        this.onUserSpeechStop?.();
        break;

      case "transcript.user":
        this.onUserSaid?.(e.text, e.item_id);
        break;

      case "reply.started":
        this.lastEvent = e.type;
        if (!this.agentSpeaking) { this.agentSpeaking = true; this.onAgentSpeechStart?.(); }
        break;

      case "reply.audio":
        this.#play(e.data);
        break;

      case "transcript.agent":
        this.onAgentSaid?.(e.text, { interrupted: e.interrupted });
        break;

      case "reply.done":
        this.lastEvent = "reply.done";
        if (e.status === "interrupted") {
          this.#flushPlayback();
          this.pending.length = 0; // results from a reply nobody heard are stale
        }
        this.agentSpeaking = false;
        this.onAgentSpeechEnd?.();
        this.#flushTools();
        break;

      case "tool.call": {
        // Resolve out of band. The gate may need to wait for the STT turn to
        // finalise, and that is fine — nothing is sent until reply.done.
        const result = await Promise.resolve(this.resolveTool?.(e)).catch((err) => ({
          error: `Tool failed locally: ${err?.message || err}. Apologise briefly and continue.`,
        }));
        this.pending.push({ call_id: e.call_id, result });
        this.#flushTools();
        break;
      }

      case "session.error":
        this.onError?.({ message: `${e.code}: ${e.message}`, raw: e });
        break;

      case "session.ended":
        this.ready = false;
        break;
    }
  }

  /** Tool results are only accepted when reply.done is the latest event. */
  #flushTools() {
    if (this.lastEvent !== "reply.done" || !this.pending.length) return;
    for (const t of this.pending) {
      this.#send({ type: "tool.result", call_id: t.call_id, result: JSON.stringify(t.result) });
    }
    this.pending.length = 0;
  }

  #play(b64) {
    const raw = atob(b64);
    const n = raw.length >> 1;
    const f32 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lo = raw.charCodeAt(i * 2);
      const hi = raw.charCodeAt(i * 2 + 1);
      const int = (hi << 8) | lo;
      f32[i] = (int >= 0x8000 ? int - 0x10000 : int) / 32768;
    }
    const buf = this.playCtx.createBuffer(1, n, PLAYBACK_RATE);
    buf.getChannelData(0).set(f32);
    const src = this.playCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this.playCtx.destination);
    this.playhead = Math.max(this.playhead, this.playCtx.currentTime);
    src.start(this.playhead);
    this.playhead += buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  /** On barge-in, drop everything already scheduled or the agent talks over itself. */
  #flushPlayback() {
    for (const s of this.sources) { try { s.stop(); } catch {} }
    this.sources.clear();
    this.playhead = this.playCtx?.currentTime ?? 0;
  }

  async destroy() {
    window.removeEventListener("pagehide", this._onPageHide);
    this.#flushPlayback();
    try { this.ws?.close(); } catch {}
    try { await this.playCtx?.close(); } catch {}
    this.ws = null;
    this.playCtx = null;
  }
}
