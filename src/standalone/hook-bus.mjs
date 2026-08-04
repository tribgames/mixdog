import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_EVENTS,
  NO_MATCHER_EVENTS,
  SUPPORTED_HANDLER_TYPES,
  EXIT2_BLOCK_EVENTS,
  TOP_LEVEL_DECISION_EVENTS,
  limitText,
} from './hook-bus/constants.mjs';
import {
  buildEventPayload,
  hookConfigEntries,
  hookRulesPath,
  isStandardConfig,
  matchFieldFor,
  matcherFires,
  mergeEvents,
  normalizeRules,
  parseStandardConfig,
} from './hook-bus/config.mjs';
import {
  handlerTimeoutS,
  ifConditionPasses,
  parseHandlerOutput,
  runCommandHandler,
  runHttpHandler,
  runMcpToolHandler,
  runPromptHandler,
  defaultShellKind,
} from './hook-bus/handlers.mjs';
import {
  compactValue,
  summarizePayload,
} from './hook-bus/payload.mjs';
import {
  decisionFromRule,
  handlerDedupeKey,
  ruleMatches,
  shellCountFor,
  summarizeRule,
} from './hook-bus/rules.mjs';

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

export function createStandaloneHookBus({ maxEvents = 80, dataDir = null, promptRunner = null, mcpToolRunner = null } = {}) {
  const recent = [];
  const counts = new Map(DEFAULT_EVENTS.map((name) => [name, 0]));
  const rulesPath = hookRulesPath(dataDir);
  const pluginData = dataDir || null;
  let rewakeHandler = null;
  let rulesCache = { mtimeMs: -1, rules: [] };
  let configCache = {
    key: '',
    standard: false,
    disabled: false,
    events: {},
    legacyRules: [],
    sources: [],
    errors: [],
  };
  let lastCwd = process.cwd();

  function emit(name, payload = {}) {
    const eventName = String(name || '').trim();
    if (!eventName) return null;
    if (payload?.cwd) lastCwd = payload.cwd;
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

  function loadConfig(cwd = lastCwd) {
    const entries = hookConfigEntries(dataDir, cwd);
    const parts = [];
    for (const { path: p } of entries) {
      try {
        const st = existsSync(p) ? statSync(p) : null;
        parts.push(`${p}:${st ? st.mtimeMs : 'absent'}`);
      } catch {
        parts.push(`${p}:error`);
      }
    }
    const key = parts.join('|');
    if (configCache.key === key) return configCache;

    const events = {};
    const legacyRules = [];
    const sources = [];
    const errors = [];
    let disabled = false;
    let disableSeen = false;
    for (const entry of entries) {
      const filePath = entry.path;
      if (!existsSync(filePath)) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      } catch (error) {
        errors.push({ file: filePath, error: error?.message || String(error) });
        continue;
      }
      sources.push(filePath);
      if (Object.prototype.hasOwnProperty.call(parsed || {}, 'disableAllHooks')) {
        disabled = parsed.disableAllHooks === true;
        disableSeen = true;
      }
      if (isStandardConfig(parsed)) {
        mergeEvents(events, parseStandardConfig(parsed, filePath, entry));
      } else {
        legacyRules.push(...normalizeRules(parsed).filter((rule) => rule && typeof rule === 'object'));
      }
    }
    configCache = {
      key,
      standard: Object.keys(events).length > 0,
      disabled: disableSeen ? disabled : false,
      events,
      legacyRules,
      sources,
      errors,
    };
    for (const err of errors) {
      emit('hook:error', { error: `failed to parse hooks file ${err.file}: ${err.error}` });
    }
    return configCache;
  }

  function selectHandlers(eventName, payload) {
    const cfg = loadConfig(payload.cwd || lastCwd);
    if (cfg.disabled || !cfg.standard) return [];
    const groups = cfg.events[eventName];
    if (!Array.isArray(groups)) return [];
    const field = matchFieldFor(eventName, payload);
    const handlers = [];
    const seen = new Set();
    for (const group of groups) {
      if (NO_MATCHER_EVENTS.has(eventName) || matcherFires(group.matcher, field)) {
        for (const handler of group.hooks) {
          const key = handlerDedupeKey(handler);
          if (seen.has(key)) continue;
          seen.add(key);
          handlers.push(handler);
        }
      }
    }
    return handlers;
  }

  async function runOneHandler(handler, eventName, payload) {
    if (!handler || typeof handler !== 'object') return null;
    if (!ifConditionPasses(handler.if, eventName, payload.tool_name, payload.tool_input)) return null;
    const type = String(handler.type || '').trim();
    if (!SUPPORTED_HANDLER_TYPES.has(type)) {
      emit('hook:error', { name: payload.tool_name || eventName, error: `unsupported hook type: ${type || '(missing)'}` });
      return null;
    }
    // Untrusted project hooks (project .mixdog/hooks.json without a user-level
    // trust opt-in) may not run executable/network handlers: RCE + exfil vector.
    if (handler._untrusted === true && (type === 'command' || type === 'http' || type === 'mcp_tool')) {
      emit('hook:error', {
        name: payload.tool_name || eventName,
        error: `blocked ${type} hook from untrusted project (add project to trustedProjects to enable)`,
      });
      return null;
    }
    if (type === 'command') {
      if (!handler.command) return null;
      const reportSpawnError = (error) => {
        emit('hook:error', {
          name: payload.tool_name || eventName,
          error: `hook spawn failed: ${error?.message || error}`,
        });
      };
      const reportRewake = ({ eventName: en, payload: pl, text }) => {
        try {
          if (typeof rewakeHandler === 'function') {
            rewakeHandler({ eventName: en, payload: pl, text });
          } else {
            emit('hook:rewake', { name: pl?.tool_name || en, text: text || null });
          }
        } catch {}
      };
      return await runCommandHandler(handler, payload, eventName, pluginData, reportSpawnError, reportRewake);
    }
    if (type === 'http') {
      if (!handler.url) return null;
      return await runHttpHandler(handler, payload, eventName);
    }
    if (type === 'mcp_tool') {
      if (typeof mcpToolRunner !== 'function') {
        emit('hook:error', { name: payload.tool_name || eventName, error: 'handler type mcp_tool not configured' });
        return null;
      }
      return await runMcpToolHandler(handler, payload, eventName, mcpToolRunner);
    }
    if (type === 'prompt') {
      if (typeof promptRunner !== 'function') {
        emit('hook:error', { name: payload.tool_name || eventName, error: 'handler type prompt not configured' });
        return null;
      }
      return await runPromptHandler(handler, payload, eventName, promptRunner);
    }
    return null;
  }

  async function runEventHandlers(eventName, payload) {
    const handlers = selectHandlers(eventName, payload);
    const agg = {
      blocked: false,
      reason: null,
      updatedInput: null,
      updatedToolName: null,
      updatedToolOutput: null,
      additionalContext: [],
      systemMessage: null,
      ask: false,
      askReason: null,
      handlersRun: handlers.length,
    };
    // Run sequentially and short-circuit once a deny lands: concurrent execution
    // let side-effect hooks fire even when an earlier hook already denied.
    // Denial-capable events must not run remaining handlers after a block.
    const shortCircuit = EXIT2_BLOCK_EVENTS.has(eventName) || TOP_LEVEL_DECISION_EVENTS.has(eventName);
    for (const handler of handlers) {
      let run;
      try {
        run = await runOneHandler(handler, eventName, payload);
      } catch (error) {
        emit('hook:error', { name: payload.tool_name || eventName, error: error?.message || String(error) });
        continue;
      }
      if (!run) continue;
      if (run.timedOut) {
        emit('hook:error', { name: payload.tool_name || eventName, error: `hook ${shellCountFor(handler)} timed out: ${handler.command || handler.url || handler.type}` });
        continue;
      }
      if (run.spawnError) {
        emit('hook:error', { name: payload.tool_name || eventName, error: `hook spawn failed: ${run.spawnError.message || run.spawnError}` });
        continue;
      }
      if (run.exitCode && run.exitCode !== 0 && run.exitCode !== 2) {
        emit('hook:error', { name: payload.tool_name || eventName, error: (run.stderr || '').trim() || `hook exited ${run.exitCode}` });
        continue;
      }
      const parsed = parseHandlerOutput(run, eventName);
      if (parsed.additionalContext) agg.additionalContext.push(parsed.additionalContext);
      if (parsed.systemMessage && !agg.systemMessage) agg.systemMessage = parsed.systemMessage;
      if (parsed.updatedInput && !agg.updatedInput) agg.updatedInput = parsed.updatedInput;
      if (parsed.updatedToolName && !agg.updatedToolName) agg.updatedToolName = parsed.updatedToolName;
      if (parsed.updatedToolOutput != null && agg.updatedToolOutput == null) agg.updatedToolOutput = parsed.updatedToolOutput;
      if (parsed.askReason && !agg.ask && !agg.blocked) {
        agg.ask = true;
        agg.askReason = parsed.askReason;
      }
      if (parsed.block && !agg.blocked) {
        agg.blocked = true;
        agg.reason = parsed.reason;
      }
      if (agg.blocked && shortCircuit) break;
    }
    return agg;
  }

  function saveRules(rules) {
    if (!rulesPath) throw new Error('hooks rules path is not configured');
    mkdirSync(dirname(rulesPath), { recursive: true });
    const cleanRules = Array.isArray(rules) ? rules.filter((rule) => rule && typeof rule === 'object') : [];
    writeFileSync(rulesPath, `${JSON.stringify({ toolBefore: cleanRules }, null, 2)}\n`, 'utf8');
    const stat = statSync(rulesPath);
    rulesCache = { mtimeMs: stat.mtimeMs, rules: cleanRules };
    configCache.key = '';
    return listRules();
  }

  function listRules() {
    return loadRules().map((rule, index) => summarizeRule(rule, index));
  }

  function addRule(rule = {}) {
    const action = String(rule.action || rule.decision || '').trim().toLowerCase();
    if (!action || !['allow', 'deny', 'block', 'modify', 'rewrite', 'ask'].includes(action)) {
      throw new Error('hook rule action must be allow, deny, block, modify, rewrite, or ask');
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

  // --- debounced hooks.json persist ------------------------------------------
  // Rule state is flipped in the in-memory rulesCache synchronously so the
  // picker reopen renders from memory (no disk re-read); the heavy file RMW
  // (saveRules) is deferred so a burst of toggle key presses collapses into one
  // write. Mirrors config-lifecycle's scheduleSkillsSave pattern.
  const RULES_SAVE_DEBOUNCE_MS = 400;
  // Pending flips are tracked as index→enabled patches (not a full snapshot) so
  // that if hooks.json is edited externally during the debounce window the flush
  // can reload the current disk rules and reapply only our enabled-flag changes
  // instead of clobbering the external edit.
  let pendingRulePatches = null;
  let rulesBaseMtime = null;
  let rulesSaveTimer = null;

  function flushRules() {
    if (rulesSaveTimer) {
      clearTimeout(rulesSaveTimer);
      rulesSaveTimer = null;
    }
    if (!pendingRulePatches || pendingRulePatches.size === 0) {
      pendingRulePatches = null;
      rulesBaseMtime = null;
      return;
    }
    const patches = pendingRulePatches;
    const base = rulesBaseMtime;
    pendingRulePatches = null;
    rulesBaseMtime = null;
    try {
      let rules;
      const diskChanged = rulesPath && existsSync(rulesPath) && statSync(rulesPath).mtimeMs !== base;
      if (diskChanged) {
        // External edit during the debounce window: reload from disk and reapply
        // only our flips so the external change survives.
        const parsed = JSON.parse(readFileSync(rulesPath, 'utf8'));
        rules = normalizeRules(parsed).filter((rule) => rule && typeof rule === 'object');
      } else {
        rules = [...(rulesCache.rules || [])];
      }
      for (const [index, enabled] of patches) {
        if (index >= 0 && index < rules.length) rules[index] = { ...rules[index], enabled };
      }
      saveRules(rules);
    } catch (error) {
      emit('hook:error', { error: `debounced hooks save failed: ${error?.message || error}` });
    }
  }

  function scheduleRulesSave() {
    if (rulesSaveTimer) clearTimeout(rulesSaveTimer);
    rulesSaveTimer = setTimeout(flushRules, RULES_SAVE_DEBOUNCE_MS);
    rulesSaveTimer.unref?.();
  }

  function setRuleEnabled(index, enabled) {
    const rules = [...loadRules()];
    if (!Number.isInteger(index) || index < 0 || index >= rules.length) throw new Error(`hook rule not found: ${index}`);
    const nextEnabled = enabled !== false;
    rules[index] = { ...rules[index], enabled: nextEnabled };
    // Adopt in memory immediately: keep the last-known disk mtime so loadRules
    // returns this flipped cache (disk is untouched until the debounce flushes),
    // and drop the config cache so a re-read reflects the change.
    rulesCache = { ...rulesCache, rules };
    configCache.key = '';
    if (!pendingRulePatches) {
      pendingRulePatches = new Map();
      // mtime the in-memory cache was loaded from; flush compares against it to
      // detect an external edit made during the debounce window.
      rulesBaseMtime = rulesCache.mtimeMs;
    }
    pendingRulePatches.set(index, nextEnabled);
    scheduleRulesSave();
    return listRules();
  }

  function deleteRule(index) {
    const rules = [...loadRules()];
    if (!Number.isInteger(index) || index < 0 || index >= rules.length) throw new Error(`hook rule not found: ${index}`);
    rules.splice(index, 1);
    return saveRules(rules);
  }

  async function beforeTool(input = {}) {
    if (input?.cwd) lastCwd = input.cwd;
    emit('tool:before', {
      sessionId: input.sessionId || input.session_id || null,
      name: input.name || input.tool_name || 'tool',
      callId: input.toolCallId || input.callId || input.tool_use_id || null,
      args: input.args || input.tool_input || null,
    });
    try {
      const cfg = loadConfig(input.cwd || lastCwd);
      if (cfg.disabled) return null;
      if (!cfg.disabled) {
        const payload = buildEventPayload('PreToolUse', input);
        const agg = await runEventHandlers('PreToolUse', payload);
        if (agg.blocked) {
          emit('tool:deny', { sessionId: input.sessionId || input.session_id || null, name: input.name || input.tool_name || 'tool', reason: agg.reason });
          return { action: 'deny', reason: agg.reason };
        }
        if (agg.updatedInput || agg.updatedToolName) {
          emit('tool:modify', { sessionId: input.sessionId || input.session_id || null, name: input.name || input.tool_name || 'tool', reason: agg.reason });
          return {
            action: 'modify',
            ...(agg.updatedInput ? { args: agg.updatedInput } : {}),
            ...(agg.updatedToolName ? { name: agg.updatedToolName } : {}),
            reason: agg.reason,
          };
        }
        if (agg.ask) {
          emit('tool:ask', { sessionId: input.sessionId || input.session_id || null, name: input.name || input.tool_name || 'tool', reason: agg.askReason });
          return { action: 'ask', reason: agg.askReason };
        }
      }

      const rules = Array.isArray(cfg.legacyRules) && cfg.legacyRules.length
        ? cfg.legacyRules
        : loadRules();
      const rule = rules.find((candidate) => ruleMatches(candidate, {
        name: input.name || input.tool_name,
        args: input.args || input.tool_input,
        cwd: input.cwd,
      }));
      if (!rule) return null;
      const decision = decisionFromRule(rule, {
        name: input.name || input.tool_name,
        args: input.args || input.tool_input,
        cwd: input.cwd,
      });
      if (decision.action === 'deny') {
        emit('tool:deny', { sessionId: input.sessionId || input.session_id || null, name: input.name || input.tool_name || 'tool', reason: decision.reason });
      } else if (decision.action === 'modify') {
        emit('tool:modify', { sessionId: input.sessionId || input.session_id || null, name: input.name || input.tool_name || 'tool', reason: decision.reason });
      } else if (decision.action === 'ask') {
        emit('tool:ask', { sessionId: input.sessionId || input.session_id || null, name: input.name || input.tool_name || 'tool', reason: decision.reason });
      }
      return decision;
    } catch (error) {
      emit('hook:error', { name: input.name || input.tool_name || 'tool', error: error?.message || String(error) });
      return null;
    }
  }

  async function dispatch(eventName, payload = {}) {
    const name = String(eventName || '').trim();
    if (!name) return {};
    if (payload?.cwd) lastCwd = payload.cwd;
    emit(name, payload);
    try {
      const std = buildEventPayload(name, payload);
      const agg = await runEventHandlers(name, std);
      const out = {
        blocked: agg.blocked || undefined,
        reason: agg.reason || undefined,
        additionalContext: agg.additionalContext.length ? agg.additionalContext : undefined,
        systemMessage: agg.systemMessage || undefined,
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
    let cfg = {
      standard: false,
      disabled: false,
      events: {},
      sources: [],
      errors: [],
    };
    try {
      cfg = loadConfig(lastCwd);
    } catch (error) {
      emit('hook:error', { error: error?.message || String(error) });
    }
    let ruleCount = 0;
    let rules = [];
    try {
      rules = listRules();
      ruleCount = rules.length;
    } catch (error) {
      emit('hook:error', { error: error?.message || String(error) });
    }
    const configuredEvents = Object.keys(cfg.events || {});
    return {
      enabled: cfg.disabled !== true,
      mode: 'standalone-standard',
      configMode: cfg.standard ? 'standard' : 'legacy',
      rulesPath,
      configSources: cfg.sources || [],
      ruleCount,
      rules,
      configuredEvents,
      events: [...new Set([...DEFAULT_EVENTS, ...counts.keys(), ...configuredEvents])],
      counts: Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
      recent: [...recent].reverse(),
      errors: cfg.errors || [],
      note: cfg.disabled
        ? 'Hooks are disabled by disableAllHooks.'
        : (cfg.standard
          ? `Standard Mixdog hooks active for events: ${configuredEvents.join(', ') || '(none)'}.`
          : (ruleCount > 0
            ? 'Legacy before-tool hook rules are active. Rules may allow, deny, or modify tool arguments.'
            : 'No hook rules configured; lifecycle and tool events are recorded in observer mode.')),
    };
  }

  function setRewakeHandler(fn) {
    rewakeHandler = typeof fn === 'function' ? fn : null;
    return rewakeHandler;
  }

  return { addRule, beforeTool, deleteRule, dispatch, emit, flushRules, listRules, setRewakeHandler, setRuleEnabled, status };
}
