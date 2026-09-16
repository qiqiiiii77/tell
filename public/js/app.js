/**
 * app.js — orchestration.
 *
 * One microphone feeds two AssemblyAI sockets at once. The Voice Agent API runs
 * the conversation; Streaming STT v3 runs the measurement. When the agent tries
 * to write an adherence fact, we hold its tool call open until the measurement
 * for that turn has landed, score it, and either let the write through or hand
 * the agent a refusal with a specific follow-up question.
 */

import { MicPipeline } from "./dsp.js";
import { AgentClient } from "./agent.js";
import { SttClient } from "./stt.js";
import { PatientBaseline, certaintyForTurn, gateDecision, refusalMessage, GateConfig } from "./gate.js";
import { arousalFromFrames } from "./acoustics.js";

const $ = (id) => document.getElementById(id);
const MATERIAL_TOOLS = new Set(["record_adherence"]);
const SIGNAL_WAIT_MS = 2000; // how long the gate may hold a tool call open

const state = {
  mic: null,
  agent: null,
  stt: null,
  baseline: new PatientBaseline(),
  agentEndedAt: null,
  userStartedAt: null,
  userStoppedAt: null,
  askedAdherence: false,
  attempts: new Map(),   // medication -> how many times we have already refused
  facts: [],
  gateEvents: [],
  startedAt: 0,
  running: false,
};

/* ================================================================== *
 * UI helpers
 * ================================================================== */

function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${kind}`;
}

function bubble(who, text, cls = "") {
  const wrap = document.createElement("div");
  wrap.className = `bubble ${who} ${cls}`;
  wrap.innerHTML = `<span class="who">${who === "agent" ? "Tell" : "Patient"}</span><p></p>`;
  wrap.querySelector("p").textContent = text;
  $("transcript").append(wrap);
  $("transcript").scrollTop = $("transcript").scrollHeight;
  return wrap;
}

function renderGateEvent(ev) {
  const card = document.createElement("div");
  card.className = `gate-card ${ev.allow ? (ev.flagged ? "flagged" : "allowed") : "refused"}`;

  const pct = Math.round(ev.certainty * 100);
  const bars = ev.components
    .filter((c) => c.contribution > 0.01)
    .slice(0, 5)
    .map((c) => `
      <div class="bar-row">
        <span class="bar-label">${c.key.replace(/([A-Z])/g, " $1").toLowerCase()}</span>
        <div class="bar"><i style="width:${Math.round(c.doubt * 100)}%"></i></div>
        <span class="bar-val">${Math.round(c.doubt * 100)}</span>
      </div>`)
    .join("");

  card.innerHTML = `
    <header>
      <span class="stamp">${ev.allow ? (ev.flagged ? "RECORDED · FLAGGED" : "RECORDED") : "REFUSED"}</span>
      <span class="score"><b>${pct}</b><small>% certain</small></span>
    </header>
    <div class="claim">${escapeHtml(ev.claim)}</div>
    ${ev.evidence.length ? `<ul class="evidence">${ev.evidence.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` : ""}
    <div class="bars">${bars}</div>
    ${ev.probe ? `<div class="probe"><b>Follow-up sent to the agent:</b> ${escapeHtml(ev.probe)}</div>` : ""}
    ${ev.baselined ? "" : `<div class="cold">scored without a personal baseline — first turns of the call</div>`}
  `;
  $("gate-feed").prepend(card);
}

function renderRecord() {
  const el = $("record");
  if (!state.facts.length) { el.innerHTML = `<p class="empty">Nothing recorded yet.</p>`; return; }
  el.innerHTML = state.facts.map((f) => `
    <div class="fact ${f.flagged ? "flagged" : ""}">
      <div class="fact-head">
        <b>${escapeHtml(f.field)}</b>
        <span class="conf">certainty ${Math.round(f.certainty * 100)}%</span>
        ${f.flagged ? `<span class="chip">review</span>` : ""}
      </div>
      <div class="fact-val">${escapeHtml(f.value)}</div>
      <div class="fact-quote">“${escapeHtml(f.patientWords || "")}”</div>
      ${f.note ? `<div class="fact-note">${escapeHtml(f.note)}</div>` : ""}
    </div>`).join("");
}

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function logEvent(e) {
  const el = $("evlog");
  if (!el) return;
  const line = document.createElement("div");
  line.textContent = `${e.type}`;
  el.prepend(line);
  while (el.children.length > 120) el.lastChild.remove();
}

/* ================================================================== *
 * Turn correlation
 * ================================================================== */

/**
 * Assemble the turn the patient just finished.
 *
 * Turn boundaries come from the Voice Agent API (input.speech.started /
 * stopped), which is the only component that actually knows when the patient
 * is taking a turn. Streaming v3 supplies the words inside that window,
 * concatenated across however many turns v3 happened to split it into.
 */
async function captureUserTurn(timeoutMs) {
  const { stt, mic } = state;
  if (!stt || state.userStartedAt === null) return null;

  const fromStt = stt.toStreamMs(state.userStartedAt) - 250; // a little slack
  const toStt = stt.toStreamMs(state.userStoppedAt ?? performance.now()) + 250;

  // Wait for transcription to catch up with the end of the utterance.
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const last = stt.words[stt.words.length - 1];
    if (last && last.end >= toStt - 500) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const words = stt.wordsBetween(fromStt, toStt);
  if (!words.length) return null;

  // Rebase so the gate sees a turn starting near zero.
  const t0 = words[0].start;
  const rebased = words.map((w) => ({ ...w, start: w.start - t0, end: w.end - t0 }));

  // Mic frames use a different origin than STT stream time — line them up, or
  // the acoustic window is off by whole seconds.
  let arousal = null;
  if (mic) {
    const shift = stt.epochMs - mic.startedAt;
    arousal = arousalFromFrames(mic.framesBetween(words[0].start + shift, words[words.length - 1].end + shift));
  }

  return {
    words: rebased,
    text: rebased.map((w) => w.text).join(" "),
    arousal,
    onsetMs:
      state.userStartedAt !== null && state.agentEndedAt !== null
        ? Math.max(0, state.userStartedAt - state.agentEndedAt)
        : null,
  };
}

/* ================================================================== *
 * The gate, wired to tool calls
 * ================================================================== */

async function resolveTool(call) {
  const { name, arguments: args } = call;

  if (name === "flag_for_clinician") {
    state.facts.push({
      field: "ESCALATION", value: `${args.urgency}: ${args.reason}`,
      certainty: 1, flagged: true, patientWords: args.reason,
      note: "Escalated to a clinician.",
    });
    renderRecord();
    setStatus("Escalated to a clinician", "alert");
    return { escalated: true, ticket: `esc_${Date.now().toString(36)}` };
  }

  const material = MATERIAL_TOOLS.has(name);

  // A structural check before the acoustic one: the agent sometimes tries to
  // log an adherence answer off the back of "yes, now is a good time". An
  // answer to a question nobody asked is not an answer.
  if (name === "record_adherence" && !state.askedAdherence) {
    return {
      recorded: false,
      error:
        "REJECTED: you have not asked the adherence question yet, so there is no answer to record. " +
        "Ask whether they have been taking it as prescribed, and call this only once they reply to that.",
    };
  }

  const turn = await captureUserTurn(SIGNAL_WAIT_MS);
  if (!turn) {
    // We never heard a measurable turn — refuse to guess in either direction.
    return {
      recorded: false,
      error: "No usable audio was captured for that answer. Ask the patient to repeat it.",
    };
  }

  state.gatedStopAt = state.userStoppedAt; // this turn is spoken for
  const scored = certaintyForTurn(turn, state.baseline);
  const attempt = state.attempts.get(args.medication || name) || 0;
  const decision = gateDecision(scored, { material, attempt });

  const claim =
    name === "record_adherence"
      ? `${args.medication}: ${args.answer}${args.missed_days ? ` (${args.missed_days})` : ""}`
      : `${args.symptom} — ${args.severity}`;

  state.gateEvents.push({ ...decision, claim, components: scored.components, baselined: scored.baselined });
  renderGateEvent({ ...decision, claim, components: scored.components, baselined: scored.baselined });

  // Feed the turn into the baseline only AFTER it has been scored against it.
  state.baseline.observe(turn);

  if (!decision.allow) {
    state.attempts.set(args.medication || name, attempt + 1);
    setStatus(`Gate refused a write — certainty ${Math.round(decision.certainty * 100)}%`, "warn");
    return { recorded: false, error: refusalMessage(decision) };
  }

  state.facts.push({
    field: name === "record_adherence" ? "Adherence" : "Side effect",
    value: claim,
    certainty: decision.certainty,
    flagged: !!decision.flagged,
    patientWords: args.patient_words,
    note: decision.note,
  });
  renderRecord();
  setStatus(decision.flagged ? "Recorded, flagged for review" : "Recorded", decision.flagged ? "warn" : "ok");
  return { recorded: true, record_id: `f_${state.facts.length}`, certainty: decision.certainty };
}

/* ================================================================== *
 * Call lifecycle
 * ================================================================== */

async function startCall() {
  if (state.running) return;
  state.running = true;
  $("btn-start").disabled = true;
  $("btn-end").disabled = false;
  $("transcript").innerHTML = "";
  $("gate-feed").innerHTML = "";
  Object.assign(state, {
    baseline: new PatientBaseline(),
    agentEndedAt: null, userStartedAt: null, userStoppedAt: null,
    askedAdherence: false, attempts: new Map(),
    facts: [], gateEvents: [], startedAt: Date.now(),
  });
  renderRecord();
  setStatus("Connecting…");

  try {
    const config = await fetch("/api/agent-config").then((r) => r.json());

    state.stt = new SttClient({
      onPartial: (t) => { $("partial").textContent = t.text; },
      onError: (e) => console.warn("[stt]", e.message),
    });

    state.agent = new AgentClient({
      onReady: () => setStatus("Connected — the agent is calling", "ok"),
      onEvent: logEvent,
      onAgentSaid: (text) => {
        bubble("agent", text);
        if (/taking (it|them|the|your)|as prescribed|missed (any|a)|every dose/i.test(text)) {
          state.askedAdherence = true;
        }
      },
      onUserSaid: (text) => { $("partial").textContent = ""; bubble("user", text); },
      onUserSpeechStart: () => { state.userStartedAt = performance.now(); },
      onUserSpeechStop: () => {
        state.userStoppedAt = performance.now();
        const stoppedAt = state.userStoppedAt;
        // A turn nothing gated is ordinary conversation — it is what defines
        // this patient's normal pace, and it is the only honest reference we
        // have for judging the answers that matter.
        setTimeout(async () => {
          if (state.gatedStopAt === stoppedAt) return;
          const turn = await captureUserTurn(500);
          if (turn) state.baseline.observe(turn);
        }, 3000);
      },
      onAgentSpeechEnd: () => { state.agentEndedAt = performance.now(); },
      resolveTool,
      onError: (e) => setStatus(e.message, "alert"),
    });

    state.mic = new MicPipeline({
      onAgentChunk: (b) => state.agent?.sendAudio(b),
      onSttChunk: (b) => state.stt?.sendAudio(b),
      onFrame: (f) => {
        $("m-db").textContent = f.db > -60 ? f.db.toFixed(0) : "—";
        $("m-hz").textContent = f.hz ? `${f.hz.toFixed(0)} Hz` : "—";
        $("m-level").style.width = `${Math.min(100, Math.max(0, (f.db + 60) * 1.6))}%`;
      },
    });

    await state.stt.connect();
    await state.agent.connect(config);
    await state.mic.start();
  } catch (err) {
    setStatus(`Could not start: ${err.message}`, "alert");
    await endCall();
  }
}

async function endCall() {
  if (!state.running) return;
  state.running = false;
  $("btn-start").disabled = false;
  $("btn-end").disabled = true;
  setStatus("Call ended");

  try { state.agent?.end(); } catch {}
  await state.mic?.stop();
  state.stt?.close();
  setTimeout(() => state.agent?.destroy(), 800);

  if (state.facts.length || state.gateEvents.length) {
    const body = {
      durationMs: Date.now() - state.startedAt,
      facts: state.facts,
      gate: state.gateEvents.map((g) => ({
        claim: g.claim, allow: g.allow, certainty: g.certainty,
        verdict: g.verdict, driver: g.driver, evidence: g.evidence,
      })),
      baseline: state.baseline.snapshot(),
    };
    fetch("/api/records", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => { /* the call still happened even if we cannot persist it */ });
  }
}

/* ================================================================== *
 * Gate lab — the gate, offline and deterministic.
 * Lets anyone (including a judge with no microphone) see exactly what the
 * scoring does, with no API key and no network.
 * ================================================================== */

const LAB_CASES = {
  committed: {
    label: "“Yes, I took every dose.”",
    onsetMs: 380,
    spec: [["Yes", 200, 0, 0.99], ["I", 120, 50, 0.98], ["took", 200, 50, 0.99],
           ["every", 220, 50, 0.97], ["dose", 260, 50, 0.98]],
  },
  hesitant: {
    label: "“Uh… yeah, yeah I took them.”",
    onsetMs: 2100,
    spec: [["Uh", 300, 0, 0.71], ["yeah", 250, 900, 0.58], ["yeah", 200, 120, 0.66],
           ["I", 120, 80, 0.74], ["took", 200, 70, 0.62], ["them", 200, 60, 0.55]],
  },
  hedged: {
    label: "“I think I pretty much took them.”",
    onsetMs: 700,
    spec: [["I", 120, 0, 0.97], ["think", 200, 60, 0.96], ["I", 120, 60, 0.96],
           ["pretty", 200, 60, 0.95], ["much", 180, 50, 0.96], ["took", 200, 60, 0.97],
           ["them", 180, 50, 0.96]],
  },
  disclosed: {
    label: "“I missed Tuesday and Wednesday.”",
    onsetMs: 450,
    spec: [["I", 120, 0, 0.98], ["missed", 220, 60, 0.97], ["Tuesday", 300, 60, 0.96],
           ["and", 140, 50, 0.98], ["Wednesday", 320, 50, 0.97]],
  },
};

function buildWords(spec) {
  let t = 0;
  return spec.map(([text, dur, gap, confidence]) => {
    t += gap;
    const w = { text, start: t, end: t + dur, confidence };
    t += dur;
    return w;
  });
}

function runLab(key) {
  const c = LAB_CASES[key];
  const baseline = new PatientBaseline();
  if ($("lab-baseline").checked) {
    // Two turns of ordinary conversation, as if earlier in the same call.
    baseline.observe({ words: buildWords(LAB_CASES.committed.spec), onsetMs: 420 });
    baseline.observe({ words: buildWords(LAB_CASES.committed.spec), onsetMs: 390 });
  }
  const scored = certaintyForTurn({ words: buildWords(c.spec), onsetMs: c.onsetMs }, baseline);
  const decision = gateDecision(scored, { material: true, attempt: 0 });
  $("gate-feed").innerHTML = "";
  renderGateEvent({ ...decision, claim: c.label, components: scored.components, baselined: scored.baselined });
  setStatus(
    decision.allow ? `Gate lab — would be recorded (${Math.round(decision.certainty * 100)}%)`
                   : `Gate lab — would be refused (${Math.round(decision.certainty * 100)}%)`,
    decision.allow ? "ok" : "warn"
  );
}

/* ================================================================== */

$("btn-start").addEventListener("click", startCall);
$("btn-end").addEventListener("click", endCall);
document.querySelectorAll("[data-lab]").forEach((b) =>
  b.addEventListener("click", () => runLab(b.dataset.lab))
);
$("gate-threshold").textContent = `${Math.round(GateConfig.materialThreshold * 100)}%`;
renderRecord();
setStatus("Ready");
