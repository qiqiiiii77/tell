#!/usr/bin/env node
/**
 * server.js — static host + token minting. Zero npm dependencies, Node >= 18.
 *
 * The API key never reaches the browser. Both AssemblyAI sockets are opened
 * with short-lived, single-use tokens minted here.
 */

import { createServer } from "node:http";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const RECORDS = join(ROOT, "records");
const PORT = Number(process.env.PORT || 8000);

/* ---------- config ---------- */

function loadEnv() {
  const f = join(ROOT, ".env");
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const API_KEY = process.env.ASSEMBLYAI_API_KEY;
if (!API_KEY) {
  console.error("\n  ASSEMBLYAI_API_KEY is not set.\n  cp .env.example .env and put your key in it.\n");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

/* ---------- token minting ---------- */

async function mint(url, res, label) {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });
    const text = await r.text();
    if (!r.ok) {
      console.error(`[${label}] ${r.status} ${text}`);
      return json(res, r.status, { error: `${label} token failed`, detail: text.slice(0, 300) });
    }
    return json(res, 200, JSON.parse(text));
  } catch (err) {
    console.error(`[${label}]`, err);
    return json(res, 502, { error: `${label} token failed`, detail: String(err?.message || err) });
  }
}

/* ---------- call records ---------- */

async function saveRecord(body, res) {
  await mkdir(RECORDS, { recursive: true });
  const id = `call_${Date.now().toString(36)}`;
  const record = { id, savedAt: new Date().toISOString(), ...body };
  await writeFile(join(RECORDS, `${id}.json`), JSON.stringify(record, null, 2));
  return json(res, 200, { id });
}

async function listRecords(res) {
  if (!existsSync(RECORDS)) return json(res, 200, { records: [] });
  const files = (await readdir(RECORDS)).filter((f) => f.endsWith(".json")).sort().reverse();
  const records = [];
  for (const f of files.slice(0, 50)) {
    try {
      const r = JSON.parse(await readFile(join(RECORDS, f), "utf8"));
      records.push({
        id: r.id, savedAt: r.savedAt,
        patient: r.patient, durationMs: r.durationMs,
        flagged: (r.facts || []).filter((x) => x.flagged).length,
        facts: (r.facts || []).length,
      });
    } catch { /* skip an unreadable record rather than failing the list */ }
  }
  return json(res, 200, { records });
}

/* ---------- static ---------- */

async function serveStatic(pathname, res) {
  const rel = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end("forbidden"); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}

/* ---------- routes ---------- */

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (pathname === "/api/agent-token") {
      const u = new URL("https://agents.assemblyai.com/v1/token");
      u.searchParams.set("expires_in_seconds", "120");
      u.searchParams.set("max_session_duration_seconds", "900");
      return mint(u, res, "agent");
    }

    if (pathname === "/api/stt-token") {
      const u = new URL("https://streaming.assemblyai.com/v3/token");
      u.searchParams.set("expires_in_seconds", "120");
      return mint(u, res, "stt");
    }

    if (pathname === "/api/agent-config") {
      const raw = await readFile(join(ROOT, "agent", "tell.jsonc"), "utf8");
      // Strip // comments so the config can stay annotated on disk.
      const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
      return json(res, 200, JSON.parse(stripped));
    }

    if (pathname === "/api/records" && req.method === "POST") {
      let body = "";
      for await (const c of req) {
        body += c;
        if (body.length > 4e6) { res.writeHead(413).end(); return; }
      }
      return saveRecord(JSON.parse(body || "{}"), res);
    }

    if (pathname === "/api/records") return listRecords(res);

    if (pathname === "/api/health") {
      return json(res, 200, { ok: true, keyLoaded: true });
    }

    return serveStatic(pathname, res);
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Tell — listening on http://localhost:${PORT}\n`);
  console.log("  Ctrl+C to stop. Nothing runs in the background.\n");
});
