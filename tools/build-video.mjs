#!/usr/bin/env node
/**
 * build-video.mjs — renders the submission video with no camera and no screen
 * recording: HTML frames through headless Chrome, narration from
 * tools/narrate.mjs, assembled by ffmpeg.
 *
 *   node tools/narrate.mjs      # first: render the voice track
 *   node tools/build-video.mjs  # then: frames + assembly -> video/tell.mp4
 *
 * The terminal frames are the real output of tools/simulate-call.mjs, captured
 * in video/run.log. Nothing in the video is mocked up.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VID = join(ROOT, "video");
const FRAMES = join(VID, "frames");
const W = 1920, H = 1080;

const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find(existsSync);
if (!CHROME) { console.error("Chrome not found"); process.exit(1); }

const durations = Object.fromEntries(
  JSON.parse(readFileSync(join(VID, "durations.json"), "utf8")).map((d) => [d.id, d.seconds])
);

/* ------------------------------------------------------------------ *
 * shared styling — same language as the app and the deck
 * ------------------------------------------------------------------ */

const CSS = `
  @font-face { font-family: x; src: local("Helvetica Neue"); }
  * { box-sizing:border-box; margin:0; padding:0; }
  :root {
    --bg:#0d1017; --panel:#161c26; --line:#252d3a; --ink:#e8edf5;
    --muted:#8b97a8; --dim:#5c6779; --mint:#6ee7b7; --red:#f87171;
    --amber:#fbbf24; --blue:#7aa2ff;
    --mono:"SF Mono",Menlo,Monaco,monospace;
  }
  html,body { width:${W}px; height:${H}px; overflow:hidden; }
  body {
    background:var(--bg); color:var(--ink);
    font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;
    padding:86px 104px; display:flex; flex-direction:column; justify-content:center;
    position:relative;
  }
  body::before { content:""; position:absolute; top:0; left:0; right:0; height:6px; background:var(--mint); }
  .kicker { font-size:20px; letter-spacing:3.4px; color:var(--dim); text-transform:uppercase; margin-bottom:34px; }
  h1 { font-size:86px; font-weight:650; letter-spacing:-1.8px; line-height:1.1; }
  h2 { font-size:58px; font-weight:620; letter-spacing:-1px; line-height:1.15; }
  p { font-size:30px; line-height:1.55; color:var(--muted); max-width:44ch; }
  b { color:var(--ink); font-weight:600; }
  .mint{color:var(--mint)} .red{color:var(--red)} .amber{color:var(--amber)} .dim{color:var(--dim)}
  .mono { font-family:var(--mono); }
  .quote { font-size:76px; font-weight:600; line-height:1.28; letter-spacing:-1.2px; }
  .gapbox {
    display:inline-block; padding:4px 26px; border:3px dashed var(--red);
    border-radius:9px; color:var(--red); font-size:34px; font-family:var(--mono);
    vertical-align:middle; margin:0 12px;
  }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:16px; padding:34px 40px; }
  .card.bad { border-color:#5b2a2a; background:#1d1416; }
  .card.good { border-color:#2f6b52; background:#101e19; }
  .term {
    font-family:var(--mono); font-size:23px; line-height:1.72;
    background:#080b10; border:1px solid var(--line); border-radius:14px;
    padding:30px 34px; height:790px; overflow:hidden;
  }
  .term .who { color:var(--dim); display:inline-block; width:132px; }
  .term .ag  { color:var(--blue); }
  .term .pt  { color:var(--ink); }
  .term .sys { color:#7b6ba8; }
  .term .ok  { color:var(--mint); }
  .term .no  { color:var(--red); }
  .term .ev  { color:var(--amber); }
  .term .mu  { color:var(--dim); }
  .term .blank { height:14px; }
  table { border-collapse:collapse; width:100%; font-size:25px; }
  th { text-align:left; font-size:16px; letter-spacing:2.2px; text-transform:uppercase;
       color:var(--dim); font-weight:600; padding:0 20px 16px 0; border-bottom:1px solid var(--line); }
  td { padding:17px 20px 17px 0; border-bottom:1px solid #1b222d; color:var(--muted); vertical-align:top; }
  td.k { color:var(--ink); font-family:var(--mono); font-size:22px; white-space:nowrap; }
  td.n { font-family:var(--mono); color:var(--ink); }
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:70px; align-items:start; }
  img { width:100%; background:#fff; border-radius:14px; padding:16px; }
  .foot { position:absolute; bottom:48px; left:104px; right:104px; display:flex;
          justify-content:space-between; font-family:var(--mono); font-size:18px; color:var(--dim); }
`;

/* ------------------------------------------------------------------ *
 * terminal lines — verbatim from video/run.log
 * ------------------------------------------------------------------ */

const T = {
  setup: [
    `<div class="mu">$ node tools/simulate-call.mjs</div>`,
    `<div class="blank"></div>`,
    `<div><span class="who">Tell</span><span class="ag">Hi, this is Tell calling from the clinic about your metformin.</span></div>`,
    `<div><span class="who"></span><span class="ag">Is now an okay time to talk for a minute?</span></div>`,
    `<div><span class="who">Patient</span><span class="pt">Yeah, sure, now is fine.</span></div>`,
    `<div class="blank"></div>`,
    `<div><span class="who">Tell</span><span class="ag">Thanks. Have you been taking the metformin as prescribed?</span></div>`,
  ],
  hesitate: [
    `<div><span class="who">Patient</span><span class="pt">Uh <span class="no">[ 900 ms ]</span> yeah, yeah, I've been taking them.</span> <span class="mu">(1900ms to start)</span></div>`,
    `<div class="blank"></div>`,
    `<div class="sys">   [tool.call] record_adherence { "answer": "took_all", "medication": "metformin" }</div>`,
    `<div class="mu">   [stt] 7 words: "Ah. Yeah, yeah, I've been taking them."</div>`,
  ],
  refuse: [
    `<div class="blank"></div>`,
    `<div><span class="no">   GATE · REFUSED</span>  <b>44%</b> certain   <span class="mu">metformin: took_all</span></div>`,
    `<div><span class="ev">      ·</span> 1614ms pause before "Ah. (held 1664ms)"</div>`,
    `<div><span class="ev">      ·</span> hesitation markers: "Ah."</div>`,
    `<div><span class="ev">      → probe:</span> <span class="mu">Ask them which specific days they think they may have missed.</span></div>`,
  ],
  probe: [
    `<div class="blank"></div>`,
    `<div><span class="who">Tell</span><span class="ag">No problem. Which specific days do you think you may have missed?</span></div>`,
    `<div><span class="who">Patient</span><span class="pt">Okay, honestly, I missed Tuesday and Wednesday. I was away from home.</span></div>`,
  ],
  record: [
    `<div class="blank"></div>`,
    `<div><span class="ok">   GATE · RECORDED</span>  <b>81%</b> certain</div>`,
    `<div class="blank"></div>`,
    `<div class="mu">   ════════ CLINICAL RECORD ════════</div>`,
    `<div>     <b>Adherence</b>: metformin: <span class="ok">missed_some (Tuesday, Wednesday)</span></div>`,
  ],
};

const term = (...groups) => `<div class="term">${groups.flat().join("")}</div>`;

/* ------------------------------------------------------------------ *
 * scenes
 * ------------------------------------------------------------------ */

const SCENES = {
  t01: `
    <div class="kicker">The problem</div>
    <div class="quote">“Yes, I’ve been<br>taking them.”</div>
    <p style="margin-top:56px; font-size:34px">Ask a patient if they took their tablets,<br>and almost all of them say yes.</p>`,

  t02: `
    <div class="kicker">What a good nurse actually listens to</div>
    <div class="quote">“Uh <span class="gapbox">900 ms</span><br>yeah, I’ve been taking them.”</div>
    <p style="margin-top:56px; font-size:34px; max-width:52ch">
      Not the word <b>yes</b>. <b class="mint">The half-second before it.</b></p>`,

  t03: `
    <div class="kicker">What every voice agent does with that half-second</div>
    <h2 style="margin-bottom:56px">It throws it away.</h2>
    <div class="mono" style="font-size:30px; line-height:2.1">
      <div><span class="dim" style="display:inline-block;width:200px">Patient</span>
        “Uh <span class="red">[ 900 ms ]</span> yeah, yeah, I’ve been taking them.”</div>
      <div style="margin-top:22px"><span class="dim" style="display:inline-block;width:200px">Transcript</span>
        <span class="dim">yes</span></div>
    </div>
    <p style="margin-top:56px; max-width:58ch">A fact nobody actually believes, and the next
      clinical decision gets made on top of it.</p>`,

  t04: `
    <div class="kicker">Tell — the one idea</div>
    <h2 style="margin-bottom:44px">The agent cannot write to<br>the record by itself.</h2>
    <div class="card good" style="max-width:none">
      <div style="font-size:38px; line-height:1.4; color:var(--ink)">
        No adherence fact enters the record unless the patient
        sounded certain — <b class="mint">or was asked again.</b></div>
    </div>
    <p style="margin-top:44px; max-width:60ch">It has to call a tool, and that tool is gated on
      <b>how the answer sounded</b>.</p>`,

  t05: `<div class="kicker">A real run · <span class="mono">node tools/simulate-call.mjs</span> · unedited</div>
        ${term(T.setup)}`,
  t06: `<div class="kicker">A real run · <span class="mono">node tools/simulate-call.mjs</span> · unedited</div>
        ${term(T.setup, T.hesitate, T.refuse)}`,
  t07: `<div class="kicker">A refusal is a question, not an error</div>
        ${term(T.setup, T.hesitate, T.refuse, T.probe)}`,
  t08: `<div class="kicker">The record ends up true</div>
        ${term(T.hesitate, T.refuse, T.probe, T.record)}`,

  t09: `
    <div class="kicker">How it is built on AssemblyAI</div>
    <div style="display:grid; grid-template-columns:0.95fr 1.05fr; gap:64px; align-items:center">
      <div>
        <h2 style="font-size:46px; margin-bottom:34px">One microphone,<br>two AssemblyAI sockets.</h2>
        <p style="font-size:26px">The Voice Agent API returns
          <span class="mono" style="color:var(--ink)">transcript.user</span> as a plain string —
          everything an agent needs to answer a question, and nothing you need to judge
          whether someone meant it.</p>
        <p style="font-size:26px; margin-top:26px">Streaming v3 returns the same speech as
          <b>words with millisecond boundaries and a confidence each</b>.</p>
      </div>
      <img src="../docs/architecture.png">
    </div>`,

  t10: `
    <div class="kicker">What the gate measures</div>
    <div class="cols" style="gap:64px">
      <table>
        <tr><th>Signal</th><th>What it catches</th></tr>
        <tr><td class="k">onsetDelay</td><td>how long before they answered at all</td></tr>
        <tr><td class="k">preAnswerPause</td><td>dead air — gaps <b>and</b> drawled fillers</td></tr>
        <tr><td class="k">hedging</td><td>“I think”, “pretty much”, “I try to”</td></tr>
        <tr><td class="k">fillerLoad</td><td>“uh”, “um”, weighted</td></tr>
        <tr><td class="k">wordConfidence</td><td>the transcriber’s own uncertainty</td></tr>
        <tr><td class="k">revision</td><td>started one answer, switched to another</td></tr>
        <tr><td class="k">arousal</td><td>pitch and loudness off their baseline</td></tr>
        <tr><td class="k">brevity</td><td>a one-word answer that took a long time</td></tr>
      </table>
      <div>
        <div class="card" style="margin-bottom:34px">
          <div style="font-size:31px; line-height:1.4; color:var(--ink)">Every signal is scored against
            <b class="mint">this patient, earlier in this same call.</b></div>
        </div>
        <p style="font-size:26px">A patient who opens every sentence at 2.2 seconds isn’t
          penalised for taking 2.2 seconds.</p>
        <p style="font-size:26px; margin-top:24px">A patient who’s been answering in 300 ms and
          suddenly takes 2.2 <b>is</b>.</p>
      </div>
    </div>`,

  t11: `
    <div class="kicker">Same actor · same sentence · eight emotions</div>
    <table style="font-size:26px">
      <tr><th style="width:23%">Emotion</th><th style="width:33%">AssemblyAI sentiment</th>
          <th style="width:24%">Min word confidence</th><th>Transcript</th></tr>
      <tr><td class="k">calm</td><td class="n">NEUTRAL (0.564)</td><td class="n">0.994</td><td class="mono" style="font-size:22px">Kids are talking by the door.</td></tr>
      <tr><td class="k">happy</td><td class="n">NEUTRAL (0.564)</td><td class="n">0.614</td><td class="mono" style="font-size:22px">Kids are talking by the door. <span class="amber">Hm</span></td></tr>
      <tr><td class="k">angry</td><td class="n">NEUTRAL (0.594)</td><td class="n">0.905</td><td class="mono" style="font-size:22px">Kids are talking by the door!</td></tr>
      <tr><td class="k"><b class="red">fearful</b></td><td class="n">NEUTRAL (0.633)</td>
          <td class="n"><b class="red">0.504</b></td>
          <td class="mono" style="font-size:22px">Kids <span class="amber">uh</span> are talking by the door.</td></tr>
    </table>
    <p style="margin-top:44px; max-width:none; font-size:28px">
      Eight readings a human tells apart instantly, all <b>NEUTRAL</b> within 0.07.
      The same eight move word confidence from <b class="mint">0.99</b> to <b class="red">0.50</b>.
      <b>The signal was in the response all along — just not in the field labelled “sentiment”.</b></p>`,

  t12: `
    <div class="kicker">And one we threw out</div>
    <h2 style="font-size:52px; margin-bottom:44px">We had carried a fifth finding<br>for a week. It didn’t hold up.</h2>
    <div class="cols" style="gap:70px; align-items:center">
      <table style="font-size:26px">
        <tr><th>Run</th><th>Words</th><th>Fillers</th></tr>
        <tr><td class="k">language_detection</td><td class="n">401</td><td class="n">0</td></tr>
        <tr><td class="k">language_code: en_us</td><td class="n">412</td><td class="n">0</td></tr>
      </table>
      <div class="card">
        <div style="font-size:33px; line-height:1.4; color:var(--ink)">
          We’d rather ship one fewer headline<br>than one we can’t defend.</div>
      </div>
    </div>
    <p style="margin-top:44px; max-width:66ch">Neither transcript had a single “uh”. The 11-word
      difference was <b>one dropped clause</b>. It’s in the repo, written up as the thing we got wrong.</p>`,

  t13: `
    <div style="text-align:center">
      <h1 style="font-size:150px">Tell</h1>
      <div class="mint" style="font-size:44px; margin-top:22px">It won’t take “yes” for an answer.</div>
      <div class="mono" style="font-size:26px; color:var(--muted); margin-top:66px; line-height:2">
        <div>qiqiiiii77.github.io/tell</div>
        <div>github.com/qiqiiiii77/tell</div>
      </div>
      <div class="mono" style="font-size:20px; color:var(--dim); margin-top:48px">
        AssemblyAI Voice Agent API · Streaming Speech-to-Text v3</div>
    </div>`,
};

/* ------------------------------------------------------------------ *
 * render
 * ------------------------------------------------------------------ */

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const ids = JSON.parse(readFileSync(join(VID, "script.json"), "utf8")).scenes.map((s) => s.id);

for (const id of ids) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
    <body>${SCENES[id] || `<h1>${id}</h1>`}</body></html>`;
  const htmlPath = join(FRAMES, `${id}.html`);
  writeFileSync(htmlPath, html);
  execFileSync(CHROME, [
    "--headless", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    `--screenshot=${join(FRAMES, `${id}.png`)}`, `--window-size=${W},${H}`,
    `file://${htmlPath}`,
  ], { stdio: "ignore" });
  process.stdout.write(`  frame ${id}  ${durations[id].toFixed(1)}s\n`);
}

/* ------------------------------------------------------------------ *
 * assemble
 * ------------------------------------------------------------------ */

const PAD = 0.45; // a beat of silence after each line so it does not run together
const segs = [];

for (const id of ids) {
  const seg = join(FRAMES, `${id}.mp4`);
  const dur = durations[id] + PAD;
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-loop", "1", "-framerate", "30", "-i", join(FRAMES, `${id}.png`),
    "-i", join(VID, "audio", `${id}.wav`),
    "-filter_complex",
    `[0:v]trim=duration=${dur},setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.35,fade=t=out:st=${(dur - 0.35).toFixed(2)}:d=0.35[v];` +
    `[1:a]adelay=120|120,apad=whole_dur=${dur}[a]`,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-shortest", seg,
  ], { stdio: "inherit" });
  segs.push(seg);
  process.stdout.write(`  segment ${id}\n`);
}

const listFile = join(FRAMES, "concat.txt");
writeFileSync(listFile, segs.map((s) => `file '${s}'`).join("\n"));
const out = join(VID, "tell.mp4");
execFileSync("ffmpeg", [
  "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile,
  "-c", "copy", out,
], { stdio: "inherit" });

const secs = ids.reduce((s, id) => s + durations[id] + PAD, 0);
console.log(`\n${out}\n${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, "0")}`);
