/**
 * hook-bus.mjs — the standalone hook bus: an observer log of lifecycle and
 * tool events, the merged hooks configuration, the legacy rule file, the
 * standard-handler runner and the before-tool gate. The pieces live under
 * hook-bus/ (event-log, config-loader, rule-store, event-runner, tool-gate);
 * this wires them around one explicit `cursor` (the cwd the next config
 * lookup defaults to) and exposes dispatch + status.
 */
import { DEFAULT_EVENTS } from './hook-bus/constants.mjs';
import { buildEventPayload, hookRulesPath } from './hook-bus/config.mjs';
import { createHookEventLog } from './hook-bus/event-log.mjs';
import { createConfigLoader } from './hook-bus/config-loader.mjs';
import { createRuleStore } from './hook-bus/rule-store.mjs';
import { createEventRunner } from './hook-bus/event-runner.mjs';
import { createToolGate } from './hook-bus/tool-gate.mjs';

// Re-export extracted helpers so existing deep importers keep resolving.
export {
  DEFAULT_EVENTS,
  SUPPORTED_HANDLER_TYPES,
  limitText,
} from './hook-bus/constants.mjs';
export {
  buildEventPayload,
  hookConfigEntries,
  hookRulesPath,
  isStandardConfig,
  matchFieldFor,
  matcherFires,
  mergeEvents,
  normalizeRules,
  parseStandardConfig,
  standardConfigReport,
} from './hook-bus/config.mjs';
export {
  handlerTimeoutS,
  ifConditionPasses,
  parseHandlerOutput,
  runCommandHandler,
  runHttpHandler,
  runMcpToolHandler,
  runPromptHandler,
  defaultShellKind,
} from './hook-bus/handlers.mjs';
export {
  compactValue,
  summarizePayload,
} from './hook-bus/payload.mjs';
export {
  decisionFromRule,
  handlerDedupeKey,
  ruleMatches,
  summarizeRule,
} from './hook-bus/rules.mjs';

function hookStatusNote(cfg, configuredEvents, ruleCount) {
  if (cfg.disabled) return 'Hooks are disabled by disableAllHooks.';
  if (cfg.standard) return `Standard Mixdog hooks active for events: ${configuredEvents.join(', ') || '(none)'}.`;
  if (ruleCount > 0) {
    return 'Legacy before-tool hook rules are active. Rules may allow, deny, or modify tool arguments.';
  }
  return 'No hook rules configured; lifecycle and tool events are recorded in observer mode.';
}

const EMPTY_STATUS_CONFIG = { standard: false, disabled: false, events: {}, sources: [], errors: [] };

export function createStandaloneHookBus({
  maxEvents = 80,
  dataDir = null,
  promptRunner = null,
  mcpToolRunner = null,
} = {}) {
  const cursor = { cwd: process.cwd() };
  const rulesPath = hookRulesPath(dataDir);
  const { emit, recent, counts } = createHookEventLog({ maxEvents, cursor });
  let config;
  const rules = createRuleStore({ rulesPath, emit, onRulesSaved: () => config.invalidate() });
  config = createConfigLoader({ dataDir, rulesPath, emit, pendingPatches: rules.pendingPatches });
  const { runEventHandlers } = createEventRunner({
    loadConfig: config.loadConfig,
    emit,
    cursor,
    pluginData: dataDir || null,
    promptRunner,
    mcpToolRunner,
  });
  const beforeTool = createToolGate({
    loadConfig: config.loadConfig,
    loadRules: rules.loadRules,
    runEventHandlers,
    emit,
    cursor,
  });

  async function dispatch(eventName, payload = {}) {
    const name = String(eventName || '').trim();
    if (!name) return {};
    if (payload?.cwd) cursor.cwd = payload.cwd;
    emit(name, payload);
    try {
      const std = buildEventPayload(name, payload);
      const agg = await runEventHandlers(name, std);
      const out = {
        blocked: agg.blocked || undefined,
        reason: agg.reason || undefined,
        additionalContext: agg.additionalContext.length ? agg.additionalContext : undefined,
        updatedInput: agg.updatedInput || undefined,
        updatedToolName: agg.updatedToolName || undefined,
        handlersRun: agg.handlersRun || undefined,
      };
      if (agg.updatedToolOutput != null) out.updatedToolOutput = agg.updatedToolOutput;
      return out;
    } catch (error) {
      emit('hook:error', { name, error: error?.message || String(error) });
      return {};
    }
  }

  function status() {
    let cfg = EMPTY_STATUS_CONFIG;
    try {
      cfg = config.loadConfig(cursor.cwd);
    } catch (error) {
      emit('hook:error', { error: error?.message || String(error) });
    }
    let ruleList = [];
    try {
      ruleList = rules.listRules();
    } catch (error) {
      emit('hook:error', { error: error?.message || String(error) });
    }
    const ruleCount = ruleList.length;
    const configuredEvents = Object.keys(cfg.events || {});
    return {
      enabled: cfg.disabled !== true,
      mode: 'standalone-standard',
      configMode: cfg.standard ? 'standard' : 'legacy',
      rulesPath,
      configSources: cfg.sources || [],
      configSourceEntries: cfg.sourceEntries || [],
      ruleCount,
      rules: ruleList,
      configuredEvents,
      events: [...new Set([...DEFAULT_EVENTS, ...counts.keys(), ...configuredEvents])],
      counts: Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
      recent: [...recent].reverse(),
      errors: cfg.errors || [],
      note: hookStatusNote(cfg, configuredEvents, ruleCount),
    };
  }

  return {
    addRule: rules.addRule,
    beforeTool,
    deleteRule: rules.deleteRule,
    dispatch,
    emit,
    flushRules: rules.flushRules,
    listRules: rules.listRules,
    setRuleEnabled: rules.setRuleEnabled,
    status,
  };
}
