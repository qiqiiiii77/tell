/**
 * capture-worklet.js — pulls raw mic blocks off the audio thread.
 *
 * ScriptProcessorNode is deprecated and runs on the main thread, where a React
 * render or a chart repaint shows up as a dropped audio block — which the gate
 * would read as a pause the patient never took. An AudioWorklet runs on the
 * audio rendering thread, so timing stays honest.
 *
 * Blocks arrive 128 frames at a time; we batch them to ~21 ms to keep the
 * message rate sane.
 */
const BATCH = 512; // 512 / 24000 ≈ 21.3 ms

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(BATCH);
    this.fill = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;

    let read = 0;
    while (read < ch.length) {
      const room = BATCH - this.fill;
      const take = Math.min(room, ch.length - read);
      this.buf.set(ch.subarray(read, read + take), this.fill);
      this.fill += take;
      read += take;
      if (this.fill === BATCH) {
        // Transfer a copy; the worklet keeps its own buffer.
        const out = new Float32Array(this.buf);
        this.port.postMessage(out, [out.buffer]);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor("capture", Capture);
