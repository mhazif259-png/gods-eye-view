/**
 * Vercel catch-all API function.
 *
 * The application's API surface lives in vite.config.js as dev-server
 * middleware. Rather than duplicating ~7,700 lines of proxy logic, this
 * function boots the same config in Vite's middleware mode and forwards
 * /api/* requests to it. Serverless functions cannot write the repo checkout,
 * so caches are redirected to the OS temp directory.
 *
 * The in-app POWER UP panel also has a browser-supplied-key (BYOK) mode here:
 * keys travel in the `x-gev-byok` header on the visitor's own requests and are
 * applied to process.env only for the lifetime of that request. Nothing is
 * written to disk and no key is shared between visitors.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import {
  keySetupStatus,
  knownKeySetupEnvVars,
  validateKeySetupUpdates,
} from '../src/keySetupCore.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Find the checkout that contains vite.config.js. */
function resolveProjectRoot() {
  const candidates = [
    path.resolve(HERE, '..'),
    process.cwd(),
    path.resolve(process.cwd(), 'gods-eye-view-main'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'vite.config.js'))) return candidate;
  }
  return path.resolve(HERE, '..');
}

const ROOT = resolveProjectRoot();
const CONFIG_FILE = path.join(ROOT, 'vite.config.js');
const ALLOWED_ENV_VARS = knownKeySetupEnvVars();

/** @type {Promise<import('vite').ViteDevServer>|null} */
let vitePromise = null;

async function getVite() {
  if (!vitePromise) {
    const tmp = os.tmpdir();
    // Keep cwd at the checkout: the CCTV config loader reads local JSON files
    // relative to it. Disk-cache writes fail closed on Vercel's read-only fs,
    // and every cache writer in vite.config.js catches that failure.
    // AISStream needs a long-lived WebSocket, so never try to open one here.
    delete process.env.AISSTREAM_API_KEY;
    vitePromise = createServer({
      root: ROOT,
      configFile: CONFIG_FILE,
      cacheDir: path.join(tmp, 'gev-vite-cache'),
      appType: 'custom',
      logLevel: 'silent',
      server: { middlewareMode: true },
    }).catch((error) => {
      vitePromise = null;
      throw error;
    });
  }
  return vitePromise;
}

/**
 * Parse the visitor's BYOK header. Unknown names and oversized values are
 * ignored; the browser has no way to read another visitor's keys.
 */
function readByok(req) {
  const raw = req.headers['x-gev-byok'];
  if (typeof raw !== 'string' || raw.length > 8192) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const clean = {};
  for (const name of ALLOWED_ENV_VARS) {
    const value = parsed[name];
    if (typeof value === 'string' && value.trim() && value.length <= 512) {
      clean[name] = value.trim();
    }
  }
  return clean;
}

/** Apply BYOK values for one request and restore the previous env on finish. */
function applyByok(req, res, values) {
  const names = Object.keys(values);
  if (!names.length) return;
  const previous = names.map((name) => [name, process.env[name]]);
  for (const name of names) process.env[name] = values[name];

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  res.once('finish', restore);
  res.once('close', restore);
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function setupStatusPayload(values) {
  const merged = { ...process.env, ...values };
  return { ...keySetupStatus(merged), store: 'browser', hosted: true };
}

/**
 * Provider Settings runs loopback-only inside the dev server. On a public
 * deployment that gate must stay closed; instead these two routes describe and
 * accept keys for the visitor's browser only.
 */
async function handleSetup(req, res, values) {
  const url = new URL(req.url || '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/setup/')) return false;

  if (url.pathname === '/api/setup/status' && req.method === 'GET') {
    sendJson(res, 200, setupStatusPayload(values));
    return true;
  }

  if (url.pathname === '/api/setup/keys' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const result = validateKeySetupUpdates(body);
    if (!result.ok) {
      sendJson(res, 400, { ok: false, error: result.error });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      saved: Object.keys(result.updates),
      status: setupStatusPayload(values),
    });
    return true;
  }

  sendJson(res, 404, { ok: false, error: 'Unknown setup route' });
  return true;
}

export default async function handler(req, res) {
  const byok = readByok(req);
  applyByok(req, res, byok);

  const url = new URL(req.url || '/', 'http://localhost');
  const route = url.pathname;

  // These routes depend on a long-lived process or a writable filesystem.
  // Fail clearly instead of letting a function time out or throw.
  if (route.startsWith('/api/ais-live')) {
    sendJson(res, 503, {
      error: 'AISStream requires a persistent WebSocket and is not available on serverless hosting',
    });
    return;
  }
  if (route === '/api/realtime/debug-log') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (route.startsWith('/api/cctv/media/')) {
    sendJson(res, 503, {
      error: 'Live camera media streaming is not available on serverless hosting; use /api/cctv/frame',
    });
    return;
  }

  if (await handleSetup(req, res, byok)) return;

  const vite = await getVite();
  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    res.once('finish', done);
    res.once('close', done);
    vite.middlewares(req, res, () => {
      if (!res.headersSent) {
        res.statusCode = 404;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
      }
      res.end('Not found');
      done();
    });
  });
}
