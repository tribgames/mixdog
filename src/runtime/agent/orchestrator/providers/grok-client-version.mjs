import { createNpmVersionSource, maxSemver } from './npm-cli-version.mjs';

// Grok CLI client version for the cli-chat-proxy version gate (HTTP 426).
// Effective = env override, else max(floor, learned-from-426, live npm latest
// of the official @xai-official/grok CLI).
export const GROK_CLI_VERSION_FLOOR = '1.0.50';
export const GROK_CLI_NPM_PACKAGE = '@xai-official/grok';

const live = createNpmVersionSource(GROK_CLI_NPM_PACKAGE, { persistKey: 'grok-cli' });
let envVersion;
let learned = null;

function envOverride() {
  if (envVersion === undefined) envVersion = String(process.env.MIXDOG_GROK_CLIENT_VERSION || '').trim();
  return envVersion;
}

/** Sync, never blocks: the version proxy/usage requests must send. */
export function grokCliVersion() {
  return envOverride() || maxSemver(GROK_CLI_VERSION_FLOOR, learned, live.sync());
}

/** Await before the first proxy/usage call so a cold start never sends the floor. */
export async function warmGrokCliVersion() {
  if (!envOverride()) await live.warm();
}

/** Learn a minimum stated in a 426 body; returns true when it raised the version. */
export function learnGrokRequiredVersion(text) {
  const m = String(text || '').match(/(?:minimum|required|at least|>=|newer than|upgrade to)\D{0,40}?(\d+\.\d+\.\d+)/i);
  const required = m && maxSemver(m[1]);
  if (!required || envOverride()) return false;
  const before = grokCliVersion();
  if (maxSemver(before, required) === before) return false;
  learned = required;
  return true;
}

export function grokClientVersionHeaders() {
  const v = grokCliVersion();
  return { 'x-grok-client-version': v, 'User-Agent': `xai-grok-build/${v}` };
}
