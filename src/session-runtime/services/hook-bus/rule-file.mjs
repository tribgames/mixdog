import { readFileSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  holdsNoData,
  parseJsonText,
  readJsonStateSync,
  updateJsonAtomicSync,
} from '../../../runtime/shared/atomic-file.mjs';
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

// The hooks document at `path`, or null when it is missing or damaged (empty,
// NUL-filled after a crash, or not JSON). A damaged file must not turn every
// tool call into a policy-check failure, and must not silently drop the deny
// rules of a good copy: with `restore` (the rules file this module writes with
// a `.bak`), a valid `<path>.bak` is restored and read — the damaged bytes are
// kept aside as `<path>.corrupt-<ts>`. Without a good copy the file stays in
// place (a hand-edit can still fix it) and `onDamaged(error)` reports it; the
// caller then has no rules from it. Hooks files the user or a plugin owns are
// read with `restore: false`: never moved, locked or replaced. Real I/O errors
// still throw.
export function readHookDocument(path, { restore = true, onDamaged } = {}) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
  let damage;
  if (holdsNoData(text)) {
    damage = new SyntaxError('the file holds no data (empty or NUL-filled)');
  } else {
    try {
      return parseJsonText(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      damage = error;
    }
  }
  if (restore) {
    const restored = readJsonStateSync(path, { fallback: null, keepWithoutBackup: true });
    if (restored !== null) return restored;
  }
  onDamaged?.(damage);
  return null;
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
  let next;
  // A damaged file is kept aside as <path>.corrupt-<ts> (its last good copy
  // <path>.bak restored) before the update, never overwritten.
  updateJsonAtomicSync(
    path,
    (document) => {
      const rules = normalizeRules(document).filter((rule) => rule && typeof rule === 'object');
      next = update(rules);
      return replaceRules(document, next);
    },
    { backup: true }
  );
  return { stamp: hookFileStamp(path), rules: next };
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
