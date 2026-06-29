import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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

// Default command timeouts (seconds). UserPromptSubmit is intentionally lower.
const DEFAULT_COMMAND_TIMEOUT_S = 600;
const USER_PROMPT_TIMEOUT_S = 30;

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

// ── Standard config detection ──────────────────────────────────────────────
// A STANDARD hooks.json has a `hooks` object whose values are arrays of
// matcher-groups: [ { matcher?, hooks: [ { type, command, ... } ] } ].
// Anything else (top-level array, {toolBefore:[]}, {beforeTool:[]},
// {hooks:{toolBefore:[]}}) is treated as LEGACY PreToolUse inline rules.
function isStandardConfig(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  const values = Object.values(hooks);
  if (values.length === 0) return false;
  // Legacy `{hooks:{toolBefore:[...]}}` — values are arrays of rule objects
  // that do NOT contain nested matcher-groups. Distinguish by group shape.
  return values.every((groups) => {
    if (!Array.isArray(groups)) return false;
    return groups.every((g) => g && typeof g === 'object' && Array.isArray(g.hooks));
  });
}

// ── Standard matcher evaluator ─────────────────────────────────────────────
// matcher "*"/""/omitted → match all.
// Only [A-Za-z0-9_ ,|] → exact / list (| or , separated) string match.
// Anything else → RegExp test.
const SIMPLE_MATCHER_RE = /^[A-Za-z0-9_ ,|]*$/;
function matcherFires(matcher, field) {
  if (matcher == null) return true;
  const text = String(matcher).trim();
  if (text === '' || text === '*') return true;
  const value = String(field ?? '');
  if (SIMPLE_MATCHER_RE.test(text)) {
    const items = text.split(/[|,]/).map((s) => s.trim()).filter(Boolean);
    if (items.length === 0) return true;
    return items.includes(value);
  }
  try {
    return new RegExp(text).test(value);
  } catch {
    // Unparseable regex → fail open (match).
    return true;
  }
}

// ── `if` permission-rule syntax: Tool(pattern) ─────────────────────────────
// Best-effort glob match against the tool's primary arg. Fail OPEN.
function globToRegExp(glob) {
  let out = '^';
  for (const ch of glob) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}
function primaryArgFor(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (toolName === 'Bash') return input.command ?? '';
  if (input.file_path != null) return input.file_path;
  if (input.path != null) return input.path;
  if (input.command != null) return input.command;
  return '';
}
function ifConditionPasses(ifExpr, toolName, toolInput) {
  if (ifExpr == null || String(ifExpr).trim() === '') return true;
  const m = /^\s*([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*$/.exec(String(ifExpr));
  if (!m) return true; // unparseable → fail open
  const [, tool, pattern] = m;
  if (tool !== toolName && tool !== '*') return true; // not targeted at this tool → no constraint
  try {
    return globToRegExp(pattern.trim()).test(String(primaryArgFor(toolName, toolInput)));
  } catch {
    return true; // fail open
  }
}

// ── Placeholder resolution ─────────────────────────────────────────────────
function resolvePlaceholders(str, projectDir) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, projectDir || process.cwd())
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, process.env.CLAUDE_PLUGIN_ROOT || projectDir || process.cwd());
}

// ── Standard config parsing into normalized event → matcher-groups map ──────
function parseStandardConfig(parsed) {
  const events = {};
  const hooks = parsed.hooks || {};
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const clean = [];
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const handlers = Array.isArray(group.hooks)
        ? group.hooks.filter((h) => h && typeof h === 'object' && h.type === 'command' && h.command)
        : [];
      if (handlers.length === 0) continue;
      clean.push({ matcher: group.matcher, hooks: handlers });
    }
    if (clean.length > 0) events[eventName] = clean;
  }
  return events;
}

// ── STDIN payload builder (standard snake_case schema) ─────────────────────
function buildEventPayload(eventName, input = {}) {
  const payload = {
    session_id: input.sessionId ?? input.session_id ?? null,
    cwd: input.cwd ?? null,
    hook_event_name: eventName,
  };
  const toolName = input.name ?? input.tool_name;
  if (toolName != null) payload.tool_name = toolName;
  const toolInput = input.args ?? input.tool_input;
  if (toolInput != null) payload.tool_input = toolInput;
  if (input.toolResponse != null || input.tool_response != null) {
    payload.tool_response = input.toolResponse ?? input.tool_response;
  }
  if (input.prompt != null) payload.prompt = input.prompt;
  if (input.source != null) payload.source = input.source;
  return payload;
}

// ── Matched field per event ────────────────────────────────────────────────
function matchFieldFor(eventName, payload) {
  if (eventName === 'SessionStart') return payload.source ?? '';
  if (eventName === 'UserPromptSubmit') return null; // no matcher → always fire
  return payload.tool_name ?? ''; // tool events
}

// ── Command handler runner (synchronous spawn) ─────────────────────────────
// Returns { exitCode, stdout, stderr, timedOut }.
function runCommandHandler(handler, payload, eventName) {
  const projectDir = payload.cwd || process.cwd();
  const stdin = JSON.stringify(payload);
  const timeoutS = Number.isFinite(handler.timeout) && handler.timeout > 0
    ? handler.timeout
    : (eventName === 'UserPromptSubmit' ? USER_PROMPT_TIMEOUT_S : DEFAULT_COMMAND_TIMEOUT_S);
  const timeoutMs = Math.round(timeoutS * 1000);
  const command = resolvePlaceholders(handler.command, projectDir);
  const args = Array.isArray(handler.args)
    ? handler.args.map((a) => resolvePlaceholders(String(a), projectDir))
    : null;
  const baseOpts = {
    input: stdin,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: process.env,
    cwd: existsSync(projectDir) ? projectDir : undefined,
    maxBuffer: 10 * 1024 * 1024,
  };

  let result;
  if (handler.shell === 'powershell') {
    const psCmd = args ? `${command} ${args.join(' ')}` : command;
    result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], baseOpts);
  } else if (args) {
    // Exec form: no shell.
    result = spawnSync(command, args, baseOpts);
  } else {
    // Shell form.
    result = spawnSync(command, { ...baseOpts, shell: true });
  }

  const timedOut = result.error && (result.error.code === 'ETIMEDOUT' || result.signal === 'SIGTERM');
  const exitCode = timedOut ? -1 : (typeof result.status === 'number' ? result.status : (result.error ? -1 : 0));
  return {
    exitCode,
    stdout: result.stdout || '',
    stderr: result.stderr || (result.error ? String(result.error.message || result.error) : ''),
    timedOut: Boolean(timedOut),
    spawnError: result.error && !timedOut ? result.error : null,
  };
}

// ── STDOUT + exit-code decision parsing ────────────────────────────────────
function parseHandlerOutput(run, eventName) {
  const out = {
    block: false,
    reason: null,
    permissionDecision: null,
    updatedInput: null,
    additionalContext: null,
    systemMessage: null,
    suppressOutput: false,
    continueFlag: undefined,
    askReason: null,
  };
  if (run.timedOut || run.spawnError) {
    // Timeout/spawn failure → no decision.
    return out;
  }
  if (run.exitCode === 2) {
    out.block = true;
    out.reason = (run.stderr || '').trim() || `blocked by ${eventName} hook`;
  }
  const text = (run.stdout || '').trim();
  if (text && (text.startsWith('{') || text.startsWith('['))) {
    try {
      const json = JSON.parse(text);
      if (json && typeof json === 'object') {
        if (json.continue === false) {
          out.continueFlag = false;
          out.block = true;
          out.reason = out.reason || json.stopReason || json.reason || `stopped by ${eventName} hook`;
        }
        if (json.decision === 'block') {
          out.block = true;
          out.reason = json.reason || out.reason || `blocked by ${eventName} hook`;
        }
        if (json.suppressOutput) out.suppressOutput = true;
        if (typeof json.systemMessage === 'string') out.systemMessage = json.systemMessage;
        const hso = json.hookSpecificOutput;
        if (hso && typeof hso === 'object') {
          if (hso.permissionDecision) out.permissionDecision = String(hso.permissionDecision).toLowerCase();
          if (hso.permissionDecisionReason) out.reason = out.reason || hso.permissionDecisionReason;
          if (hso.updatedInput && typeof hso.updatedInput === 'object' && !Array.isArray(hso.updatedInput)) {
            out.updatedInput = hso.updatedInput;
          }
          if (typeof hso.additionalContext === 'string') out.additionalContext = hso.additionalContext;
        }
        if (out.permissionDecision === 'deny') {
          out.block = true;
          out.reason = out.reason || `denied by ${eventName} hook`;
        }
        if (out.permissionDecision === 'ask') {
          out.askReason = out.reason || `ask requested by ${eventName} hook`;
        }
      }
    } catch {
      // ignore non-JSON stdout
    }
  }
  return out;
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
  // Standard config cache (shares the same file/mtime mechanism).
  let configCache = { mtimeMs: -1, standard: false, events: {} };

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

  // Load + classify the config file (standard vs legacy). mtime-cached.
  function loadConfig() {
    if (!rulesPath || !existsSync(rulesPath)) {
      configCache = { mtimeMs: -1, standard: false, events: {} };
      return configCache;
    }
    const stat = statSync(rulesPath);
    if (configCache.mtimeMs === stat.mtimeMs) return configCache;
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(rulesPath, 'utf8'));
    } catch (error) {
      emit('hook:error', { error: `failed to parse hooks file: ${error?.message || String(error)}` });
      configCache = { mtimeMs: stat.mtimeMs, standard: false, events: {} };
      return configCache;
    }
    if (isStandardConfig(parsed)) {
      configCache = { mtimeMs: stat.mtimeMs, standard: true, events: parseStandardConfig(parsed) };
    } else {
      configCache = { mtimeMs: stat.mtimeMs, standard: false, events: {} };
    }
    return configCache;
  }

  // Select matcher groups for an event whose matcher fires for the field.
  function selectHandlers(eventName, payload) {
    const cfg = loadConfig();
    if (!cfg.standard) return [];
    const groups = cfg.events[eventName];
    if (!Array.isArray(groups)) return [];
    const field = matchFieldFor(eventName, payload);
    const handlers = [];
    for (const group of groups) {
      // UserPromptSubmit ignores matcher entirely.
      if (eventName === 'UserPromptSubmit' || matcherFires(group.matcher, field)) {
        for (const h of group.hooks) handlers.push(h);
      }
    }
    return handlers;
  }

  // Core command-runner: run all matching handlers in order, aggregate.
  // first explicit deny/block wins. Returns aggregated decision object.
  function runEventHandlers(eventName, payload) {
    const handlers = selectHandlers(eventName, payload);
    const agg = {
      blocked: false,
      reason: null,
      updatedInput: null,
      additionalContext: [],
      systemMessage: null,
      ask: false,
      askReason: null,
    };
    const toolName = payload.tool_name;
    const toolInput = payload.tool_input;
    for (const handler of handlers) {
      try {
        if (!ifConditionPasses(handler.if, toolName, toolInput)) continue;
        const run = runCommandHandler(handler, payload, eventName);
        if (run.timedOut) {
          emit('hook:error', { name: toolName || eventName, error: `hook command timed out: ${handler.command}` });
          continue;
        }
        if (run.spawnError) {
          emit('hook:error', { name: toolName || eventName, error: `hook spawn failed: ${run.spawnError.message || run.spawnError}` });
          continue;
        }
        const parsed = parseHandlerOutput(run, eventName);
        if (parsed.additionalContext) agg.additionalContext.push(parsed.additionalContext);
        if (parsed.systemMessage && !agg.systemMessage) agg.systemMessage = parsed.systemMessage;
        if (parsed.updatedInput && !agg.updatedInput) agg.updatedInput = parsed.updatedInput;
        if (parsed.askReason && !agg.ask && !agg.blocked) {
          agg.ask = true;
          agg.askReason = parsed.askReason;
        }
        if (parsed.block && !agg.blocked) {
          agg.blocked = true;
          agg.reason = parsed.reason;
          // first explicit deny/block wins → stop running further handlers
          break;
        }
      } catch (error) {
        emit('hook:error', { name: toolName || eventName, error: error?.message || String(error) });
      }
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
      const cfg = loadConfig();
      if (cfg.standard) {
        // Standard PreToolUse path: run command handlers synchronously.
        const payload = buildEventPayload('PreToolUse', input);
        const agg = runEventHandlers('PreToolUse', payload);
        if (agg.blocked) {
          emit('tool:deny', { sessionId: input.sessionId || null, name: input.name || 'tool', reason: agg.reason });
          return { action: 'deny', reason: agg.reason };
        }
        if (agg.updatedInput) {
          emit('tool:modify', { sessionId: input.sessionId || null, name: input.name || 'tool', reason: agg.reason });
          return { action: 'modify', args: agg.updatedInput, reason: agg.reason };
        }
        if (agg.ask) {
          // TODO: no interactive permission UI in standalone — treat ask as
          // allow for now and surface the request via a tool:ask event.
          emit('tool:ask', { sessionId: input.sessionId || null, name: input.name || 'tool', reason: agg.askReason });
          return { action: 'allow', reason: agg.askReason };
        }
        return null;
      }
      // LEGACY inline rules path (unchanged behavior).
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

  // Generic dispatch for non-tool standard events (runtime bridge).
  async function dispatch(eventName, payload = {}) {
    const name = String(eventName || '').trim();
    if (!name) return {};
    try {
      const std = buildEventPayload(name, payload);
      const agg = runEventHandlers(name, std);
      return {
        blocked: agg.blocked || undefined,
        reason: agg.reason || undefined,
        additionalContext: agg.additionalContext.length ? agg.additionalContext : undefined,
        systemMessage: agg.systemMessage || undefined,
      };
    } catch (error) {
      emit('hook:error', { name, error: error?.message || String(error) });
      return {};
    }
  }

  function status() {
    let cfg = { standard: false, events: {} };
    try {
      cfg = loadConfig();
    } catch (error) {
      emit('hook:error', { error: error?.message || String(error) });
    }
    let ruleCount = 0;
    let rules = [];
    if (!cfg.standard) {
      try {
        rules = listRules();
        ruleCount = rules.length;
      } catch (error) {
        emit('hook:error', { error: error?.message || String(error) });
      }
    }
    const configuredEvents = Object.keys(cfg.events || {});
    return {
      enabled: true,
      mode: 'standalone-standard',
      configMode: cfg.standard ? 'standard' : 'legacy',
      rulesPath,
      ruleCount,
      rules,
      configuredEvents,
      events: [...new Set([...DEFAULT_EVENTS, ...counts.keys()])],
      counts: Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
      recent: [...recent].reverse(),
      note: cfg.standard
        ? `Standard Claude Code hooks active for events: ${configuredEvents.join(', ') || '(none)'}.`
        : (ruleCount > 0
          ? 'Legacy before-tool hook rules are active. Rules may allow, deny, or modify tool arguments.'
          : 'No hook rules configured; lifecycle and tool events are recorded in observer mode.'),
    };
  }

  return { addRule, beforeTool, deleteRule, dispatch, emit, listRules, setRuleEnabled, status };
}
