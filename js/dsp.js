/**
 * dsp.js — one microphone, three consumers.
 *
 * The whole architecture rests on this file. The Voice Agent API gives us a
 * conversation but only plain-text transcripts; it does not expose word-level
 * timing or per-word confidence, which is exactly what the gate needs. So the
 * same microphone buffer is forked three ways:
 *
 *   24 kHz PCM16  ->  Voice Agent API   (turn-taking, LLM, TTS, tool calls)
 *   16 kHz PCM16  ->  Streaming STT v3  (word timings + per-word confidence)
 *   Float32       ->  local DSP         (F0 + energy, never leaves the browser)
 *
 * Because all three come from one capture, they are sample-aligned: a pause the
 * agent reacts to is the same pause the gate measures.
 */

export const AGENT_RATE = 24000; // required by the Voice Agent API
export const STT_RATE = 16000;   // what we ask Streaming v3 for

export class MicPipeline {
  /**
   * @param {object} cb
   * @param {(buf:ArrayBuffer)=>void} cb.onAgentChunk  PCM16 @ 24 kHz
   * @param {(buf:ArrayBuffer)=>void} cb.onSttChunk    PCM16 @ 16 kHz
   * @param {(frame:object)=>void}    cb.onFrame       {tMs, rms, db, hz}
   */
  constructor({ onAgentChunk, onSttChunk, onFrame } = {}) {
    Object.assign(this, { onAgentChunk, onSttChunk, onFrame });
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.frames = [];
    this.startedAt = 0;
    this.muted = false;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,   // the agent is speaking through the speakers
        noiseSuppression: false,  // suppression eats the very breathiness we measure
        autoGainControl: false,   // AGC would flatten the energy signal
      },
    });

    // Let the browser pick its native rate and resample ourselves.
    //
    // Forcing `new AudioContext({ sampleRate: 24000 })` is the shortcut in
    // AssemblyAI's own quickstart, and it only works on Chromium. Firefox
    // honors the rate but routes a non-default-rate context around its echo
    // canceller, so the agent hears its own TTS and interrupts itself on every
    // reply. Safari ignores the option and silently runs at 48 kHz, which
    // reaches the API as chipmunked audio. Resampling here costs one pass over
    // a 512-sample block and works everywhere.
    this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    this.rate = this.ctx.sampleRate;
    this.source = this.ctx.createMediaStreamSource(this.stream);

    await this.ctx.audioWorklet.addModule("/js/capture-worklet.js");
    this.node = new AudioWorkletNode(this.ctx, "capture", { numberOfInputs: 1, numberOfOutputs: 0 });
    this.node.port.onmessage = (e) => this.#onBlock(e.data);
    this.source.connect(this.node);

    this.startedAt = performance.now();
    return this;
  }

  /** Stop feeding the APIs without tearing the session down (used while the agent talks). */
  setMuted(m) { this.muted = !!m; }

  #onBlock(block) {
    const tMs = performance.now() - this.startedAt;

    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    const rms = Math.sqrt(sum / block.length);
    const db = 20 * Math.log10(rms + 1e-9);
    const hz = rms > 0.01 ? detectPitch(block, this.rate) : null;

    const frame = { tMs, rms, db: Math.round(db * 10) / 10, hz };
    this.frames.push(frame);
    this.onFrame?.(frame);

    if (this.muted) return;
    this.onAgentChunk?.(toPCM16(downsample(block, this.rate, AGENT_RATE)).buffer);
    this.onSttChunk?.(toPCM16(downsample(block, this.rate, STT_RATE)).buffer);
  }

  /** Acoustic frames inside a time window, for per-turn arousal. */
  framesBetween(startMs, endMs) {
    return this.frames.filter((f) => f.tMs >= startMs && f.tMs <= endMs);
  }

  async stop() {
    try {
      this.node?.port?.close();
      this.node?.disconnect();
      this.source?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
      await this.ctx?.close();
    } catch { /* teardown is best-effort */ }
    this.node = this.stream = this.ctx = this.source = null;
  }
}

/** Float32 [-1,1] -> Int16 PCM. */
export function toPCM16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Linear-interpolation resampler. Good enough for ASR, and cheap. */
export function downsample(f32, fromRate, toRate) {
  if (fromRate === toRate) return f32;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(f32.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, f32.length - 1);
    const frac = pos - i0;
    out[i] = f32[i0] * (1 - frac) + f32[i1] * frac;
  }
  return out;
}

/**
 * Autocorrelation F0 estimate. Returns null when the frame is unvoiced.
 *
 * Two details that a naive autocorrelation gets wrong, both of which show up as
 * the pitch reading a clean octave or twelfth below the truth:
 *
 * 1. **Fixed comparison window.** Correlating over `size - lag` samples and
 *    dividing by that shrinking count inflates long lags, because fewer terms
 *    means a noisier average. Every lag here is scored over the same `window`
 *    samples instead.
 * 2. **First strong peak, not the tallest.** A periodic signal correlates just
 *    as well at 2× and 3× its period as at the period itself, so the tallest
 *    peak is a coin toss decided by rounding. We take the shortest lag that
 *    gets within 90% of the best score, which is the true period.
 *
 * Without these, a 220 Hz tone reads as 73.4 Hz — exactly one third.
 */
export function detectPitch(buf, sampleRate, minHz = 70, maxHz = 400) {
  let energy = 0;
  for (let i = 0; i < buf.length; i++) energy += buf[i] * buf[i];
  const rms = Math.sqrt(energy / buf.length);
  if (rms < 0.01) return null;

  const maxPeriod = Math.floor(sampleRate / minHz);
  const minPeriod = Math.floor(sampleRate / maxHz);
  const window = Math.min(buf.length, 2048) - maxPeriod;
  if (window < minPeriod * 2) return null; // too short to see two cycles

  // Normalised cross-correlation, bounded to [-1, 1] and comparable across lags.
  const corr = new Float32Array(maxPeriod + 1);
  let best = 0;
  for (let lag = minPeriod; lag <= maxPeriod; lag++) {
    let num = 0, a = 0, b = 0;
    for (let i = 0; i < window; i++) {
      const x = buf[i];
      const y = buf[i + lag];
      num += x * y; a += x * x; b += y * y;
    }
    const denom = Math.sqrt(a * b);
    const r = denom > 1e-12 ? num / denom : 0;
    corr[lag] = r;
    if (r > best) best = r;
  }

  if (best < 0.5) return null; // not periodic enough to call voiced

  const threshold = best * 0.9;
  for (let lag = minPeriod; lag <= maxPeriod; lag++) {
    if (corr[lag] < threshold) continue;
    // Walk to the local peak so we land on the crest, not its leading edge.
    let peak = lag;
    while (peak + 1 <= maxPeriod && corr[peak + 1] > corr[peak]) peak++;
    return Math.round((sampleRate / peak) * 10) / 10;
  }
  return null;
}
