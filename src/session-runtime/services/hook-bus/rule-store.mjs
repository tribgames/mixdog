/**
 * hook-bus/rule-store.mjs — the legacy before-tool rule file: cached reads
 * keyed by file stamp, add / delete, and enabled toggles that are reflected
 * immediately and published together after a short debounce.
 */
import { applyHookRulePatches, hookFileStamp, readHookDocument, updateHookRules } from './rule-file.mjs';
import { normalizeRules } from './config.mjs';
import { summarizeRule } from './rules.mjs';

// Reflect toggles immediately, then publish their field updates together.
const RULES_SAVE_DEBOUNCE_MS = 400;
const RULE_ACTIONS = ['allow', 'deny', 'block', 'modify', 'rewrite', 'ask'];

const trimmedOrNull = (value) => (value != null && String(value).trim() ? String(value).trim() : null);
const plainObjectOrNull = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);

function ruleFromInput(rule) {
  const action = String(rule.action || rule.decision || '')
    .trim()
    .toLowerCase();
  if (!action || !RULE_ACTIONS.includes(action)) {
    throw new Error('hook rule action must be allow, deny, block, modify, rewrite, or ask');
  }
  const next = {
    tool: rule.tool || rule.name || '*',
    action,
    enabled: rule.enabled !== false,
  };
  for (const field of ['match', 'cwd', 'reason']) {
    const value = trimmedOrNull(rule[field]);
    if (value) next[field] = value;
  }
  for (const field of ['patch', 'args']) {
    const value = plainObjectOrNull(rule[field]);
    if (value) next[field] = value;
  }
  return next;
}

export function createRuleStore({ rulesPath, emit, onRulesSaved }) {
  let rulesCache = { stamp: null, rules: [] };
  let pendingRulePatches = null;
  let rulesSaveTimer = null;

  function loadRules() {
    const stamp = rulesPath ? hookFileStamp(rulesPath) : null;
    if (stamp === null) {
      rulesCache = { stamp: null, rules: [] };
      return rulesCache.rules;
    }
    if (rulesCache.stamp === stamp) return rulesCache.rules;
    const parsed = readHookDocument(rulesPath);
    rulesCache = {
      stamp,
      rules: applyHookRulePatches(
        normalizeRules(parsed).filter((rule) => rule && typeof rule === 'object'),
        pendingRulePatches,
        { strict: false }
      ),
    };
    return rulesCache.rules;
  }

  function listRules() {
    return loadRules().map((rule, index) => summarizeRule(rule, index));
  }

  function saveRules(update) {
    if (!rulesPath) throw new Error('hooks rules path is not configured');
    rulesCache = updateHookRules(rulesPath, update);
    onRulesSaved();
    return listRules();
  }

  function flushRules() {
    if (rulesSaveTimer) {
      clearTimeout(rulesSaveTimer);
      rulesSaveTimer = null;
    }
    if (!pendingRulePatches || pendingRulePatches.size === 0) {
      pendingRulePatches = null;
      return;
    }
    const patches = pendingRulePatches;
    try {
      saveRules((rules) => applyHookRulePatches(rules, patches));
      pendingRulePatches = null;
    } catch (error) {
      emit('hook:error', { error: `debounced hooks save failed: ${error?.message || error}` });
      throw error;
    }
  }

  function scheduleRulesSave() {
    if (rulesSaveTimer) clearTimeout(rulesSaveTimer);
    rulesSaveTimer = setTimeout(() => {
      // The error is recorded by flushRules; retain the patch for an explicit
      // retry rather than crashing a timer callback or silently dropping it.
      try {
        flushRules();
      } catch {}
    }, RULES_SAVE_DEBOUNCE_MS);
    rulesSaveTimer.unref?.();
  }

  function addRule(rule = {}) {
    // Same index-safety rule as deleteRule: settle debounced toggles first.
    flushRules();
    const next = ruleFromInput(rule);
    return saveRules((rules) => [...rules, next]);
  }

  function setRuleEnabled(index, enabled) {
    const rules = [...loadRules()];
    if (!Number.isInteger(index) || index < 0 || index >= rules.length)
      throw new Error(`hook rule not found: ${index}`);
    const nextEnabled = enabled !== false;
    const baseRule = rules[index];
    rules[index] = { ...rules[index], enabled: nextEnabled };
    rulesCache = { ...rulesCache, rules };
    onRulesSaved();
    if (!pendingRulePatches) pendingRulePatches = new Map();
    pendingRulePatches.set(index, { baseRule, enabled: nextEnabled });
    scheduleRulesSave();
    return listRules();
  }

  function deleteRule(index) {
    // Pending enabled-state patches are addressed by INDEX. Flushing them
    // before the splice keeps a debounced toggle from landing on whatever rule
    // shifted into that slot after the delete.
    flushRules();
    return saveRules((rules) => {
      if (!Number.isInteger(index) || index < 0 || index >= rules.length)
        throw new Error(`hook rule not found: ${index}`);
      return rules.filter((_, current) => current !== index);
    });
  }

  return {
    loadRules,
    listRules,
    addRule,
    deleteRule,
    setRuleEnabled,
    flushRules,
    pendingPatches: () => pendingRulePatches,
  };
}
