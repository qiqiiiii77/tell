/**
 * acoustics.js — the layer that never leaves the browser.
 *
 * Pitch and loudness are computed from the raw microphone buffer locally and
 * only ever reach the gate as a summary. The audio itself already goes to
 * AssemblyAI for transcription; there is no reason for a second copy to exist
 * anywhere, and "we measured your voice" is a claim that should come with the
 * smallest possible data footprint.
 *
 * Pure functions. The same file runs in the browser and under Node.
 */

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

/**
 * Summarise a window of acoustic frames.
 *
 * Unvoiced frames carry no pitch, so F0 statistics are taken over voiced frames
 * only; averaging zeros in would drag the mean toward whoever paused most.
 * `voicedRatio` is kept separately because it is its own signal — a turn that is
 * mostly unvoiced is mostly breath and silence.
 *
 * @param {Array<{hz:?number, db:?number}>} frames
 * @returns {?object} null when the window holds nothing measurable
 */
export function arousalFromFrames(frames) {
  const f0s = frames.filter((f) => typeof f.hz === "number" && f.hz > 0).map((f) => f.hz);
  const dbs = frames.filter((f) => typeof f.db === "number" && f.db > -55).map((f) => f.db);
  if (!f0s.length && !dbs.length) return null;

  return {
    f0Mean: f0s.length ? r1(mean(f0s)) : null,
    f0Std: f0s.length ? r1(std(f0s)) : null,
    f0Min: f0s.length ? r1(Math.min(...f0s)) : null,
    f0Max: f0s.length ? r1(Math.max(...f0s)) : null,
    dbMean: dbs.length ? r1(mean(dbs)) : null,
    voicedRatio: frames.length ? Math.round((f0s.length / frames.length) * 1000) / 1000 : 0,
    frameCount: frames.length,
  };
}
