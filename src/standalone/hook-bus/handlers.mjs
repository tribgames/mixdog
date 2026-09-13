import { readResponseBuffer } from '../../runtime/shared/bounded-download.mjs';
import { runAbortable, throwIfAborted } from '../../runtime/shared/abort-race.mjs';
import { assertPublicUrl, pinnedFetch } from '../../runtime/web-search/lib/ssrf-guard.mjs';
import { handlerTimeoutS } from './handler-timeout.mjs';
export { handlerTimeoutS } from './handler-timeout.mjs';
export { defaultShellKind, runCommandHandler } from './command-handler.mjs';
import {
  EXIT2_BLOCK_EVENTS,
  MAX_BUFFER_BYTES,
  PLAIN_STDOUT_CONTEXT_EVENTS,
  TOOL_IF_EVENTS,
  TOP_LEVEL_DECISION_EVENTS,
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
  const allowPrivate = allowedHosts.includes(host) || handler.allowPrivateHosts === true;
  if (!allowPrivate && isPrivateHostname(host)) {
    return { error: `blocked hook URL to private/loopback host: ${url.hostname} (set allowPrivateHosts or allowedHosts to opt in)` };
  }
  if (!allowPrivate) {
    try {
      assertPublicUrl(url);
    } catch (error) {
      return { error: error?.message || String(error) };
    }
  }
  return { url, allowPrivate };
}

export const MAX_HTTP_HOOK_RESPONSE_BYTES = MAX_BUFFER_BYTES;

export async function runHttpHandler(handler, payload, eventName, {
  publicFetch = pinnedFetch,
  privateFetch = globalThis.fetch,
  signal,
} = {}) {
  throwIfAborted(signal);
  const checked = validateHttpUrl(handler);
  if (checked.error) {
    return { exitCode: -1, stdout: '', stderr: checked.error, timedOut: false, spawnError: new Error(checked.error) };
  }
  const requestFetch = checked.allowPrivate ? privateFetch : publicFetch;
  if (typeof requestFetch !== 'function') {
    return { exitCode: -1, stdout: '', stderr: 'fetch is not available', timedOut: false, spawnError: new Error('fetch is not available') };
  }
  const timeoutMs = Math.round(handlerTimeoutS(handler, eventName) * 1000);
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
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
    const response = await requestFetch(checked.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: requestSignal,
      redirect: 'error',
    });
    const text = (await readResponseBuffer(response, {
      maxBytes: MAX_HTTP_HOOK_RESPONSE_BYTES,
      label: 'HTTP hook response',
    })).toString('utf8');
    if (!response.ok) {
      return { exitCode: 1, stdout: text, stderr: `HTTP ${response.status} ${response.statusText}`.trim(), timedOut: false, spawnError: null };
    }
    return { exitCode: 0, stdout: text, stderr: '', timedOut: false, spawnError: null };
  } catch (error) {
    const aborted = controller.signal.aborted;
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

export async function runMcpToolHandler(handler, payload, eventName, mcpToolRunner, { signal } = {}) {
  throwIfAborted(signal);
  const timeoutMs = Math.round(handlerTimeoutS(handler, eventName) * 1000);
  let name = String(handler.tool || '').trim();
  if (handler.server && !name.startsWith('mcp__')) {
    name = `mcp__${String(handler.server).trim()}__${name}`;
  }
  if (!name) {
    return { exitCode: -1, stdout: '', stderr: 'mcp_tool handler missing tool name', timedOut: false, spawnError: null };
  }
  let timer = null;
  // Losing the race is not cancellation: without this signal the tool call kept
  // running (and holding its MCP slot) long after the hook gave up on it.
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const runPromise = Promise.resolve(mcpToolRunner({
      name,
      args: payload,
      signal: requestSignal,
      timeoutMs,
    }));
    // The abandoned call still settles somewhere; keep its rejection handled.
    runPromise.catch(() => {});
    const text = await Promise.race([
      runAbortable(signal, () => runPromise),
      new Promise((_r, reject) => {
        timer = setTimeout(() => {
          try { controller.abort(new Error(`mcp_tool hook timed out: ${name}`)); } catch {}
          reject(new Error(`mcp_tool hook timed out: ${name}`));
        }, timeoutMs);
        // No unref: this timer must keep the event loop alive so the race can
        // settle even when the runner promise never resolves. Cleared in finally.
      }),
    ]);
    return { exitCode: 0, stdout: limitText(String(text ?? '')), stderr: '', timedOut: false, spawnError: null };
  } catch (error) {
    const timedOut = !signal?.aborted && /timed out/i.test(error?.message || '');
    return { exitCode: -1, stdout: '', stderr: error?.message || String(error), timedOut, spawnError: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runPromptHandler(handler, payload, eventName, promptRunner, { signal } = {}) {
  throwIfAborted(signal);
  const timeoutMs = Math.round(handlerTimeoutS(handler, eventName) * 1000);
  const prompt = String(handler.prompt || '');
  if (!prompt) {
    return { exitCode: -1, stdout: '', stderr: 'prompt handler missing prompt', timedOut: false, spawnError: null };
  }
  let timer = null;
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const runPromise = Promise.resolve(promptRunner({ prompt, payload, timeoutMs, signal: requestSignal }));
    runPromise.catch(() => {});
    const text = await Promise.race([
      runAbortable(signal, () => runPromise),
      new Promise((_r, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`prompt hook timed out: ${eventName}`);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
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
    const timedOut = !signal?.aborted && /timed out/i.test(error?.message || '');
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
