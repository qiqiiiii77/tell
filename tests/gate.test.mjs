#!/usr/bin/env node
/**
 * Tests for the vocal-certainty gate.
 * Run: node tests/gate.test.mjs   (no dependencies)
 */
import {
  GateConfig, PatientBaseline, certaintyForTurn, gateDecision, refusalMessage,
  fillerLoad, hedgeLoad, revisionLoad, preAnswerPause, minWordConfidence,
} from "../public/js/gate.js";

let pass = 0, fail = 0;
const results = [];

function t(name, fn) {
  try { fn(); pass++; results.push(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { fail++; results.push(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message}`); }
}
function eq(a, b, msg = "") {
  if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function ok(v, msg = "assertion failed") { if (!v) throw new Error(msg); }
function gt(a, b, msg = "") { if (!(a > b)) throw new Error(`${msg} expected ${a} > ${b}`); }
function lt(a, b, msg = "") { if (!(a < b)) throw new Error(`${msg} expected ${a} < ${b}`); }

/**
 * Build a word list.
 * spec: [text, durationMs, gapBeforeMs, confidence]
 */
function words(spec, startAt = 0) {
  let t = startAt;
  return spec.map(([text, dur = 220, gap = 60, confidence = 0.96]) => {
    t += gap;
    const w = { text, start: t, end: t + dur, confidence };
    t += dur;
    return w;
  });
}

const FLUENT = words([
  ["Yes", 200, 0, 0.99], ["I", 120, 50, 0.98], ["took", 200, 50, 0.99],
  ["every", 220, 50, 0.97], ["dose", 260, 50, 0.98],
]);

const HESITANT = words([
  ["Uh", 300, 0, 0.71], ["yeah", 250, 900, 0.58], ["I", 120, 80, 0.74],
  ["took", 200, 70, 0.62], ["them", 200, 60, 0.55],
]);

const HEDGED = words([
  ["I", 120, 0, 0.97], ["think", 200, 60, 0.96], ["I", 120, 60, 0.96],
  ["pretty", 200, 60, 0.95], ["much", 180, 50, 0.96], ["took", 200, 60, 0.97],
  ["them", 180, 50, 0.96],
]);

/* ---------------------------------------------------------------- */
console.log("\n\x1b[1mSignal primitives\x1b[0m");

t("fillerLoad finds weighted hesitation markers", () => {
  const fl = fillerLoad(HESITANT);
  eq(fl.hits.length, 1);
  eq(fl.hits[0].text, "Uh");
  gt(fl.weighted, 0.9);
});

t("fillerLoad is empty on fluent speech", () => {
  eq(fillerLoad(FLUENT).hits.length, 0);
});

t("hedgeLoad finds multi-word hedges", () => {
  const hl = hedgeLoad(HEDGED);
  ok(hl.hits.some((h) => h.phrase === "i think"), "should find 'i think'");
  ok(hl.hits.some((h) => h.phrase === "pretty much"), "should find 'pretty much'");
});

t("hedgeLoad is empty on a committed answer", () => {
  eq(hedgeLoad(FLUENT).hits.length, 0);
});

t("preAnswerPause totals the dead air and names the worst moment", () => {
  const p = preAnswerPause(HESITANT);
  eq(p.worstMs, 900);
  eq(p.beforeWord, "yeah");
  gt(p.ms, 900, "should sum every gap, not just the largest");
});

t("preAnswerPause stays small on fluent speech", () => {
  lt(preAnswerPause(FLUENT).ms, 300);
});

t("a drawled filler counts as dead air even with no gap after it", () => {
  // Universal-3.5 swallows mid-word silence into the token: a 900ms hesitation
  // inside "uh… yeah" comes back as ONE word "Ah." spanning 1664ms, with only
  // 224ms of measurable gap after it. Found in tools/simulate-call.mjs.
  const swallowed = [
    { text: "Ah.", start: 0, end: 1664, confidence: 0.95 },
    { text: "Yeah,", start: 1888, end: 2384, confidence: 0.99 },
    { text: "yeah,", start: 2403, end: 2899, confidence: 0.99 },
    { text: "I've", start: 2918, end: 3314, confidence: 0.99 },
    { text: "been", start: 3333, end: 3729, confidence: 0.99 },
    { text: "taking", start: 3748, end: 4343, confidence: 0.99 },
  ];
  const p = preAnswerPause(swallowed);
  gt(p.ms, 1200, "the held filler must be counted");
  ok(/held/.test(p.beforeWord), `should name the drawl, got ${p.beforeWord}`);

  const s = certaintyForTurn({ words: swallowed, onsetMs: 1800 });
  lt(s.certainty, GateConfig.materialThreshold, "this is the case the product exists for");
});

t("minWordConfidence returns the weakest word", () => {
  const m = minWordConfidence(HESITANT);
  eq(m.value, 0.55);
  eq(m.word, "them");
});

t("revisionLoad detects self-correction", () => {
  const w = words([["No", 200], ["wait", 200], ["I", 120], ["missed", 200], ["Tuesday", 250]]);
  eq(revisionLoad(w).count, 1);
});

/* ---------------------------------------------------------------- */
console.log("\n\x1b[1mCertainty scoring\x1b[0m");

t("a fluent answer scores as clear", () => {
  const s = certaintyForTurn({ words: FLUENT, onsetMs: 350 });
  gt(s.certainty, GateConfig.hedgedThreshold);
  eq(s.verdict, "clear");
});

t("a hesitant answer scores as unreliable", () => {
  const s = certaintyForTurn({ words: HESITANT, onsetMs: 1900 });
  lt(s.certainty, GateConfig.materialThreshold);
  eq(s.verdict, "unreliable");
});

t("a hedged answer lands between the two", () => {
  const s = certaintyForTurn({ words: HEDGED, onsetMs: 700 });
  gt(s.certainty, GateConfig.materialThreshold);
  lt(s.certainty, GateConfig.hedgedThreshold);
  eq(s.verdict, "hedged");
});

t("hedging is the top driver for a hedged answer", () => {
  const s = certaintyForTurn({ words: HEDGED, onsetMs: 700 });
  eq(s.components[0].key, "hedging");
});

t("evidence is human-readable and non-empty when doubtful", () => {
  const s = certaintyForTurn({ words: HESITANT, onsetMs: 1900 });
  gt(s.evidence.length, 0);
  ok(s.evidence.some((e) => /pause|hesitation|confidence/i.test(e)), "evidence should name a signal");
});

t("no evidence is invented for a clean answer", () => {
  const s = certaintyForTurn({ words: FLUENT, onsetMs: 300 });
  eq(s.evidence.length, 0);
});

/* ---------------------------------------------------------------- */
console.log("\n\x1b[1mWithin-call baseline\x1b[0m");

t("baseline is not trusted until enough turns", () => {
  const b = new PatientBaseline();
  eq(b.ready, false);
  b.observe({ words: FLUENT, onsetMs: 1500 });
  eq(b.ready, false);
  b.observe({ words: FLUENT, onsetMs: 1600 });
  eq(b.ready, true);
});

t("certaintyForTurn reports whether a baseline was used", () => {
  const cold = certaintyForTurn({ words: FLUENT, onsetMs: 400 });
  eq(cold.baselined, false);
  const b = new PatientBaseline();
  b.observe({ words: FLUENT, onsetMs: 400 }).observe({ words: FLUENT, onsetMs: 420 });
  eq(certaintyForTurn({ words: FLUENT, onsetMs: 400 }, b).baselined, true);
});

t("a naturally slow speaker is NOT punished once their baseline is known", () => {
  // Same answer, same 2.2s onset. Cold, that looks evasive.
  const cold = certaintyForTurn({ words: FLUENT, onsetMs: 2200 });
  // But this patient opens every turn at ~2.2s.
  const b = new PatientBaseline();
  b.observe({ words: FLUENT, onsetMs: 2100 })
   .observe({ words: FLUENT, onsetMs: 2250 })
   .observe({ words: FLUENT, onsetMs: 2200 });
  const warm = certaintyForTurn({ words: FLUENT, onsetMs: 2200 }, b);
  gt(warm.certainty, cold.certainty);
  eq(warm.verdict, "clear");
});

t("a fast speaker who suddenly stalls IS caught", () => {
  const b = new PatientBaseline();
  b.observe({ words: FLUENT, onsetMs: 300 })
   .observe({ words: FLUENT, onsetMs: 340 })
   .observe({ words: FLUENT, onsetMs: 310 });
  const stalled = certaintyForTurn({ words: FLUENT, onsetMs: 2200 }, b);
  const normal = certaintyForTurn({ words: FLUENT, onsetMs: 320 }, b);
  lt(stalled.certainty, normal.certainty);
  ok(stalled.components.find((c) => c.key === "onsetDelay").doubt > 0.5,
    "onsetDelay should dominate for a sudden stall");
});

t("baseline median is robust to a single outlier", () => {
  const b = new PatientBaseline();
  b.observe({ words: FLUENT, onsetMs: 400 })
   .observe({ words: FLUENT, onsetMs: 420 })
   .observe({ words: FLUENT, onsetMs: 9000 });
  eq(b.snapshot().onsetMs, 420);
});

/* ---------------------------------------------------------------- */
console.log("\n\x1b[1mThe gate\x1b[0m");

t("a clear answer is allowed through", () => {
  const d = gateDecision(certaintyForTurn({ words: FLUENT, onsetMs: 350 }), { material: true });
  eq(d.allow, true);
  eq(d.flagged, false);
});

t("an unreliable answer on a material field is REFUSED", () => {
  const d = gateDecision(certaintyForTurn({ words: HESITANT, onsetMs: 1900 }), { material: true });
  eq(d.allow, false);
  ok(d.probe, "a refusal must carry a probe");
});

t("the same answer on a NON-material field passes", () => {
  const d = gateDecision(certaintyForTurn({ words: HESITANT, onsetMs: 1900 }), { material: false });
  eq(d.allow, true);
});

t("a hedged answer is allowed but flagged for review", () => {
  const d = gateDecision(certaintyForTurn({ words: HEDGED, onsetMs: 700 }), { material: true });
  eq(d.allow, true);
  eq(d.flagged, true);
});

t("the probe is chosen by which signal fired, not a generic reprompt", () => {
  const hedgeD = gateDecision(
    certaintyForTurn({ words: words([
      ["I", 120, 0, 0.97], ["guess", 200, 60, 0.96], ["I", 120, 60, 0.96],
      ["try", 200, 60, 0.95], ["to", 150, 50, 0.96],
    ]), onsetMs: 600 }), { material: true });
  const pauseD = gateDecision(certaintyForTurn({ words: HESITANT, onsetMs: 1900 }), { material: true });
  if (hedgeD.allow === false && pauseD.allow === false) {
    ok(hedgeD.probe !== pauseD.probe, "different drivers must yield different probes");
  }
  ok(/number/i.test(hedgeD.probe || "") || hedgeD.allow, "a hedge should be answered by asking for a number");
});

t("we refuse at most once, then record with a flag", () => {
  const scored = certaintyForTurn({ words: HESITANT, onsetMs: 1900 });
  const first = gateDecision(scored, { material: true, attempt: 0 });
  eq(first.allow, false);
  const second = gateDecision(scored, { material: true, attempt: 1 });
  eq(second.allow, true, "must not interrogate the patient indefinitely");
  eq(second.flagged, true);
  eq(second.exhausted, true);
});

t("refusalMessage is an instruction the agent can act on", () => {
  const d = gateDecision(certaintyForTurn({ words: HESITANT, onsetMs: 1900 }), { material: true });
  const msg = refusalMessage(d);
  ok(msg.includes("REJECTED"), "must state the refusal");
  ok(msg.includes(d.probe), "must carry the probe verbatim");
  ok(/do not say the answer was recorded/i.test(msg), "must stop the agent from lying to the patient");
  ok(/do not tell the patient about this system/i.test(msg), "must not leak the mechanism to the patient");
});

t("certainty is always a 0..1 number, even with junk input", () => {
  for (const turn of [{ words: [] }, { words: [], onsetMs: -5 }, { words: words([["ok"]]) }]) {
    const s = certaintyForTurn(turn);
    ok(typeof s.certainty === "number" && s.certainty >= 0 && s.certainty <= 1,
      `bad certainty ${s.certainty}`);
  }
});

/* ---------------------------------------------------------------- */
console.log("\n\x1b[1mEnd-to-end: the demo conversation\x1b[0m");

t("the full three-turn call behaves as designed", () => {
  const b = new PatientBaseline();
  // Small talk establishes the baseline.
  b.observe({ words: words([["Yeah", 200], ["sure", 200], ["now", 180], ["is", 120], ["fine", 220]]), onsetMs: 420 });
  b.observe({ words: words([["I'm", 180], ["doing", 200], ["alright", 260]]), onsetMs: 380 });

  // Turn A: the unreliable "yes".
  const a = certaintyForTurn({ words: HESITANT, onsetMs: 2100 }, b);
  const dA = gateDecision(a, { material: true, attempt: 0 });
  eq(dA.allow, false, "the hesitant yes must not be recorded");

  // Turn B: the disclosure that the probe produced.
  const disclosure = words([
    ["I", 120, 0, 0.98], ["missed", 220, 60, 0.97], ["Tuesday", 300, 60, 0.96],
    ["and", 140, 50, 0.98], ["Wednesday", 320, 50, 0.97],
  ]);
  const bb = certaintyForTurn({ words: disclosure, onsetMs: 450 }, b);
  const dB = gateDecision(bb, { material: true, attempt: 1 });
  eq(dB.allow, true, "the recovered answer must be recorded");
  eq(dB.verdict, "clear");
  gt(bb.certainty, a.certainty + 0.2, "the recovered answer must be markedly more certain");
});

/* ---------------------------------------------------------------- */
console.log(results.join("\n"));
console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
