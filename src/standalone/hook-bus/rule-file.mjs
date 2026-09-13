import { readFileSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { writeJsonAtomicSync } from '../../runtime/shared/atomic-file.mjs';
import { withFileLockSync } from '../../runtime/shared/file-lock.mjs';
import { normalizeRules } from './config.mjs';

export function hookFileStamp(path) {
  try {
    const st = statSync(path, { bigint: true });
    return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].join(':');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

export function readHookDocument(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

function replaceRules(document, rules) {
  if (Array.isArray(document)) return rules;
  const selected = normalizeRules(document);
  // Keep the existing supported container. normalizeRules owns precedence;
  // array identity identifies the container it actually selected.
  if (selected === document?.beforeTool) return { ...document, beforeTool: rules };
  if (selected === document?.hooks?.toolBefore) {
    return { ...document, hooks: { ...document.hooks, toolBefore: rules } };
  }
  return { ...(document && typeof document === 'object' ? document : {}), toolBefore: rules };
}

export function updateHookRules(path, update) {
  return withFileLockSync(`${path}.lock`, () => {
    const document = readHookDocument(path);
    const rules = normalizeRules(document).filter((rule) => rule && typeof rule === 'object');
    const next = update(rules);
    writeJsonAtomicSync(path, replaceRules(document, next), { lock: false });
    return { stamp: hookFileStamp(path), rules: next };
  });
}

export function applyHookRulePatches(rules, patches, { strict = true } = {}) {
  const next = [...rules];
  for (const [index, patch] of patches || []) {
    const current = next[index];
    const { enabled: _baseEnabled, ...base } = patch.baseRule;
    const { enabled: _currentEnabled, ...actual } = current || {};
    if (!current || !isDeepStrictEqual(actual, base)) {
      if (!strict) continue;
      const error = new Error(`hook rule changed before its pending update could be saved: ${index}`);
      error.code = 'HOOK_RULE_CONFLICT';
      throw error;
    }
    next[index] = { ...current, enabled: patch.enabled };
  }
  return next;
}
