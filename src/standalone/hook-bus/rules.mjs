import { compactValue } from './payload.mjs';
import { defaultShellKind } from './handlers.mjs';

export function matchesList(pattern, value) {
  if (pattern == null || pattern === '*' || pattern === 'all') return true;
  const items = Array.isArray(pattern) ? pattern : [pattern];
  return items.some((item) => {
    const text = String(item || '').trim();
    if (!text || text === '*' || text === 'all') return true;
    if (text.endsWith('*')) return String(value || '').startsWith(text.slice(0, -1));
    return text === String(value || '');
  });
}

export function ruleMatches(rule, input) {
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

export function decisionFromRule(rule, input) {
  const action = String(rule.action || rule.decision || 'allow').toLowerCase();
  if (action === 'deny' || action === 'block') {
    return { action: 'deny', reason: rule.reason || rule.message || `blocked by hook rule for ${input.name}` };
  }
  if (action === 'modify' || action === 'rewrite') {
    const nextArgs = rule.args && typeof rule.args === 'object'
      ? rule.args
      : { ...(input.args || {}), ...(rule.patch || {}) };
    const nextName = rule.updatedToolName ?? rule.replaceTool ?? rule.targetTool;
    return {
      action: 'modify',
      args: nextArgs,
      ...(typeof nextName === 'string' && nextName.trim() ? { name: nextName.trim() } : {}),
      reason: rule.reason || rule.message || `modified by hook rule for ${input.name}`,
    };
  }
  if (action === 'ask') {
    return { action: 'ask', reason: rule.reason || rule.message || `approval requested by hook rule for ${input.name}` };
  }
  return { action: 'allow', reason: rule.reason || rule.message || null };
}

export function summarizeRule(rule, index) {
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

export function handlerDedupeKey(handler) {
  if (!handler || typeof handler !== 'object') return '';
  const ifKey = handler.if != null ? `|if:${JSON.stringify(handler.if)}` : '';
  if (handler.type === 'command') {
    return `command:${handler._pluginRoot || ''}:${handler.command || ''}:${JSON.stringify(handler.args || null)}${ifKey}`;
  }
  if (handler.type === 'http') return `http:${handler.url || ''}${ifKey}`;
  if (handler.type === 'mcp_tool') return `mcp_tool:${handler.server || ''}:${handler.tool || ''}${ifKey}`;
  if (handler.type === 'prompt') return `prompt:${handler.prompt || ''}${ifKey}`;
  return `${handler.type || 'unknown'}:${JSON.stringify(handler)}`;
}

export function shellCountFor(handler) {
  if (handler?.type === 'command') {
    if (handler.args) return 'exec';
    return handler.shell === 'powershell' || handler.shell === 'bash' ? handler.shell : defaultShellKind();
  }
  return handler?.type || 'unknown';
}
