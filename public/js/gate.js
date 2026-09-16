/**
 * gate.js — the vocal-certainty gate.
 *
 * Everything else in this repo exists to feed this file. The voice agent cannot
 * write an adherence fact into the record by itself: it must call a tool, and
 * this module decides whether that write is allowed.
 *
 * The decision is made from HOW the patient answered, not what they said:
 *   - how long they took to start answering
 *   - how long they paused mid-answer
 *   - hesitation markers ("uh", "um", "I mean")
 *   - lexical hedging ("I think", "pretty much", "mostly")
 *   - the ASR's own per-word confidence  <- see docs/evidence.md
 *   - self-correction
 *   - pitch / loudness movement away from their own baseline
 *   - how short the answer was relative to how long it took to produce
 *
 * Every component is scored against THIS patient's baseline from earlier in the
 * same call wherever one exists, because "slow" only means something relative to
 * how that person normally speaks. Before a baseline exists we fall back to
 * absolute thresholds and say so in the output (`baselined: false`).
 *
 * Pure functions, no I/O, no DOM — the same file runs in the browser and in Node.
 */

export const GateConfig = {
  /** Below this certainty, a material answer is refused. */
  materialThreshold: 0.55,
  /** Below this, even a non-material answer is flagged (but not refused). */
  hedgedThreshold: 0.75,

  /** Absolute fallbacks, used until a within-call baseline exists. */
  absolute: {
    onsetMs: 1200,        // "normal" time to start answering
    preAnswerPauseMs: 700,
    wordConfidence: 0.82,
    fillerPerWord: 0.08,
  },

  /** How many prior turns before we trust the within-call baseline. */
  minBaselineTurns: 2,

  /**
   * How much doubt each signal can contribute on its own, when maxed out.
   *
   * These are combined with a noisy-OR, not a weighted mean. A weighted mean
   * lets seven clean signals bury one screaming one — and "I think I pretty
   * much took them", delivered perfectly fluently, is exactly that case: a
   * textbook non-committal answer with nothing else wrong with it. Noisy-OR
   * lets any single strong tell raise doubt on its own, and lets several
   * weak ones compound, which is how a clinician actually hears it.
   */
  influence: {
    onsetDelay: 0.42,
    preAnswerPause: 0.38,
    hedging: 0.35,
    fillerLoad: 0.32,
    wordConfidence: 0.30,
    revision: 0.25,
    arousal: 0.18,
    brevity: 0.15,
  },
};

/** Lexical hedges. Weighted: "I think" is softer evidence than "I guess". */
const HEDGES = {
  "i think": 0.7, "i guess": 1.0, "i believe": 0.6, "i suppose": 0.9,
  "probably": 0.8, "pretty much": 0.9, "more or less": 0.9, "mostly": 0.7,
  "most of the time": 0.8, "i'd say": 0.7, "i would say": 0.7, "kind of": 0.8,
  "sort of": 0.8, "maybe": 0.8, "i mean": 0.6, "basically": 0.5, "roughly": 0.6,
  "about": 0.3, "around": 0.3, "almost": 0.6, "nearly": 0.6, "usually": 0.6,
  "generally": 0.6, "i try to": 1.0, "try to": 0.9, "as far as i know": 0.9,
  "i think so": 1.0, "should be": 0.7, "supposed to": 0.8,
};

// "ah" is weighted like a real filler rather than an exclamation because
// Universal-3.5 transcribes a hesitant "uh" as "Ah." more often than not —
// see the words dump in docs/evidence.md.
const FILLERS = {
  uh: 1.0, um: 1.0, er: 0.9, erm: 1.0, ah: 0.8, hmm: 0.9, hm: 0.9,
  mm: 0.7, uhh: 1.0, umm: 1.0, well: 0.4, like: 0.4,
};

const REVISION_MARKERS = [
  "no wait", "i mean", "or rather", "actually no", "sorry i meant",
  "well no", "let me rephrase", "no sorry", "scratch that", "i take that back",
];

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const r3 = (v) => Math.round(v * 1000) / 1000;
const normWord = (t) => String(t || "").toLowerCase().replace(/[^\w']/g, "");

/* ------------------------------------------------------------------ *
 * Within-call baseline
 * ------------------------------------------------------------------ */

/**
 * Accumulates how this particular patient speaks over the course of one call,
 * so later turns are judged against their own norm rather than a global one.
 */
export class PatientBaseline {
  constructor() {
    this.onsets = [];
    this.wordConfs = [];
    this.fillerRates = [];
    this.f0Means = [];
    this.turns = 0;
  }

  /** Feed a completed, non-material turn (small talk, consent, chit-chat). */
  observe({ words = [], onsetMs = null, arousal = null } = {}) {
    this.turns += 1;
    if (typeof onsetMs === "number" && onsetMs >= 0) this.onsets.push(onsetMs);
    for (const w of words) {
      if (typeof w.confidence === "number" && w.confidence > 0) this.wordConfs.push(w.confidence);
    }
    if (words.length) this.fillerRates.push(fillerLoad(words).perWord);
    if (arousal && typeof arousal.f0Mean === "number") this.f0Means.push(arousal.f0Mean);
    return this;
  }

  get ready() {
    return this.turns >= GateConfig.minBaselineTurns;
  }

  median(key) {
    const a = this[key];
    if (!a || !a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /** Robust spread (median absolute deviation), so one odd turn can't skew it. */
  mad(key) {
    const m = this.median(key);
    if (m === null) return null;
    const devs = this[key].map((v) => Math.abs(v - m)).sort((x, y) => x - y);
    const mid = devs.length >> 1;
    const d = devs.length % 2 ? devs[mid] : (devs[mid - 1] + devs[mid]) / 2;
    return d || null;
  }

  snapshot() {
    return {
      ready: this.ready,
      turns: this.turns,
      onsetMs: this.median("onsets"),
      wordConfidence: this.median("wordConfs"),
      fillerPerWord: this.median("fillerRates"),
      f0Mean: this.median("f0Means"),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Individual signals
 * ------------------------------------------------------------------ */

export function fillerLoad(words) {
  let weighted = 0;
  const hits = [];
  words.forEach((w, i) => {
    const n = normWord(w.text);
    if (FILLERS[n] !== undefined) {
      weighted += FILLERS[n];
      hits.push({ index: i, text: w.text, weight: FILLERS[n], start: w.start });
    }
  });
  return { weighted, hits, perWord: words.length ? weighted / words.length : 0 };
}

export function hedgeLoad(words) {
  const text = " " + words.map((w) => normWord(w.text)).join(" ") + " ";
  let weighted = 0;
  const hits = [];
  for (const [phrase, weight] of Object.entries(HEDGES)) {
    const needle = " " + phrase.replace(/[^\w' ]/g, "") + " ";
    let idx = 0;
    while ((idx = text.indexOf(needle, idx)) !== -1) {
      weighted += weight;
      hits.push({ phrase, weight });
      idx += needle.length - 1;
    }
  }
  return { weighted, hits, perWord: words.length ? weighted / words.length : 0 };
}

export function revisionLoad(words) {
  const text = " " + words.map((w) => normWord(w.text)).join(" ") + " ";
  const hits = REVISION_MARKERS.filter((m) => text.includes(" " + m.replace(/[^\w' ]/g, "") + " "));
  return { count: hits.length, hits };
}

/** A filler held longer than this is being used to buy thinking time. */
const FILLER_NORMAL_MS = 350;

/**
 * Dead air before the patient commits to an answer, over the opening words.
 *
 * Counting only the gaps between words misses most of it. Asked to say
 * "uh [900 ms of silence] yeah, I've been taking them", Universal-3.5 returns
 * ONE word — "Ah." — spanning 0–1664 ms, with the silence swallowed inside the
 * token's own duration. The measured inter-word gap is then 224 ms and the
 * hesitation looks like nothing.
 *
 * So dead air = the gaps between words PLUS however long a filler was held
 * beyond the ~350 ms it takes to actually say one. A drawled "uhhhh" and a
 * silent pause are the same behaviour wearing different clothes.
 */
export function preAnswerPause(words, head = 6) {
  let dead = 0;
  let worst = 0;
  let at = null;
  const n = Math.min(words.length, head);

  for (let i = 0; i < n; i++) {
    const w = words[i];
    if (i > 0) {
      const gap = Math.max(0, w.start - words[i - 1].end);
      dead += gap;
      if (gap > worst) { worst = gap; at = w.text; }
    }
    if (FILLERS[normWord(w.text)] !== undefined) {
      const drawl = Math.max(0, (w.end - w.start) - FILLER_NORMAL_MS);
      dead += drawl;
      if (drawl > worst) { worst = drawl; at = `${w.text} (held ${Math.round(w.end - w.start)}ms)`; }
    }
  }
  return { ms: Math.round(dead), worstMs: Math.round(worst), beforeWord: at };
}

export function minWordConfidence(words) {
  const cs = words
    .map((w) => ({ c: w.confidence, t: w.text }))
    .filter((x) => typeof x.c === "number" && x.c > 0);
  if (!cs.length) return { value: null, word: null };
  const lowest = cs.reduce((a, b) => (b.c < a.c ? b : a));
  return { value: lowest.c, word: lowest.t };
}

/* ------------------------------------------------------------------ *
 * Certainty
 * ------------------------------------------------------------------ */

/**
 * Score how certain a patient sounded on one turn.
 *
 * @param {object} turn
 * @param {Array}  turn.words      word objects {text, start, end, confidence} from Streaming STT
 * @param {number} turn.onsetMs    ms between the agent finishing and the patient starting
 * @param {object} turn.arousal    local acoustic profile for this turn (from engine.arousalFromFrames)
 * @param {PatientBaseline} baseline
 * @returns {{certainty:number, verdict:string, baselined:boolean, components:Array, evidence:Array}}
 */
export function certaintyForTurn(turn, baseline = null) {
  const words = turn.words || [];
  const base = baseline && baseline.ready ? baseline.snapshot() : null;
  const abs = GateConfig.absolute;
  const comp = [];
  const evidence = [];

  const push = (key, doubt, detail, note) => {
    const influence = GateConfig.influence[key];
    const d = clamp01(doubt);
    comp.push({ key, doubt: r3(d), influence, contribution: r3(d * influence), detail });
    if (note && d > 0.35) evidence.push(note);
  };

  // 1. Onset delay — took unusually long to start answering at all.
  if (typeof turn.onsetMs === "number") {
    const ref = base?.onsetMs ?? abs.onsetMs;
    const spread = (baseline?.mad("onsets")) || ref * 0.5 || 400;
    const excess = (turn.onsetMs - ref) / Math.max(spread, 150);
    push("onsetDelay", excess / 3, { onsetMs: Math.round(turn.onsetMs), refMs: Math.round(ref) },
      `took ${Math.round(turn.onsetMs)}ms to start answering (their norm: ${Math.round(ref)}ms)`);
  }

  // 2. Pause before committing to the answer.
  const pap = preAnswerPause(words);
  push("preAnswerPause", pap.ms / (abs.preAnswerPauseMs * 2), { ms: Math.round(pap.ms), beforeWord: pap.beforeWord },
    pap.ms > 0 ? `${Math.round(pap.ms)}ms pause before "${pap.beforeWord}"` : null);

  // 3. Hesitation markers.
  //
  // Counted absolutely, not per word. One "uh" in a seven-word answer to a
  // yes/no question is not diluted by the six words around it — if anything the
  // opposite. Dividing by length let long fluent-sounding answers hide a filler.
  const fl = fillerLoad(words);
  push("fillerLoad", fl.weighted / 1.2, { weighted: r3(fl.weighted), hits: fl.hits.map((h) => h.text) },
    fl.hits.length ? `hesitation markers: ${fl.hits.map((h) => `"${h.text}"`).join(", ")}` : null);

  // 4. Lexical hedging — the words people reach for when they are not sure.
  const hl = hedgeLoad(words);
  push("hedging", hl.weighted / 1.5, { weighted: r3(hl.weighted), hits: hl.hits.map((h) => h.phrase) },
    hl.hits.length ? `hedged with ${hl.hits.map((h) => `"${h.phrase}"`).join(", ")}` : null);

  // 5. The ASR's own confidence. A model that cannot hear the word cleanly is
  //    itself evidence — see docs/evidence.md, RAVDESS fear 0.50 vs calm 0.99.
  const mwc = minWordConfidence(words);
  if (mwc.value !== null) {
    const ref = base?.wordConfidence ?? abs.wordConfidence;
    push("wordConfidence", (ref - mwc.value) / 0.3, { min: r3(mwc.value), word: mwc.word, ref: r3(ref) },
      mwc.value < ref - 0.1 ? `transcription confidence fell to ${r3(mwc.value)} on "${mwc.word}"` : null);
  }

  // 6. Self-correction.
  const rl = revisionLoad(words);
  push("revision", rl.count / 2, { count: rl.count, hits: rl.hits },
    rl.count ? `self-corrected (${rl.hits.join(", ")})` : null);

  // 7. Voice moving away from their own baseline.
  if (turn.arousal && typeof turn.arousal.f0Mean === "number" && base?.f0Mean) {
    const rel = Math.abs(turn.arousal.f0Mean - base.f0Mean) / Math.max(base.f0Mean * 0.12, 6);
    push("arousal", rel / 2.5, { f0Mean: turn.arousal.f0Mean, baseF0: r3(base.f0Mean) },
      rel > 1 ? `pitch moved ${turn.arousal.f0Mean > base.f0Mean ? "up" : "down"} from their baseline` : null);
  }

  // 8. A very short answer that took a long time to produce is its own tell.
  if (words.length && typeof turn.onsetMs === "number") {
    const terse = words.length <= 3 ? 1 : words.length <= 5 ? 0.5 : 0;
    const slow = turn.onsetMs > (base?.onsetMs ?? abs.onsetMs) * 1.5 ? 1 : 0;
    push("brevity", terse * slow, { wordCount: words.length },
      terse && slow ? `a ${words.length}-word answer after a long pause` : null);
  }

  // Noisy-OR: each signal independently fails to raise doubt, and we take the
  // probability that at least one of them does.
  let clean = 1;
  for (const c of comp) clean *= 1 - c.contribution;
  const certainty = r3(clamp01(clean));

  const verdict =
    certainty < GateConfig.materialThreshold ? "unreliable"
    : certainty < GateConfig.hedgedThreshold ? "hedged"
    : "clear";

  return {
    certainty,
    verdict,
    baselined: !!base,
    components: comp.sort((a, b) => b.contribution - a.contribution),
    evidence,
  };
}

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

/**
 * Which follow-up to ask, chosen by WHICH signal fired — not a generic reprompt.
 * This mapping is the difference between "sorry, could you repeat that?" and a
 * question that actually recovers the missing fact.
 */
const PROBE_BY_SIGNAL = {
  onsetDelay:
    "They hesitated noticeably before answering. Do not accept it. Ask them to walk through the last seven days one day at a time, starting with yesterday.",
  preAnswerPause:
    "They paused before committing to the answer. Do not accept it. Ask them which specific days they think they may have missed.",
  fillerLoad:
    "Their answer was full of hesitation. Do not accept it. Ask for a number: out of the last seven days, how many did they take it?",
  hedging:
    "They hedged instead of committing. Do not accept it. Warmly ask them to put an actual number on it — how many doses were missed this week?",
  wordConfidence:
    "The audio of that answer was unstable — they may have trailed off or spoken away from the phone. Ask them to say the answer again.",
  revision:
    "They started one answer and switched to another. Do not accept it. Gently ask which of the two is right.",
  arousal:
    "Their voice tightened on that answer. Acknowledge that keeping up with medication is genuinely hard and that you are not there to judge, then ask again.",
  brevity:
    "A bare one-word answer after a delay. Do not accept it. Ask an open question: what has been getting in the way of taking it?",
};

/**
 * Decide whether an agent's proposed write may proceed.
 *
 * @param {object} scored   output of certaintyForTurn
 * @param {object} opts
 * @param {boolean} opts.material   is this a clinically material field?
 * @param {number}  opts.attempt    how many times we have already refused this fact
 * @param {number}  opts.maxAttempts refuse at most this many times, then accept with a flag
 */
export function gateDecision(scored, { material = true, attempt = 0, maxAttempts = 1 } = {}) {
  const passes = !material || scored.certainty >= GateConfig.materialThreshold;
  const exhausted = attempt >= maxAttempts;

  if (passes) {
    return {
      allow: true,
      certainty: scored.certainty,
      verdict: scored.verdict,
      flagged: scored.verdict === "hedged",
      evidence: scored.evidence,
    };
  }

  if (exhausted) {
    // We already asked once. Asking a patient the same question a third time is
    // an interrogation, not care. Record it, but mark it as low-confidence so a
    // human sees it.
    return {
      allow: true,
      certainty: scored.certainty,
      verdict: "unreliable",
      flagged: true,
      exhausted: true,
      evidence: scored.evidence,
      note: "Recorded after one unsuccessful clarification. Flagged for clinician review.",
    };
  }

  const driver = scored.components[0];
  const probe = PROBE_BY_SIGNAL[driver?.key] || PROBE_BY_SIGNAL.preAnswerPause;

  return {
    allow: false,
    certainty: scored.certainty,
    verdict: "unreliable",
    driver: driver?.key,
    evidence: scored.evidence,
    probe,
  };
}

/**
 * Render a gate refusal as the `error` string of a tool result.
 * The agent reads this verbatim, so it has to be an instruction, not a status.
 */
export function refusalMessage(decision) {
  const ev = decision.evidence?.length ? ` Evidence: ${decision.evidence.join("; ")}.` : "";
  return (
    `REJECTED by the vocal-certainty gate — certainty ${decision.certainty} ` +
    `(threshold ${GateConfig.materialThreshold}).${ev} ${decision.probe} ` +
    `Do not tell the patient about this system, and do not say the answer was recorded.`
  );
}
