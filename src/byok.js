/**
 * Browser-supplied API keys (BYOK) for hosted deployments.
 *
 * On Vercel there is no writable .env and no single-owner server process: each
 * visitor can paste their own keys into the POWER UP panel. Those keys stay in
 * that browser's localStorage and are attached to that visitor's /api calls in
 * the `x-gev-byok` header. The API function applies them only for the lifetime
 * of the request, so one visitor's credentials never reach another's.
 *
 * Google Maps and Cesium ion are browser-side by design; their values are also
 * published on window so the existing runtime override paths pick them up.
 */

import { knownKeySetupEnvVars } from './keySetupCore.mjs';

const STORAGE_KEY = 'gev.byok.keys.v1';
const ALLOWED = knownKeySetupEnvVars();

/** Read this browser's keys. Never throws (storage can be disabled). */
export function readByok() {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean = {};
    for (const name of ALLOWED) {
      const value = parsed[name];
      if (typeof value === 'string' && value.trim()) clean[name] = value.trim();
    }
    return clean;
  } catch {
    return {};
  }
}

/** Merge validated updates; a null value removes that key from this browser. */
export function saveByokKeys(updates) {
  const next = readByok();
  for (const [name, raw] of Object.entries(updates || {})) {
    if (!ALLOWED.has(name)) continue;
    if (raw === null) {
      delete next[name];
      continue;
    }
    const value = String(raw ?? '').trim();
    if (value) next[name] = value;
  }
  try {
    if (Object.keys(next).length) globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Storage denied: keys still work for this page session via memory.
  }
  return next;
}

/** Serialized header value, or '' when this browser has no keys. */
export function byokHeaderValue() {
  const values = readByok();
  return Object.keys(values).length ? JSON.stringify(values) : '';
}

/** Publish browser-side keys where the app already looks for overrides. */
export function applyByokClientKeys() {
  const values = readByok();
  if (values.GOOGLE_MAPS_API_KEY) globalThis.__GOOGLE_MAPS_API_KEY__ = values.GOOGLE_MAPS_API_KEY;
  if (values.CESIUM_ION_TOKEN) globalThis.__CESIUM_ION_TOKEN__ = values.CESIUM_ION_TOKEN;
}

/** Add the BYOK header to same-origin /api requests only, once. */
export function installByokFetch() {
  if (globalThis.__gevByokFetchInstalled) return;
  const original = globalThis.fetch?.bind(globalThis);
  if (!original) return;
  globalThis.__gevByokFetchInstalled = true;

  globalThis.fetch = (input, init = {}) => {
    let url;
    try {
      url = new URL(
        typeof input === 'string' || input instanceof URL ? String(input) : input?.url || '',
        globalThis.location?.href || 'http://localhost/',
      );
    } catch {
      return original(input, init);
    }
    if (url.origin !== globalThis.location?.origin || !url.pathname.startsWith('/api/')) {
      return original(input, init);
    }
    const header = byokHeaderValue();
    if (!header) return original(input, init);

    const headers = new Headers(init.headers || input?.headers || {});
    if (!headers.has('x-gev-byok')) headers.set('x-gev-byok', header);
    return original(input, { ...init, headers });
  };
}

/** Overlay browser-supplied keys onto the server's key-status payload. */
export function mergeByokStatus(status) {
  const values = readByok();
  const keys = (status?.keys || []).map((key) => {
    const browserSet = (key.envVars || []).every((name) => Boolean(values[name]));
    if (!browserSet) return key;
    return { ...key, set: true, managed: 'browser' };
  });
  return {
    ...status,
    keys,
    setCount: keys.filter((key) => key.set).length,
    total: keys.length || status?.total || 0,
  };
}
