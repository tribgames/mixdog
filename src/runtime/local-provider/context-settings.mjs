import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { resolvePluginData } from '../shared/plugin-paths.mjs';
import { writeJsonAtomicSync } from '../shared/atomic-file.mjs';

// Agent sessions carry tool schemas and a system prompt before any dialogue,
// so a smaller window cannot hold one turn. New installs default higher.
export const LOCAL_CONTEXT_MIN_TOKENS = 16_384;
export const LOCAL_CONTEXT_DEFAULT_TOKENS = 32_768;

const settingsPath = (id, dataDir) =>
  join(dataDir, 'local-provider', 'context', `${createHash('sha256').update(id).digest('hex')}.json`);

export function validateLocalContext(entry, value) {
  const maximum = entry.maxContextWindow || entry.contextWindow;
  if (value !== null && (!Number.isSafeInteger(value) || value < LOCAL_CONTEXT_MIN_TOKENS || value > maximum)) {
    throw new TypeError(`Context size must be an integer from ${LOCAL_CONTEXT_MIN_TOKENS} to ${maximum} tokens.`);
  }
  return value;
}

export function localContextSettings(entry, dataDir = resolvePluginData()) {
  let configured = null;
  try {
    configured = validateLocalContext(entry, JSON.parse(readFileSync(settingsPath(entry.id, dataDir), 'utf8')).tokens);
  } catch (error) {
    // Absent, corrupt (SyntaxError) or out-of-range (TypeError) settings all
    // fall back to the model default; an I/O failure still surfaces.
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
  }
  const maximum = entry.maxContextWindow || entry.contextWindow;
  // Models registered under the old 512-token floor run at the agent minimum.
  const defaultContextWindow = Math.max(entry.contextWindow, Math.min(LOCAL_CONTEXT_MIN_TOKENS, maximum));
  return {
    configuredContextWindow: configured,
    defaultContextWindow,
    minContextWindow: LOCAL_CONTEXT_MIN_TOKENS,
    maxContextWindow: maximum,
    contextWindow: configured ?? defaultContextWindow,
    runtimeContextWindow: configured ?? defaultContextWindow,
  };
}

export function saveLocalContext(entry, value, dataDir = resolvePluginData()) {
  validateLocalContext(entry, value);
  writeJsonAtomicSync(settingsPath(entry.id, dataDir), { tokens: value });
}
