import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const DEFAULT_EVENTS = Object.freeze([
  'runtime:start',
  'session:create',
  'turn:start',
  'turn:end',
  'turn:error',
  'tool:planned',
  'tool:before',
  'tool:deny',
  'tool:modify',
  'hook:error',
]);

function compactValue(value) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > 180 ? `${value.slice(0, 180)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 8).map(compactValue);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value).slice(0, 12)) {
      if (/token|secret|key|password/i.test(key)) {
        out[key] = '<redacted>';
      } else {
        out[key] = compactValue(val);
      }
    }
    return out;
  }
  return String(value);
}

function summarizePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return String(payload ?? '');
  const parts = [];
  if (payload.sessionId) parts.push(`session=${payload.sessionId}`);
  if (payload.name) parts.push(`name=${payload.name}`);
  if (payload.provider || payload.model) parts.push([payload.provider, payload.model].filter(Boolean).join('/'));
  if (payload.prompt) parts.push(`prompt=${String(payload.prompt).slice(0, 60).replace(/\s+/g, ' ')}`);
  if (payload.reason) parts.push(`reason=${String(payload.reason).slice(0, 120)}`);
  if (payload.error) parts.push(`error=${String(payload.error).slice(0, 120)}`);
  if (payload.elapsedMs != null) parts.push(`${payload.elapsedMs}ms`);
  return parts.join(' · ');
}

function hookRulesPath(dataDir) {
  if (process.env.MIXDOG_HOOKS_FILE) return resolve(process.env.MIXDOG_HOOKS_FILE);
  return dataDir ? join(dataDir, 'hooks.json') : null;
}

function normalizeRules(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.toolBefore)) return raw.toolBefore;
  if (Array.isArray(raw?.beforeTool)) return raw.beforeTool;
  if (Array.isArray(raw?.hooks?.toolBefore)) return raw.hooks.toolBefore;
  return [];
}

function matchesList(pattern, value) {
  if (pattern == null || pattern === '*' || pattern === 'all') return true;
  const items = Array.isArray(pattern) ? pattern : [pattern];
  return items.some((item) => {
    const text = String(item || '').trim();
    if (!text || text === '*' || text === 'all') return true;
    if (text.endsWith('*')) return String(value || '').startsWith(text.slice(0, -1));
    return text === String(value || '');
  });
}

function ruleMatches(rule, input) {
  if (!rule || typeof rule !== 'object' || rule.enabled === false) return false;
  const toolPattern = rule.tool ?? rule.name ?? rule.tools;
  if (!matchesList(toolPattern, input.name)) return false;
  if (rule.cwd && !String(input.cwd || '').includes(String(rule.cwd))) return false;
  const match = rule.match ?? rule.contains;
  if (match != null) {
    const haystack = JSON.stringify({ args: input.args ?? null, cwd: input.cwd ?? null });
    const needles = Array.isArray(match) ? match : [match];
    if (!needles.some((needle) => haystack.includes(String(needle)))) return false;
  }
  return true;
}

function decisionFromRule(rule, input) {
  const action = String(rule.action || rule.decision || 'allow').toLowerCase();
  if (action === 'deny' || action === 'block') {
    return { action: 'deny', reason: rule.reason || rule.message || `blocked by hook rule for ${input.name}` };
  }
  if (action === 'modify' || action === 'rewrite') {
    const nextArgs = rule.args && typeof rule.args === 'object'
      ? rule.args
      : { ...(input.args || {}), ...(rule.patch || {}) };
    return { action: 'modify', args: nextArgs, reason: rule.reason || rule.message || `modified by hook rule for ${input.name}` };
  }
  return { action: 'allow', reason: rule.reason || rule.message || null };
}

function summarizeRule(rule, index) {
  return {
    index,
    enabled: rule.enabled !== false,
    tool: rule.tool ?? rule.name ?? rule.tools ?? '*',
    action: rule.action || rule.decision || 'allow',
    match: rule.match ?? rule.contains ?? null,
    cwd: rule.cwd || null,
    reason: rule.reason || rule.message || null,
    patch: compactValue(rule.patch || rule.args || null),
  };
}

export function createStandaloneHookBus({ maxEvents = 80, dataDir = null } = {}) {
  const recent = [];
  const counts = new Map(DEFAULT_EVENTS.map((name) => [name, 0]));
  const rulesPath = hookRulesPath(dataDir);
  let rulesCache = { mtimeMs: -1, rules: [] };

  function emit(name, payload = {}) {
    const eventName = String(name || '').trim();
    if (!eventName) return null;
    counts.set(eventName, (counts.get(eventName) || 0) + 1);
    const entry = {
      ts: new Date().toISOString(),
      name: eventName,
      summary: summarizePayload(payload),
      payload: compactValue(payload),
    };
    recent.push(entry);
    while (recent.length > maxEvents) recent.shift();
    return entry;
  }

  function loadRules() {
    if (!rulesPath || !existsSync(rulesPath)) {
      rulesCache = { mtimeMs: -1, rules: [] };
      return rulesCache.rules;
    }
    const stat = statSync(rulesPath);
    if (rulesCache.mtimeMs === stat.mtimeMs) return rulesCache.rules;
    const parsed = JSON.parse(readFileSync(rulesPath, 'utf8'));
    rulesCache = {
      mtimeMs: stat.mtimeMs,
      rules: normalizeRules(parsed).filter((rule) => rule && typeof rule === 'object'),
    };
    return rulesCache.rules;
  }

  function saveRules(rules) {
    if (!rulesPath) throw new Error('hooks rules path is not configured');
    mkdirSync(dirname(rulesPath), { recursive: true });
    const cleanRules = Array.isArray(rules) ? rules.filter((rule) => rule && typeof rule === 'object') : [];
    writeFileSync(rulesPath, `${JSON.stringify({ toolBefore: cleanRules }, null, 2)}\n`, 'utf8');
    const stat = statSync(rulesPath);
    rulesCache = { mtimeMs: stat.mtimeMs, rules: cleanRules };
    return listRules();
  }

  function listRules() {
    return loadRules().map((rule, index) => summarizeRule(rule, index));
  }

  function addRule(rule = {}) {
    const action = String(rule.action || rule.decision || '').trim().toLowerCase();
    if (!action || !['allow', 'deny', 'block', 'modify', 'rewrite'].includes(action)) {
      throw new Error('hook rule action must be allow, deny, block, modify, or rewrite');
    }
    const next = {
      tool: rule.tool || rule.name || '*',
      action,
      enabled: rule.enabled !== false,
    };
    if (rule.match != null && String(rule.match).trim()) next.match = String(rule.match).trim();
    if (rule.cwd != null && String(rule.cwd).trim()) next.cwd = String(rule.cwd).trim();
    if (rule.reason != null && String(rule.reason).trim()) next.reason = String(rule.reason).trim();
    if (rule.patch && typeof rule.patch === 'object' && !Array.isArray(rule.patch)) next.patch = rule.patch;
    if (rule.args && typeof rule.args === 'object' && !Array.isArray(rule.args)) next.args = rule.args;
    const rules = [...loadRules(), next];
    return saveRules(rules);
  }

  function setRuleEnabled(index, enabled) {
    const rules = [...loadRules()];
    if (!Number.isInteger(index) || index < 0 || index >= rules.length) throw new Error(`hook rule not found: ${index}`);
    rules[index] = { ...rules[index], enabled: enabled !== false };
    return saveRules(rules);
  }

  function deleteRule(index) {
    const rules = [...loadRules()];
    if (!Number.isInteger(index) || index < 0 || index >= rules.length) throw new Error(`hook rule not found: ${index}`);
    rules.splice(index, 1);
    return saveRules(rules);
  }

  async function beforeTool(input = {}) {
    emit('tool:before', {
      sessionId: input.sessionId || null,
      name: input.name || 'tool',
      callId: input.toolCallId || input.callId || null,
      args: input.args || null,
    });
    try {
      const rules = loadRules();
      const rule = rules.find((candidate) => ruleMatches(candidate, input));
      if (!rule) return null;
      const decision = decisionFromRule(rule, input);
      if (decision.action === 'deny') {
        emit('tool:deny', { sessionId: input.sessionId || null, name: input.name || 'tool', reason: decision.reason });
      } else if (decision.action === 'modify') {
        emit('tool:modify', { sessionId: input.sessionId || null, name: input.name || 'tool', reason: decision.reason });
      }
      return decision;
    } catch (error) {
      emit('hook:error', { name: input.name || 'tool', error: error?.message || String(error) });
      return null;
    }
  }

  function status() {
    let ruleCount = rulesCache.rules.length;
    let rules = [];
    try {
      rules = listRules();
      ruleCount = rules.length;
    } catch (error) {
      emit('hook:error', { error: error?.message || String(error) });
    }
    return {
      enabled: true,
      mode: 'standalone-executable',
      rulesPath,
      ruleCount,
      rules,
      events: [...new Set([...DEFAULT_EVENTS, ...counts.keys()])],
      counts: Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
      recent: [...recent].reverse(),
      note: ruleCount > 0
        ? 'Before-tool hook rules are active. Rules may allow, deny, or modify tool arguments.'
        : 'No hook rules configured; lifecycle and tool events are recorded in observer mode.',
    };
  }

  return { addRule, beforeTool, deleteRule, emit, listRules, setRuleEnabled, status };
}
