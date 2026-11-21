import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Filenames verified in provider ensureAuth / token paths (resolvePluginData / getPluginData).
export const AUTH_ARTIFACT_BY_PROVIDER = {
  'grok-oauth': ['grok-oauth.json', 'grok-oauth-models.json'],
  'anthropic-oauth': ['anthropic-oauth-credentials.json', 'anthropic-oauth-models.json'],
  'openai-oauth': ['openai-oauth.json', 'openai-oauth-models.json'],
};

export function defaultUserDataDir() {
  return process.env.MIXDOG_DATA_DIR || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
}

export function readUnifiedConfig(dataDir) {
  try {
    const unified = JSON.parse(readFileSync(join(dataDir, 'mixdog-config.json'), 'utf8'));
    return unified && typeof unified === 'object' ? unified : {};
  } catch {
    return {};
  }
}

export function authArtifactNamesForSandbox(realDataDir, provider) {
  const names = new Set();
  for (const file of AUTH_ARTIFACT_BY_PROVIDER[provider] || []) names.add(file);
  try {
    for (const entry of readdirSync(realDataDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (/oauth/i.test(entry.name) || /credentials/i.test(entry.name)) names.add(entry.name);
    }
  } catch {
    /* missing real data dir */
  }
  return [...names];
}

export function copyAuthArtifacts(realDataDir, sandboxDataDir, provider) {
  const copied = [];
  const skipped = [];
  for (const name of authArtifactNamesForSandbox(realDataDir, provider)) {
    const src = join(realDataDir, name);
    const dest = join(sandboxDataDir, name);
    if (!existsSync(src)) {
      skipped.push(name);
      continue;
    }
    try {
      copyFileSync(src, dest);
      copied.push(name);
    } catch {
      skipped.push(name);
    }
  }
  return { copied, skipped };
}

export function extractSessionId(text) {
  const s = String(text || '');
  const m = s.match(/sessionId:\s*(sess_[A-Za-z0-9_]+)/) || s.match(/\b(sess_[A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}
