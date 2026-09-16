#!/usr/bin/env node
/**
 * narrate.mjs — render narration lines to WAV using AssemblyAI's own TTS.
 *
 * The Voice Agent API speaks its `greeting` verbatim at session start, before
 * any LLM is involved, so a session whose greeting IS the narration line gives
 * us exactly that line as PCM16 @ 24 kHz and nothing else. Using the product's
 * own voice engine for the demo narration is cheaper than a third-party TTS and
 * thematically honest: you are hearing the same synthesiser the agent uses.
 *
 *   node tools/narrate.mjs                 # render every line in script.json
 *   node tools/narrate.mjs --voice anna
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "video", "audio");
const RATE = 24000;

const KEY = (readFileSync(join(ROOT, ".env"), "utf8")
  .match(/ASSEMBLYAI_API_KEY\s*=\s*([A-Za-z0-9]{32})/) || [])[1];
if (!KEY) { console.error("no key in .env"); process.exit(1); }

const voiceArg = process.argv.indexOf("--voice");
const VOICE = voiceArg > -1 ? process.argv[voiceArg + 1] : "alba";

/** Speak one line, resolve with its PCM16 bytes. */
function speak(text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("wss://agents.assemblyai.com/v1/ws", {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    const chunks = [];
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      try { ws.send(JSON.stringify({ type: "session.end" })); } catch {}
      try { ws.close(); } catch {}
      chunks.length ? resolve(Buffer.concat(chunks)) : reject(new Error("no audio returned"));
    };

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          // No system prompt worth speaking of: the greeting is the whole job.
          system_prompt: "Say nothing beyond your greeting.",
          greeting: text,
          output: { voice: VOICE },
        },
      }));
    });

    ws.addEventListener("message", (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === "reply.audio") chunks.push(Buffer.from(ev.data, "base64"));
      else if (ev.type === "reply.done") setTimeout(finish, 350);
      else if (ev.type === "session.error") reject(new Error(`${ev.code}: ${ev.message}`));
    });

    ws.addEventListener("error", () => reject(new Error("socket error")));
    setTimeout(finish, 45000);
  });
}

/** PCM16 mono -> WAV. */
function wav(pcm, rate = RATE) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const script = JSON.parse(readFileSync(join(ROOT, "video", "script.json"), "utf8"));
mkdirSync(OUT, { recursive: true });

const manifest = [];
for (const scene of script.scenes) {
  const file = join(OUT, `${scene.id}.wav`);
  if (!existsSync(file)) {
    process.stdout.write(`  ${scene.id} … `);
    const pcm = await speak(scene.say);
    writeFileSync(file, wav(pcm));
    process.stdout.write(`${(pcm.length / 2 / RATE).toFixed(1)}s\n`);
  }
  const bytes = readFileSync(file).length - 44;
  manifest.push({ id: scene.id, seconds: bytes / 2 / RATE });
}

writeFileSync(join(ROOT, "video", "durations.json"), JSON.stringify(manifest, null, 2));
const total = manifest.reduce((s, m) => s + m.seconds, 0);
console.log(`\n${manifest.length} lines, ${total.toFixed(1)}s of narration (voice: ${VOICE})`);
