/**
 * Minimal stand-ins for the two Vite exports vite.config.js needs when it is
 * loaded by the Vercel API function. This avoids importing Vite/Rollup (and
 * its platform-specific native binary) into the serverless bundle.
 */

/** Vite's defineConfig is identity for a function or an object. */
export function defineConfig(value) {
  return value;
}

/** The deployment supplies provider values via Vercel environment settings. */
export function loadEnv() {
  return {};
}

export default { defineConfig, loadEnv };
