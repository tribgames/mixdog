import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { resolvePluginData } from '../shared/plugin-paths.mjs';
import { writeJsonAtomicSync } from '../shared/atomic-file.mjs';

const settingsPath = (id, dataDir) => join(dataDir, 'local-provider', 'context',
  `${createHash('sha256').update(id).digest('hex')}.json`);

export function validateLocalContext(entry, value) {
  const maximum = entry.maxContextWindow || entry.contextWindow;
  if (value !== null && (!Number.isSafeInteger(value) || value < 512 || value > maximum)) {
    throw new TypeError(`Context size must be an integer from 512 to ${maximum} tokens.`);
  }
  return value;
}

export function localContextSettings(entry, dataDir = resolvePluginData()) {
  let configured = null;
  try {
    configured = validateLocalContext(entry, JSON.parse(readFileSync(settingsPath(entry.id, dataDir), 'utf8')).tokens);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return {
    configuredContextWindow: configured,
    defaultContextWindow: entry.contextWindow,
    maxContextWindow: entry.maxContextWindow || entry.contextWindow,
    contextWindow: configured ?? entry.contextWindow,
    runtimeContextWindow: configured ?? entry.contextWindow,
  };
}

export function saveLocalContext(entry, value, dataDir = resolvePluginData()) {
  validateLocalContext(entry, value);
  writeJsonAtomicSync(settingsPath(entry.id, dataDir), { tokens: value });
}
