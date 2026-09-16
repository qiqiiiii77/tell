#!/usr/bin/env node
/** Tests for the local acoustic layer. Run: node tests/acoustics.test.mjs */
import { arousalFromFrames } from "../public/js/acoustics.js";
import { downsample, toPCM16, detectPitch } from "../public/js/dsp.js";

let pass = 0, fail = 0;
const out = [];
const t = (name, fn) => {
  try { fn(); pass++; out.push(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { fail++; out.push(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message}`); }
};
const eq = (a, b, m = "") => { if (a !== b) throw new Error(`${m} expected ${b}, got ${a}`); };
const ok = (v, m = "failed") => { if (!v) throw new Error(m); };
const near = (a, b, tol, m = "") => {
  if (Math.abs(a - b) > tol) throw new Error(`${m} expected ${a} within ${tol} of ${b}`);
};

/** A pure tone, as Float32. */
function tone(hz, rate, ms, amp = 0.3) {
  const n = Math.round((rate * ms) / 1000);
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return f;
}

console.log("\n\x1b[1marousalFromFrames\x1b[0m");

t("returns null when there is nothing measurable", () => {
  eq(arousalFromFrames([]), null);
  eq(arousalFromFrames([{ hz: null, db: -90 }]), null);
});

t("averages pitch over voiced frames only", () => {
  const f = arousalFromFrames([
    { hz: 200, db: -20 }, { hz: null, db: -20 }, { hz: 220, db: -20 }, { hz: null, db: -20 },
  ]);
  eq(f.f0Mean, 210, "unvoiced frames must not be averaged in as zeros");
  eq(f.voicedRatio, 0.5);
});

t("reports the pitch range", () => {
  const f = arousalFromFrames([{ hz: 180, db: -20 }, { hz: 260, db: -20 }, { hz: 220, db: -20 }]);
  eq(f.f0Min, 180);
  eq(f.f0Max, 260);
  ok(f.f0Std > 0, "a varying pitch must have non-zero spread");
});

t("ignores near-silent frames when averaging loudness", () => {
  const f = arousalFromFrames([{ hz: 200, db: -20 }, { hz: 200, db: -80 }]);
  eq(f.dbMean, -20, "a -80 dB frame is silence, not a quiet voice");
});

t("survives frames that carry loudness but no pitch", () => {
  const f = arousalFromFrames([{ hz: null, db: -30 }, { hz: null, db: -34 }]);
  eq(f.f0Mean, null);
  eq(f.dbMean, -32);
  eq(f.voicedRatio, 0);
});

console.log("\n\x1b[1mdsp primitives\x1b[0m");

t("detectPitch recovers a known tone", () => {
  near(detectPitch(tone(220, 24000, 100), 24000), 220, 6, "220 Hz tone");
  near(detectPitch(tone(120, 24000, 100), 24000), 120, 4, "120 Hz tone");
});

t("detectPitch returns null on silence", () => {
  eq(detectPitch(new Float32Array(2048), 24000), null);
});

t("downsample preserves duration and drops the rate", () => {
  const src = tone(200, 48000, 100);
  const out16 = downsample(src, 48000, 16000);
  eq(out16.length, Math.floor(src.length / 3));
  // The tone must survive the resample, or the transcriber hears a chipmunk.
  near(detectPitch(out16, 16000), 200, 8, "after 48k→16k");
});

t("downsample is a no-op at the same rate", () => {
  const src = tone(200, 24000, 20);
  eq(downsample(src, 24000, 24000), src);
});

t("toPCM16 clamps instead of wrapping", () => {
  const p = toPCM16(new Float32Array([0, 1, -1, 2, -2]));
  eq(p[1], 32767);
  eq(p[2], -32768);
  ok(p[3] > 0, "an over-range sample must clamp positive, not wrap to negative");
  ok(p[4] < 0, "an under-range sample must clamp negative, not wrap to positive");
});

console.log(out.join("\n"));
console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
