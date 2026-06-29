import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const DEFAULT_EVENTS = Object.freeze([
  'runtime:start',
  'session:create',
  'turn:start',
  'turn:end',
  'turn:error',
  'tool:planned',
  'tool:before',
  'tool:ask',
  'tool:deny',
  'tool:modify',
  'hook:error',
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
]);

const DEFAULT_COMMAND_TIMEOUT_S = 600;
const USER_PROMPT_TIMEOUT_S = 30;
const MESSAGE_DISPLAY_TIMEOUT_S = 10;
const DEFAULT_PROMPT_TIMEOUT_S = 30;
const DEFAULT_AGENT_TIMEOUT_S = 60;
const MAX_OUTPUT_CHARS = 10_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

const TOOL_IF_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
]);

const NO_MATCHER_EVENTS = new Set([
  'UserPromptSubmit',
  'PostToolBatch',
  'Stop',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'WorktreeCreate',
  'WorktreeRemove',
  'CwdChanged',
  'MessageDisplay',
]);

const EXIT2_BLOCK_EVENTS = new Set([
  'PreToolUse',
  'PermissionRequest',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'Stop',
  'SubagentStop',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'ConfigChange',
  'PostToolBatch',
  'PreCompact',
  'Elicitation',
  'ElicitationResult',
]);

const TOP_LEVEL_DECISION_EVENTS = new Set([
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Stop',
  'SubagentStop',
  'ConfigChange',
  'PreCompact',
]);

const PLAIN_STDOUT_CONTEXT_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'UserPromptExpansion',
]);

const SUPPORTED_HANDLER_TYPES = new Set(['command', 'http']);

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
  if (payload.sessionId || payload.session_id) parts.push(`session=${payload.sessionId || payload.session_id}`);
  if (payload.name || payload.tool_name) parts.push(`name=${payload.name || payload.tool_name}`);
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

function uniquePaths(paths) {
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    if (!p) continue;
    const resolved = resolve(p);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

function hookConfigPaths(dataDir, cwd) {
  if (process.env.MIXDOG_HOOKS_FILE) return uniquePaths([process.env.MIXDOG_HOOKS_FILE]);
  const projectDir = cwd ? resolve(cwd) : process.cwd();
  return uniquePaths([
    join(homedir(), '.claude', 'settings.json'),
    projectDir ? join(projectDir, '.claude', 'settings.json') : null,
    projectDir ? join(projectDir, '.claude', 'settings.local.json') : null,
    dataDir ? join(dataDir, 'hooks.json') : null,
  ]);
}

function isStandardConfig(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  const values = Object.values(hooks);
  if (values.length === 0) return false;
  return values.every((groups) => (
    Array.isArray(groups)
    && groups.every((g) => g && typeof g === 'object' && Array.isArray(g.hooks))
  ));
}

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
    return true;
  }
}

function globToRegExp(glob) {
  let out = '^';
  for (const ch of String(glob || '')) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

function primaryArgFor(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (toolName === 'Bash' || toolName === 'bash' || toolName === 'shell') return input.command ?? '';
  if (input.file_path != null) return input.file_path;
  if (input.path != null) return input.path;
  if (input.command != null) return input.command;
  if (input.file != null) return input.file;
  return '';
}

function ifConditionPasses(ifExpr, eventName, toolName, toolInput) {
  if (ifExpr == null || String(ifExpr).trim() === '') return true;
  if (!TOOL_IF_EVENTS.has(eventName)) return false;
  const m = /^\s*([A-Za-z0-9_*]+)\s*\(([^)]*)\)\s*$/.exec(String(ifExpr));
  if (!m) return true;
  const [, tool, pattern] = m;
  if (tool !== '*' && tool !== toolName) return false;
  try {
    return globToRegExp(pattern.trim()).test(String(primaryArgFor(toolName, toolInput)));
  } catch {
    return true;
  }
}

function resolvePlaceholders(str, projectDir, pluginData) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, projectDir || process.cwd())
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, process.env.CLAUDE_PLUGIN_ROOT || projectDir || process.cwd())
    .replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, process.env.CLAUDE_PLUGIN_DATA || pluginData || projectDir || process.cwd());
}

function parseStandardConfig(parsed, source) {
  const events = {};
  const hooks = parsed.hooks || {};
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const cleanGroups = [];
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const handlers = Array.isArray(group.hooks)
        ? group.hooks
          .filter((h) => h && typeof h === 'object' && h.type)
          .map((h) => ({ ...h, _source: source }))
        : [];
      if (handlers.length === 0) continue;
      cleanGroups.push({ matcher: group.matcher, hooks: handlers, _source: source });
    }
    if (cleanGroups.length > 0) events[eventName] = cleanGroups;
  }
  return events;
}

function mergeEvents(target, source) {
  for (const [eventName, groups] of Object.entries(source || {})) {
    if (!Array.isArray(target[eventName])) target[eventName] = [];
    target[eventName].push(...groups);
  }
}

function buildEventPayload(eventName, input = {}) {
  const payload = {
    session_id: input.sessionId ?? input.session_id ?? null,
    cwd: input.cwd ?? null,
    hook_event_name: eventName,
  };
  if (input.transcriptPath != null || input.transcript_path != null) {
    payload.transcript_path = input.transcriptPath ?? input.transcript_path;
  }
  if (input.permissionMode != null || input.permission_mode != null) {
    payload.permission_mode = input.permissionMode ?? input.permission_mode;
  }
  if (input.effort != null) payload.effort = input.effort;
  const toolName = input.name ?? input.tool_name;
  if (toolName != null) payload.tool_name = toolName;
  const toolInput = input.args ?? input.tool_input;
  if (toolInput != null) payload.tool_input = toolInput;
  if (input.toolCallId != null || input.tool_use_id != null) {
    payload.tool_use_id = input.toolCallId ?? input.tool_use_id;
  }
  if (input.toolResponse != null || input.tool_response != null || input.result != null) {
    payload.tool_response = input.toolResponse ?? input.tool_response ?? input.result;
  }
  for (const key of [
    'prompt',
    'source',
    'model',
    'session_title',
    'message',
    'notification_type',
    'trigger',
    'load_reason',
    'file_path',
    'memory_type',
    'command_name',
    'command_args',
    'command_source',
    'expansion_type',
    'stop_reason',
    'error_type',
  ]) {
    if (input[key] != null) payload[key] = input[key];
  }
  return payload;
}

function matchFieldFor(eventName, payload) {
  if (NO_MATCHER_EVENTS.has(eventName)) return null;
  if (eventName === 'SessionStart') return payload.source ?? '';
  if (eventName === 'Setup') return payload.trigger ?? '';
  if (eventName === 'SessionEnd') return payload.reason ?? '';
  if (eventName === 'Notification') return payload.notification_type ?? payload.type ?? '';
  if (eventName === 'SubagentStart' || eventName === 'SubagentStop') return payload.agent_type ?? '';
  if (eventName === 'PreCompact' || eventName === 'PostCompact') return payload.trigger ?? '';
  if (eventName === 'ConfigChange') return payload.source ?? '';
  if (eventName === 'InstructionsLoaded') return payload.load_reason ?? '';
  if (eventName === 'UserPromptExpansion') return payload.command_name ?? '';
  if (eventName === 'StopFailure') return payload.error_type ?? '';
  return payload.tool_name ?? '';
}

function handlerTimeoutS(handler, eventName) {
  if (Number.isFinite(handler.timeout) && handler.timeout > 0) return handler.timeout;
  if (handler.type === 'prompt') return DEFAULT_PROMPT_TIMEOUT_S;
  if (handler.type === 'agent') return DEFAULT_AGENT_TIMEOUT_S;
  if (eventName === 'UserPromptSubmit') return USER_PROMPT_TIMEOUT_S;
  if (eventName === 'MessageDisplay') return MESSAGE_DISPLAY_TIMEOUT_S;
  return DEFAULT_COMMAND_TIMEOUT_S;
}

function defaultShellKind() {
  return process.platform === 'win32' ? 'powershell' : 'bash';
}

function commandSpawnSpec(handler, projectDir, pluginData) {
  const command = resolvePlaceholders(handler.command, projectDir, pluginData);
  if (Array.isArray(handler.args)) {
    return {
      command,
      args: handler.args.map((a) => resolvePlaceholders(String(a), projectDir, pluginData)),
      shellKind: 'exec',
    };
  }
  const shellKind = handler.shell === 'powershell' || handler.shell === 'bash'
    ? handler.shell
    : defaultShellKind();
  if (shellKind === 'powershell') {
    return {
      command: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
      args: ['-NoProfile', '-NonInteractive', '-Command', command],
      shellKind,
    };
  }
  return {
    command: process.platform === 'win32' ? 'bash.exe' : 'bash',
    args: ['-lc', command],
    shellKind,
  };
}

function hookEnv(projectDir, pluginData, payload) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir || process.cwd(),
    CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT || projectDir || process.cwd(),
    CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA || pluginData || projectDir || process.cwd(),
  };
  const effortLevel = payload?.effort?.level || payload?.effort;
  if (effortLevel) env.CLAUDE_EFFORT = String(effortLevel);
  return env;
}

function runCommandHandler(handler, payload, eventName, pluginData, onSpawnError = null) {
  const projectDir = payload.cwd || process.cwd();
  const stdin = JSON.stringify(payload);
  const timeoutMs = Math.round(handlerTimeoutS(handler, eventName) * 1000);
  const spec = commandSpawnSpec(handler, projectDir, pluginData);
  const baseOpts = {
    cwd: existsSync(projectDir) ? projectDir : undefined,
    env: hookEnv(projectDir, pluginData, payload),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  };

  if (handler.async === true || handler.asyncRewake === true) {
    try {
      const child = spawn(spec.command, spec.args, {
        ...baseOpts,
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.on('error', (error) => {
        if (typeof onSpawnError === 'function') onSpawnError(error);
      });
      child.stdin?.end(stdin);
      child.unref?.();
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', async: true });
    } catch (error) {
      return Promise.resolve({
        exitCode: -1,
        stdout: '',
        stderr: error?.message || String(error),
        timedOut: false,
        spawnError: error,
      });
    }
  }

  return new Promise((resolveRun) => {
    let child;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveRun(result);
    };
    try {
      child = spawn(spec.command, spec.args, baseOpts);
    } catch (error) {
      finish({
        exitCode: -1,
        stdout: '',
        stderr: error?.message || String(error),
        timedOut: false,
        spawnError: error,
      });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      finish({
        exitCode: -1,
        stdout,
        stderr: stderr || `hook command timed out after ${timeoutMs}ms`,
        timedOut,
        spawnError: null,
      });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_BUFFER_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_BUFFER_BYTES) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish({
        exitCode: -1,
        stdout,
        stderr: stderr || error?.message || String(error),
        timedOut: false,
        spawnError: error,
      });
    });
    child.on('close', (code) => {
      finish({
        exitCode: timedOut ? -1 : (typeof code === 'number' ? code : 0),
        stdout,
        stderr,
        timedOut,
        spawnError: null,
      });
    });
    try {
      child.stdin?.end(stdin);
    } catch {}
  });
}

function resolveHeaderValue(value, allowed) {
  if (typeof value !== 'string') return String(value ?? '');
  return value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_m, braced, bare) => {
    const name = braced || bare;
    return allowed.has(name) ? (process.env[name] || '') : '';
  });
}

async function runHttpHandler(handler, payload, eventName) {
  if (typeof fetch !== 'function') {
    return { exitCode: -1, stdout: '', stderr: 'fetch is not available', timedOut: false, spawnError: new Error('fetch is not available') };
  }
  const timeoutMs = Math.round(handlerTimeoutS(handler, eventName) * 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const allowed = new Set(Array.isArray(handler.allowedEnvVars) ? handler.allowedEnvVars.map(String) : []);
    const headers = { 'Content-Type': 'application/json' };
    if (handler.headers && typeof handler.headers === 'object' && !Array.isArray(handler.headers)) {
      for (const [key, value] of Object.entries(handler.headers)) {
        headers[key] = resolveHeaderValue(value, allowed);
      }
    }
    const response = await fetch(handler.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return { exitCode: 1, stdout: text, stderr: `HTTP ${response.status} ${response.statusText}`.trim(), timedOut: false, spawnError: null };
    }
    return { exitCode: 0, stdout: text, stderr: '', timedOut: false, spawnError: null };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return {
      exitCode: -1,
      stdout: '',
      stderr: aborted ? `HTTP hook timed out: ${handler.url}` : (error?.message || String(error)),
      timedOut: aborted,
      spawnError: aborted ? null : error,
    };
  } finally {
    clearTimeout(timer);
  }
}

function limitText(text) {
  const value = String(text || '');
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n... [hook output truncated; original ${value.length} chars]`;
}

function parseHandlerOutput(run, eventName) {
  const out = {
    block: false,
    reason: null,
    permissionDecision: null,
    updatedInput: null,
    updatedToolOutput: null,
    additionalContext: null,
    systemMessage: null,
    suppressOutput: false,
    continueFlag: undefined,
    askReason: null,
  };
  if (run.timedOut || run.spawnError || run.async) return out;
  if (run.exitCode === 2) {
    if (EXIT2_BLOCK_EVENTS.has(eventName)) {
      out.block = true;
      out.reason = limitText((run.stderr || '').trim()) || `blocked by ${eventName} hook`;
    }
    return out;
  }
  if (run.exitCode !== 0) return out;
  const rawText = (run.stdout || '').trim();
  if (!rawText) return out;
  if (!(rawText.startsWith('{') || rawText.startsWith('['))) {
    if (PLAIN_STDOUT_CONTEXT_EVENTS.has(eventName)) out.additionalContext = limitText(rawText);
    return out;
  }
  try {
    const json = JSON.parse(rawText);
    if (!json || typeof json !== 'object' || Array.isArray(json)) return out;
    if (json.continue === false) {
      out.continueFlag = false;
      out.block = true;
      out.reason = limitText(json.stopReason || json.reason || `stopped by ${eventName} hook`);
    }
    if (json.decision === 'block' && TOP_LEVEL_DECISION_EVENTS.has(eventName)) {
      out.block = true;
      out.reason = limitText(json.reason || out.reason || `blocked by ${eventName} hook`);
    }
    if (json.suppressOutput) out.suppressOutput = true;
    if (typeof json.systemMessage === 'string') out.systemMessage = limitText(json.systemMessage);
    if (typeof json.additionalContext === 'string') out.additionalContext = limitText(json.additionalContext);

    const hso = json.hookSpecificOutput;
    const hsoMatches = hso && typeof hso === 'object'
      && (!hso.hookEventName || hso.hookEventName === eventName);
    if (hsoMatches) {
      if (typeof hso.additionalContext === 'string') out.additionalContext = limitText(hso.additionalContext);
      if (hso.updatedInput && typeof hso.updatedInput === 'object' && !Array.isArray(hso.updatedInput)) {
        out.updatedInput = hso.updatedInput;
      }
      if (hso.updatedToolOutput != null) out.updatedToolOutput = hso.updatedToolOutput;
      if (hso.permissionDecision) out.permissionDecision = String(hso.permissionDecision).toLowerCase();
      if (hso.permissionDecisionReason) out.reason = out.reason || limitText(hso.permissionDecisionReason);
      if (eventName === 'PermissionRequest' && hso.decision && typeof hso.decision === 'object') {
        const behavior = String(hso.decision.behavior || '').toLowerCase();
        if (behavior === 'deny') {
          out.block = true;
          out.reason = out.reason || limitText(hso.decision.reason || `denied by ${eventName} hook`);
        }
        if (hso.decision.updatedInput && typeof hso.decision.updatedInput === 'object' && !Array.isArray(hso.decision.updatedInput)) {
          out.updatedInput = hso.decision.updatedInput;
        }
      }
    }
    if (eventName === 'PreToolUse') {
      if (out.permissionDecision === 'deny') {
        out.block = true;
        out.reason = out.reason || `denied by ${eventName} hook`;
      } else if (out.permissionDecision === 'ask') {
        out.askReason = out.reason || `ask requested by ${eventName} hook`;
      }
    }
  } catch {
    if (PLAIN_STDOUT_CONTEXT_EVENTS.has(eventName)) out.additionalContext = limitText(rawText);
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
  if (action === 'ask') {
    return { action: 'ask', reason: rule.reason || rule.message || `approval requested by hook rule for ${input.name}` };
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

function handlerDedupeKey(handler) {
  if (!handler || typeof handler !== 'object') return '';
  if (handler.type === 'command') {
    return `command:${handler.command || ''}:${JSON.stringify(handler.args || null)}`;
  }
  if (handler.type === 'http') return `http:${handler.url || ''}`;
  return `${handler.type || 'unknown'}:${JSON.stringify(handler)}`;
}

function shellCountFor(handler) {
  if (handler?.type === 'command') {
    if (handler.args) return 'exec';
    return handler.shell === 'powershell' || handler.shell === 'bash' ? handler.shell : defaultShellKind();
  }
  return handler?.type || 'unknown';
}

export function createStandaloneHookBus({ maxEvents = 80, dataDir = null } = {}) {
  const recent = [];
  const counts = new Map(DEFAULT_EVENTS.map((name) => [name, 0]));
  const rulesPath = hookRulesPath(dataDir);
  const pluginData = dataDir || null;
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
    const paths = hookConfigPaths(dataDir, cwd);
    const parts = [];
    for (const p of paths) {
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
    for (const filePath of paths) {
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
        mergeEvents(events, parseStandardConfig(parsed, filePath));
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
    if (type === 'command') {
      if (!handler.command) return null;
      const reportSpawnError = (error) => {
        emit('hook:error', {
          name: payload.tool_name || eventName,
          error: `hook spawn failed: ${error?.message || error}`,
        });
      };
      return await runCommandHandler(handler, payload, eventName, pluginData, reportSpawnError);
    }
    if (type === 'http') {
      if (!handler.url) return null;
      return await runHttpHandler(handler, payload, eventName);
    }
    return null;
  }

  async function runEventHandlers(eventName, payload) {
    const handlers = selectHandlers(eventName, payload);
    const agg = {
      blocked: false,
      reason: null,
      updatedInput: null,
      updatedToolOutput: null,
      additionalContext: [],
      systemMessage: null,
      ask: false,
      askReason: null,
      handlersRun: handlers.length,
    };
    const results = await Promise.all(handlers.map(async (handler) => {
      try {
        return { handler, run: await runOneHandler(handler, eventName, payload) };
      } catch (error) {
        emit('hook:error', { name: payload.tool_name || eventName, error: error?.message || String(error) });
        return { handler, run: null };
      }
    }));

    for (const { handler, run } of results) {
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
      if (parsed.updatedToolOutput != null && agg.updatedToolOutput == null) agg.updatedToolOutput = parsed.updatedToolOutput;
      if (parsed.askReason && !agg.ask && !agg.blocked) {
        agg.ask = true;
        agg.askReason = parsed.askReason;
      }
      if (parsed.block && !agg.blocked) {
        agg.blocked = true;
        agg.reason = parsed.reason;
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
        if (agg.updatedInput) {
          emit('tool:modify', { sessionId: input.sessionId || input.session_id || null, name: input.name || input.tool_name || 'tool', reason: agg.reason });
          return { action: 'modify', args: agg.updatedInput, reason: agg.reason };
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
      return {
        blocked: agg.blocked || undefined,
        reason: agg.reason || undefined,
        additionalContext: agg.additionalContext.length ? agg.additionalContext : undefined,
        systemMessage: agg.systemMessage || undefined,
        updatedInput: agg.updatedInput || undefined,
        updatedToolOutput: agg.updatedToolOutput ?? undefined,
        handlersRun: agg.handlersRun || undefined,
      };
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
          ? `Standard Claude Code hooks active for events: ${configuredEvents.join(', ') || '(none)'}.`
          : (ruleCount > 0
            ? 'Legacy before-tool hook rules are active. Rules may allow, deny, or modify tool arguments.'
            : 'No hook rules configured; lifecycle and tool events are recorded in observer mode.')),
    };
  }

  return { addRule, beforeTool, deleteRule, dispatch, emit, listRules, setRuleEnabled, status };
}
