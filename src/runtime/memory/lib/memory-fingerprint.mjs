import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Plugin version + memory runtime code fingerprint. Extracted from index.mjs
// (behavior-preserving). Callers pass PLUGIN_ROOT so this stays free of any
// entry-point path resolution.

export function readPluginVersion(pluginRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8')).version || '0.0.1';
  } catch {
    return '0.0.1';
  }
}

const MEMORY_FINGERPRINT_ROOTS = ['src/runtime/memory'];

function collectMemoryFingerprintFiles(pluginRoot) {
  const out = [];
  const walk = (relDir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(pluginRoot, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const rel = `${relDir}/${ent.name}`.replace(/\\/g, '/');
      if (ent.isDirectory()) {
        walk(rel);
      } else if (ent.isFile() && rel.endsWith('.mjs')) {
        out.push(rel);
      }
    }
  };
  for (const root of MEMORY_FINGERPRINT_ROOTS) walk(root);
  return out.sort();
}

export function readMemoryCodeFingerprint(pluginRoot) {
  const hash = crypto.createHash('sha256');
  const files = collectMemoryFingerprintFiles(pluginRoot);
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(path.join(pluginRoot, rel)));
    } catch {
      hash.update('missing');
    }
    hash.update('\0');
  }
  return `src/runtime/memory:${files.length}:${hash.digest('hex').slice(0, 16)}`;
}
