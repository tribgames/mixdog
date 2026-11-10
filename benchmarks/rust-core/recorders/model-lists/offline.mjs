// Preloaded into the recorded Node processes (NODE_OPTIONS=--import): a fetch of the catalogs the model lists read fails,
// as it does offline. Node fetches models.dev and LiteLLM at startup whatever the disk holds and falls back to the disk
// copy only when that fetch fails, so this is what makes the seeded copies the ones a recording uses (and keeps the update
// check off the network). Other fetches (the daemon's own assets) are left alone.
const BLOCKED = new Set(['models.dev', 'raw.githubusercontent.com', 'registry.npmjs.org', 'generativelanguage.googleapis.com', 'api.anthropic.com']);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (BLOCKED.has(url.hostname)) return Promise.reject(new TypeError(`offline: ${url.hostname}`));
  return realFetch(input, init);
};

// The id a saved custom provider gets is `custom-${randomUUID()}` (provider-admin.mjs saveCustomProvider), so two recordings of
// the same calls differ in it. Only that caller gets a counted id; every other randomUUID stays random.
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
const realUUID = crypto.randomUUID;
let providerIds = 0;
crypto.randomUUID = (...args) =>
  /provider-admin\.mjs/.test(new Error().stack ?? '')
    ? `00000000-0000-4000-8000-${String(++providerIds).padStart(12, '0')}`
    : realUUID.apply(crypto, args);
syncBuiltinESMExports();
