/**
 * hook-bus/tool-gate.mjs — the before-tool decision: standard PreToolUse
 * handlers first (deny / ask / modify), then the legacy rule file. Every
 * outcome is mirrored into the observer log as a tool:* event.
 */
import { throwIfAborted } from '../../runtime/shared/abort-race.mjs';
import { buildEventPayload } from './config.mjs';
import { decisionFromRule, ruleMatches } from './rules.mjs';

const identityOf = (input) => ({
  sessionId: input.sessionId || input.session_id || null,
  name: input.name || input.tool_name || 'tool',
});

const legacySubject = (input) => ({
  name: input.name || input.tool_name,
  args: input.args || input.tool_input,
  cwd: input.cwd,
});

export function createToolGate({ loadConfig, loadRules, runEventHandlers, emit, cursor }) {
  function standardDecision(agg, input) {
    if (agg.blocked) {
      emit('tool:deny', { ...identityOf(input), reason: agg.reason });
      return { action: 'deny', reason: agg.reason };
    }
    if (!(agg.ask || agg.updatedInput || agg.updatedToolName)) return null;
    const action = agg.ask ? 'ask' : 'modify';
    const reason = agg.ask ? agg.askReason : agg.reason;
    emit(`tool:${action}`, { ...identityOf(input), reason });
    return {
      action,
      ...(agg.updatedInput ? { args: agg.updatedInput } : {}),
      ...(agg.updatedToolName ? { name: agg.updatedToolName } : {}),
      reason,
    };
  }

  function legacyDecision(cfg, input) {
    const rules = Array.isArray(cfg.legacyRules) && cfg.legacyRules.length ? cfg.legacyRules : loadRules();
    const subject = legacySubject(input);
    const rule = rules.find((candidate) => ruleMatches(candidate, subject));
    if (!rule) return null;
    const decision = decisionFromRule(rule, subject);
    if (decision.action === 'deny' || decision.action === 'modify' || decision.action === 'ask') {
      emit(`tool:${decision.action}`, { ...identityOf(input), reason: decision.reason });
    }
    return decision;
  }

  return async function beforeTool(input = {}, { signal } = {}) {
    throwIfAborted(signal);
    if (input?.cwd) cursor.cwd = input.cwd;
    emit('tool:before', {
      ...identityOf(input),
      callId: input.toolCallId || input.callId || input.tool_use_id || null,
      args: input.args || input.tool_input || null,
    });
    try {
      const cfg = loadConfig(input.cwd || cursor.cwd);
      if (cfg.disabled) return null;
      const payload = buildEventPayload('PreToolUse', input);
      const agg = await runEventHandlers('PreToolUse', payload, { signal });
      throwIfAborted(signal);
      return standardDecision(agg, input) ?? legacyDecision(cfg, input);
    } catch (error) {
      throwIfAborted(signal);
      emit('hook:error', { name: input.name || input.tool_name || 'tool', error: error?.message || String(error) });
      return null;
    }
  };
}
