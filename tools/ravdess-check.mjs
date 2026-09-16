#!/usr/bin/env node
/**
 * ravdess-check.mjs — reproduces the table in docs/evidence.md §1.
 *
 * Uploads the eight RAVDESS renditions in samples/ravdess/ to AssemblyAI with
 * sentiment analysis on, and prints official sentiment next to per-word
 * confidence for each one. The point is the gap between the two columns.
 *
 *   node tools/ravdess-check.mjs            # re-run against the API (costs credit)
 *   node tools/ravdess-check.mjs --cached   # print the stored run, no network
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "samples", "ravdess");
const EMOTIONS = ["neutral", "calm", "happy", "sad", "angry", "fearful", "disgust", "surprised"];
const CACHED = process.argv.includes("--cached");

const KEY = (readFileSync(join(ROOT, ".env"), "utf8")
  .match(/ASSEMBLYAI_API_KEY\s*=\s*([A-Za-z0-9]{32})/) || [])[1];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r3 = (v) => (typeof v === "number" ? v.toFixed(3) : "—");

async function transcribe(wav) {
  const up = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: { Authorization: KEY, "content-type": "application/octet-stream" },
    body: readFileSync(wav),
  });
  if (!up.ok) throw new Error(`upload ${up.status}: ${await up.text()}`);
  const { upload_url } = await up.json();

  const post = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: { Authorization: KEY, "content-type": "application/json" },
    body: JSON.stringify({
      audio_url: upload_url,
      speech_model: "universal",
      language_code: "en", // pinned, not detected — see docs/evidence.md §5
      disfluencies: true,
      sentiment_analysis: true,
    }),
  });
  if (!post.ok) throw new Error(`submit ${post.status}: ${await post.text()}`);
  let t = await post.json();

  while (t.status !== "completed" && t.status !== "error") {
    await sleep(2000);
    t = await (await fetch(`https://api.assemblyai.com/v2/transcript/${t.id}`, {
      headers: { Authorization: KEY },
    })).json();
  }
  if (t.status === "error") throw new Error(t.error);
  return t;
}

function row(emotion, text, sentiment, minConf) {
  const flag = /\b(uh|um|hm|hmm|er)\b/i.test(text) ? "  ← filler not in the script" : "";
  return `${emotion.padEnd(10)} ${String(sentiment).padEnd(18)} ${String(r3(minConf)).padStart(6)}   ${JSON.stringify(text)}${flag}`;
}

(async () => {
  console.log("\nSame actor, same sentence, eight emotions.\n");
  console.log(`${"emotion".padEnd(10)} ${"official sentiment".padEnd(18)} ${"minConf".padStart(6)}   transcript`);
  console.log("-".repeat(96));

  if (CACHED || !KEY) {
    const cached = JSON.parse(readFileSync(join(DIR, "ravdess_results.json"), "utf8"));
    for (const r of cached) {
      const s = r.sentiments?.[0];
      console.log(row(r.emotion, r.text, Array.isArray(s) ? `${s[0]} (${s[1]})` : s, r.aai_word_conf_min));
    }
    console.log("\n(cached run — pass no flag and set a key to hit the API)\n");
    return;
  }

  for (const emotion of EMOTIONS) {
    const wav = join(DIR, `${emotion}.wav`);
    if (!existsSync(wav)) { console.log(`${emotion.padEnd(10)} (missing ${wav})`); continue; }
    const t = await transcribe(wav);
    const confs = (t.words || []).map((w) => w.confidence).filter((c) => typeof c === "number");
    const s = t.sentiment_analysis_results?.[0];
    console.log(row(emotion, t.text, s ? `${s.sentiment} (${s.confidence.toFixed(3)})` : "—",
      confs.length ? Math.min(...confs) : null));
  }
  console.log("");
})().catch((e) => { console.error(e.message); process.exit(1); });
