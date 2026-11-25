/**
 * Vercel catch-all API function.
 *
 * The application's API surface lives in vite.config.js as dev-server
 * middleware. Rather than duplicating ~7,700 lines of proxy logic, this
 * function loads the same config with lightweight shims, asks every Vite plugin
 * to register its middlewares, and dispatches /api/* requests through them.
 * No Vite/Rollup runtime is needed, so there is no platform-native binary to
 * go missing in the serverless bundle.
 *
 * The in-app POWER UP panel also has a browser-supplied-key (BYOK) mode here:
 * keys travel in the `x-gev-byok` header on the visitor's own requests and are
 * applied to process.env only for the lifetime of that request. Nothing is
 * written to disk and no key is shared between visitors.
 */

import '../server/setup-api-shim.mjs';
import configFactory from '../vite.config.js';
import {
  keySetupStatus,
  knownKeySetupEnvVars,
  validateKeySetupUpdates,
} from '../src/keySetupCore.mjs';

const ALLOWED_ENV_VARS = knownKeySetupEnvVars();
const CONTEXT = { command: 'serve', mode: 'production', isPreview: false };

/** @type {Promise<Array<[string, Function]>>|null} */
let routesPromise = null;

async function buildRoutes() {
  const config = typeof configFactory === 'function' ? configFactory(CONTEXT) : configFactory;
  const routes = [];
  const server = {
    config,
    httpServer: null,
    middlewares: {
      use(prefix, handler) {
        routes.push([prefix, handler]);
      },
    },
  };

  for (const plugin of config?.plugins || []) {
    if (!plugin || typeof plugin !== 'object') continue;
    // The setup panel writes files and restarts Vite; the hosted router
    // handles those two endpoints itself below.
    if (plugin.name === 'gev-key-setup') continue;
    const applies = plugin.apply === undefined
      || plugin.apply === 'serve'
      || (typeof plugin.apply === 'function' && plugin.apply(config, CONTEXT));
    if (!applies || typeof plugin.configureServer !== 'function') continue;
    try {
      await plugin.configureServer(server, CONTEXT);
    } catch (error) {
      // One broken plugin must not take down every other API route.
      console.error(`[API] ${plugin.name || 'plugin'} failed to register:`, error?.message || error);
    }
  }
  return routes;
}

function getRoutes() {
  if (!routesPromise) {
    // AISStream needs a long-lived WebSocket; never open one here.
    delete process.env.AISSTREAM_API_KEY;
    routesPromise = buildRoutes().catch((error) => {
      routesPromise = null;
      throw error;
    });
  }
  return routesPromise;
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

/** Connect-style dispatch over the middlewares collected from Vite plugins. */
function dispatch(req, res, routes) {
  let index = 0;
  const notFound = () => {
    if (res.headersSent) return res.end();
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Not found');
  };
  const next = (error) => {
    if (error) {
      console.error('[API] middleware error:', error?.message || error);
      if (!res.headersSent) sendJson(res, 500, { error: 'API proxy failed' });
      return res.end();
    }
    while (index < routes.length) {
      const [prefix, handler] = routes[index++];
      const current = req.url || '/';
      const pathname = current.split('?')[0];
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;

      const original = req.url;
      req.originalUrl ||= original;
      const suffix = current.slice(prefix.length);
      req.url = suffix.startsWith('/') ? suffix : `/${suffix}`;
      let called = false;
      const localNext = (err) => {
        if (called) return;
        called = true;
        req.url = original;
        next(err);
      };
      try {
        const result = handler(req, res, localNext);
        if (result && typeof result.then === 'function') result.then(() => {}, localNext);
      } catch (err) {
        localNext(err);
      }
      return;
    }
    notFound();
  };
  next();
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

  const routes = await getRoutes();
  dispatch(req, res, routes);
}
