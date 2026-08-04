import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import {
  DEFAULT_AGENT_TIMEOUT_S,
  DEFAULT_COMMAND_TIMEOUT_S,
  DEFAULT_PROMPT_TIMEOUT_S,
  EXIT2_BLOCK_EVENTS,
  MAX_BUFFER_BYTES,
  MESSAGE_DISPLAY_TIMEOUT_S,
  PLAIN_STDOUT_CONTEXT_EVENTS,
  TOOL_IF_EVENTS,
  TOP_LEVEL_DECISION_EVENTS,
  USER_PROMPT_TIMEOUT_S,
  limitText,
} from './constants.mjs';

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

export function ifConditionPasses(ifExpr, eventName, toolName, toolInput) {
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

function resolvePlaceholders(str, projectDir, pluginData, pluginRoot = null) {
  if (typeof str !== 'string') return str;
  const resolvedProject = projectDir || process.cwd();
  const resolvedPluginRoot = pluginRoot || resolvedProject;
  const resolvedPluginData = pluginData || resolvedProject;
  return str
    .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, resolvedProject)
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, resolvedPluginRoot)
    .replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, resolvedPluginData)
    .replace(/\$\{MIXDOG_PROJECT_DIR\}/g, resolvedProject)
    .replace(/\$\{MIXDOG_PLUGIN_ROOT\}/g, resolvedPluginRoot)
    .replace(/\$\{MIXDOG_PLUGIN_DATA\}/g, resolvedPluginData);
}

export function handlerTimeoutS(handler, eventName) {
  if (Number.isFinite(handler.timeout) && handler.timeout > 0) return handler.timeout;
  if (handler.type === 'prompt') return DEFAULT_PROMPT_TIMEOUT_S;
  if (handler.type === 'agent') return DEFAULT_AGENT_TIMEOUT_S;
  if (handler.type === 'mcp_tool') return DEFAULT_COMMAND_TIMEOUT_S;
  if (eventName === 'UserPromptSubmit') return USER_PROMPT_TIMEOUT_S;
  if (eventName === 'MessageDisplay') return MESSAGE_DISPLAY_TIMEOUT_S;
  return DEFAULT_COMMAND_TIMEOUT_S;
}

export function defaultShellKind() {
  return process.platform === 'win32' ? 'powershell' : 'bash';
}

// Kill a spawned hook's ENTIRE process tree, not just the immediate shell.
// A bare child.kill() only SIGTERMs the shell (bash -lc / powershell), leaving
// grandchildren orphaned. On POSIX we spawn detached and signal the negative
// pgid; on Windows we use taskkill /T /F to walk the tree.
function killProcessTree(child, signal = 'SIGTERM') {
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      try { child.kill(signal); } catch {}
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

// SIGTERM the tree, then escalate to SIGKILL after a short grace so a child
// that ignores/traps SIGTERM cannot linger.
const KILL_GRACE_MS = 2000;
function terminateTree(child) {
  killProcessTree(child, 'SIGTERM');
  const t = setTimeout(() => killProcessTree(child, 'SIGKILL'), KILL_GRACE_MS);
  t.unref?.();
}

// POSIX: detached=true creates a new process group so the negative-pid signal
// reaches grandchildren. Windows uses taskkill /T and ignores this flag.
function withProcessGroup(opts) {
  return process.platform === 'win32' ? opts : { ...opts, detached: true };
}

function commandSpawnSpec(handler, projectDir, pluginData) {
  const command = resolvePlaceholders(handler.command, projectDir, pluginData, handler._pluginRoot || null);
  if (Array.isArray(handler.args)) {
    return {
      command,
      args: handler.args.map((a) => resolvePlaceholders(String(a), projectDir, pluginData, handler._pluginRoot || null)),
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

function hookEnv(projectDir, pluginData, payload, pluginRoot = null) {
  const resolvedProject = projectDir || process.cwd();
  const resolvedPluginRoot = pluginRoot || resolvedProject;
  const resolvedPluginData = pluginData || resolvedProject;
  const env = {
    ...process.env,
    MIXDOG_PROJECT_DIR: resolvedProject,
    MIXDOG_PLUGIN_ROOT: resolvedPluginRoot,
    MIXDOG_PLUGIN_DATA: resolvedPluginData,
    CLAUDE_PROJECT_DIR: resolvedProject,
    CLAUDE_PLUGIN_ROOT: resolvedPluginRoot,
    CLAUDE_PLUGIN_DATA: resolvedPluginData,
  };
  const effortLevel = payload?.effort?.level || payload?.effort;
  if (effortLevel) env.CLAUDE_EFFORT = String(effortLevel);
  return env;
}

export function runCommandHandler(handler, payload, eventName, pluginData, onSpawnError = null, onRewake = null) {
  const projectDir = payload.cwd || process.cwd();
  const effectivePluginData = handler._pluginData || pluginData || null;
  const stdin = JSON.stringify(payload);
  const timeoutMs = Math.round(handlerTimeoutS(handler, eventName) * 1000);
  const spec = commandSpawnSpec(handler, projectDir, effectivePluginData);
  const baseOpts = {
    cwd: existsSync(projectDir) ? projectDir : undefined,
    env: hookEnv(projectDir, effectivePluginData, payload, handler._pluginRoot || null),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  };

  if (handler.asyncRewake === true) {
    try {
      const child = spawn(spec.command, spec.args, withProcessGroup(baseOpts));
      let bgStdout = '';
      let bgStderr = '';
      let bgStdoutBytes = 0;
      let bgStderrBytes = 0;
      let killed = false;
      child.stdout?.on('data', (chunk) => {
        bgStdoutBytes += chunk.length;
        if (bgStdoutBytes <= MAX_BUFFER_BYTES) bgStdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk) => {
        bgStderrBytes += chunk.length;
        if (bgStderrBytes <= MAX_BUFFER_BYTES) bgStderr += chunk.toString('utf8');
      });
      const killTimer = setTimeout(() => {
        killed = true;
        try { child.stdout?.removeAllListeners('data'); } catch {}
        try { child.stderr?.removeAllListeners('data'); } catch {}
        terminateTree(child);
      }, timeoutMs);
      killTimer.unref?.();
      child.on('error', (error) => {
        clearTimeout(killTimer);
        if (typeof onSpawnError === 'function') onSpawnError(error);
      });
      child.on('close', (code) => {
        clearTimeout(killTimer);
        try {
          if (!killed && code === 2 && typeof onRewake === 'function') {
            const text = (bgStderr || '').trim() || (bgStdout || '').trim();
            onRewake({ eventName, payload, text });
          }
        } catch {}
      });
      child.stdin?.end(stdin);
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

  if (handler.async === true) {
    try {
      const child = spawn(spec.command, spec.args, withProcessGroup({
        ...baseOpts,
        stdio: ['pipe', 'ignore', 'ignore'],
      }));
      // Detached async hooks were previously fire-and-forget with no timeout,
      // orphaning long-running/hung children. Enforce the same timeout and
      // reap the whole tree on expiry.
      let reaped = false;
      const killTimer = setTimeout(() => {
        reaped = true;
        terminateTree(child);
      }, timeoutMs);
      killTimer.unref?.();
      child.on('error', () => clearTimeout(killTimer));
      child.on('close', () => clearTimeout(killTimer));
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
      child = spawn(spec.command, spec.args, withProcessGroup(baseOpts));
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
      terminateTree(child);
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

// Block SSRF: only http(s), and by default refuse private/loopback/link-local
// hosts unless the handler explicitly opts in (allowPrivateHosts) or the host
// is on the handler's allowedHosts list.
function isPrivateHostname(host) {
  let h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  h = h.replace(/\.$/, '');            // strip trailing dot (localhost.)
  h = h.replace(/^::ffff:/, '');       // unmap IPv4-mapped IPv6 (::ffff:127.0.0.1)
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

function validateHttpUrl(handler) {
  let url;
  try {
    url = new URL(String(handler.url));
  } catch {
    return { error: `invalid hook URL: ${handler.url}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `blocked non-http(s) hook URL scheme: ${url.protocol}` };
  }
  const allowedHosts = Array.isArray(handler.allowedHosts)
    ? handler.allowedHosts.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const host = url.hostname.toLowerCase();
  if (allowedHosts.includes(host)) return { url };
  if (isPrivateHostname(host) && handler.allowPrivateHosts !== true) {
    return { error: `blocked hook URL to private/loopback host: ${url.hostname} (set allowPrivateHosts or allowedHosts to opt in)` };
  }
  return { url };
}

export async function runHttpHandler(handler, payload, eventName) {
  if (typeof fetch !== 'function') {
    return { exitCode: -1, stdout: '', stderr: 'fetch is not available', timedOut: false, spawnError: new Error('fetch is not available') };
  }
  const checked = validateHttpUrl(handler);
  if (checked.error) {
    return { exitCode: -1, stdout: '', stderr: checked.error, timedOut: false, spawnError: new Error(checked.error) };
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
    const response = await fetch(checked.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'error',
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

export async function runMcpToolHandler(handler, payload, eventName, mcpToolRunner) {
  const timeoutMs = Math.round(handlerTimeoutS(handler, eventName) * 1000);
  let name = String(handler.tool || '').trim();
  if (handler.server && !name.startsWith('mcp__')) {
    name = `mcp__${String(handler.server).trim()}__${name}`;
  }
  if (!name) {
    return { exitCode: -1, stdout: '', stderr: 'mcp_tool handler missing tool name', timedOut: false, spawnError: null };
  }
  let timer = null;
  try {
    const runPromise = Promise.resolve(mcpToolRunner({ name, args: payload }));
    const text = await Promise.race([
      runPromise,
      new Promise((_r, reject) => {
        timer = setTimeout(() => reject(new Error(`mcp_tool hook timed out: ${name}`)), timeoutMs);
        // No unref: this timer must keep the event loop alive so the race can
        // settle even when the runner promise never resolves. Cleared in finally.
      }),
    ]);
    return { exitCode: 0, stdout: limitText(String(text ?? '')), stderr: '', timedOut: false, spawnError: null };
  } catch (error) {
    const timedOut = /timed out/i.test(error?.message || '');
    return { exitCode: -1, stdout: '', stderr: error?.message || String(error), timedOut, spawnError: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runPromptHandler(handler, payload, eventName, promptRunner) {
  const timeoutMs = Math.round(handlerTimeoutS(handler, eventName) * 1000);
  const prompt = String(handler.prompt || '');
  if (!prompt) {
    return { exitCode: -1, stdout: '', stderr: 'prompt handler missing prompt', timedOut: false, spawnError: null };
  }
  let timer = null;
  try {
    const runPromise = Promise.resolve(promptRunner({ prompt, payload, timeoutMs }));
    const text = await Promise.race([
      runPromise,
      new Promise((_r, reject) => {
        timer = setTimeout(() => reject(new Error(`prompt hook timed out: ${eventName}`)), timeoutMs);
        // No unref: this timer must keep the event loop alive so the race can
        // settle even when the runner promise never resolves. Cleared in finally.
      }),
    ]);
    const raw = String(text ?? '').trim();
    const deny = (reason) => ({ exitCode: 2, stdout: '', stderr: reason, timedOut: false, spawnError: null });
    const allow = () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, spawnError: null });
    let verdict = null;
    try {
      verdict = JSON.parse(raw);
    } catch {
      verdict = undefined;
    }
    if (verdict && typeof verdict === 'object') {
      if (verdict.ok === false) return deny(String(verdict.reason || `blocked by ${eventName} prompt hook`));
      return allow();
    }
    // plain-text response
    const lowered = raw.toLowerCase();
    if (!raw || ['yes', 'true', 'allow', 'ok'].includes(lowered)) return allow();
    if (['no', 'false', 'deny', 'block'].includes(lowered)) return deny(raw || `blocked by ${eventName} prompt hook`);
    return allow();
  } catch (error) {
    const timedOut = /timed out/i.test(error?.message || '');
    return { exitCode: -1, stdout: '', stderr: error?.message || String(error), timedOut, spawnError: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function parseHandlerOutput(run, eventName) {
  const out = {
    block: false,
    reason: null,
    permissionDecision: null,
    updatedInput: null,
    updatedToolName: null,
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
      if (typeof hso.updatedToolName === 'string' && hso.updatedToolName.trim()) {
        out.updatedToolName = hso.updatedToolName.trim();
      }
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
