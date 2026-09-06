import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { physicalAsarPath } from '../shared/asar-path.mjs';
import { acceptSessionIdentity, drainSessionClient, officeCleanupError, sessionClients, stopSessionClient, stopMicrosoftOfficeSessionClients } from './office-session-client.mjs';

export { stopMicrosoftOfficeSessionClients as _stopMicrosoftOfficeSessionClients } from './office-session-client.mjs';

const HOST_SCRIPT = physicalAsarPath(
  fileURLToPath(new URL('./office-com-host.ps1', import.meta.url)),
);
const SESSION_HOST_SCRIPT = physicalAsarPath(
  fileURLToPath(new URL('./office-com-session-host.ps1', import.meta.url)),
);
const DEFAULT_TIMEOUT_MS = 90_000;
let nextRequestId = 1;

function powershellProgram() {
  return process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe';
}

export function microsoftOfficeComSupported() {
  return process.platform === 'win32';
}

function spawnPowerShell(script) {
  return spawn(powershellProgram(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Sta',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
  ], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function callMicrosoftOfficeOnce(payload, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal = null,
} = {}) {
  return await new Promise((resolve) => {
    const child = spawnPowerShell(HOST_SCRIPT);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let draining = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(value);
    };
    const beginCleanup = (error, cancelled = false) => {
      if (draining) return;
      draining = true;
      clearTimeout(timer);
      const client = { child, pending: new Map(), get stderr() { return stderr; } };
      void drainSessionClient(client, error).then((cleanup) => {
        finish({ ok: false, cancelled, error: officeCleanupError(error, cleanup), operationMayHaveCompleted: true, cleanup });
      });
    };
    const onAbort = () => beginCleanup('Microsoft Office operation was cancelled', true);
    const timer = setTimeout(() => {
      beginCleanup(`Microsoft Office operation timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ ok: false, error: error?.message || String(error) }));
    child.on('close', (code) => {
      if (settled) return;
      if (draining) return;
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const last = lines.at(-1) || '';
      try {
        const parsed = JSON.parse(last);
        const cleanupErrors = stderr.split(/\r?\n/).filter((line) => line.includes('MIXDOG_OFFICE_CLEANUP'));
        finish(cleanupErrors.length ? {
          ...parsed, ok: false, operationCompleted: parsed.ok === true,
          error: 'Office operation finished but cleanup failed; do not replay the operation.',
          cleanup: { ok: false, errors: cleanupErrors },
        } : parsed);
      } catch {
        finish({
          ok: false,
          error: stderr.trim() || last || `Microsoft Office host exited with code ${code}`,
        });
      }
    });
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stdin.end(JSON.stringify(payload ?? {}), 'utf8');
  });
}

// The session host is unref'd so an idle session never pins the process; the
// price is that a process leaving without `close` (a crashed run, a script that
// exits after a failed finalize) would orphan the host and the background
// PowerPoint it owns, which then holds the file open (EBUSY on the next author).
// One synchronous exit hook stops every live client — an attached (user-owned)
// application is never killed, only its host.
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    stopMicrosoftOfficeSessionClients(sessionClients, 'process exit');
  });
}

function createSessionClient(sessionId) {
  installExitHook();
  const child = spawnPowerShell(SESSION_HOST_SCRIPT);
  child.unref();
  child.stdin.unref?.();
  child.stdout.unref?.();
  child.stderr.unref?.();
  const client = {
    sessionId,
    child,
    pending: new Map(),
    stderr: '',
    closed: false,
    readline: createInterface({ input: child.stdout }),
  };
  client.readline.on('line', (line) => {
    const text = String(line || '').trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const requestId = String(message.requestId || '');
    // Ownership notifications can precede an open response or arrive after
    // cancellation removed the pending request.
    acceptSessionIdentity(client, message);
    const pending = client.pending.get(requestId);
    if (!pending) return;
    client.pending.delete(requestId);
    clearTimeout(pending.timer);
    delete message.requestId;
    pending.resolve(message);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    client.stderr = `${client.stderr}${chunk}`.slice(-16_000);
  });
  child.on('error', (error) => stopSessionClient(client, error?.message || String(error)));
  child.on('close', (code) => {
    if (client.closed) return;
    stopSessionClient(
      client,
      client.stderr.trim() || `Microsoft Office session host exited with code ${code}`,
    );
  });
  sessionClients.set(sessionId, client);
  return client;
}

async function requestSessionClient(client, payload, timeoutMs = DEFAULT_TIMEOUT_MS, signal = null) {
  if (!client || client.closed || client.closing) {
    return { ok: false, backend: 'microsoft-office-com', error: 'Microsoft Office session host is unavailable' };
  }
  const requestId = `office_request_${nextRequestId++}`;
  return await new Promise((resolve) => {
    const settle = (value) => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve(value);
    };
    const onAbort = async () => {
      client.pending.delete(requestId);
      clearTimeout(timer);
      const cleanup = await drainSessionClient(client, 'Microsoft Office operation was cancelled');
      settle({ ok: false, backend: 'microsoft-office-com', cancelled: true, error: officeCleanupError('Microsoft Office operation was cancelled', cleanup), cleanup });
    };
    const timer = setTimeout(async () => {
      client.pending.delete(requestId);
      signal?.removeEventListener?.('abort', onAbort);
      const cleanup = await drainSessionClient(client, `Microsoft Office session timed out after ${timeoutMs}ms`);
      settle({
        ok: false,
        backend: 'microsoft-office-com',
        error: officeCleanupError(`Microsoft Office operation timed out after ${timeoutMs}ms`, cleanup),
        cleanup,
      });
    }, timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    client.pending.set(requestId, { resolve: settle, timer });
    try {
      client.child.stdin.write(`${JSON.stringify({ ...payload, requestId })}\n`, 'utf8');
    } catch (error) {
      clearTimeout(timer);
      client.pending.delete(requestId);
      void drainSessionClient(client, error?.message || String(error)).then((cleanup) => {
        settle({ ok: false, backend: 'microsoft-office-com', error: officeCleanupError(error?.message || String(error), cleanup), cleanup });
      });
    }
  });
}

export async function openMicrosoftOfficeSession(payload, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal = null,
} = {}) {
  if (!microsoftOfficeComSupported()) {
    return { ok: false, available: false, error: 'Microsoft Office COM is available on Windows only' };
  }
  const sessionId = String(payload?.session || '');
  if (!sessionId) return { ok: false, error: 'Microsoft Office session id is required' };
  if (sessionClients.has(sessionId)) return { ok: false, error: `Microsoft Office session already exists: ${sessionId}` };
  const client = createSessionClient(sessionId);
  const result = await requestSessionClient(client, { ...payload, action: 'open_session' }, timeoutMs, signal);
  if (!result.ok && !client.closing) {
    result.cleanup ||= await drainSessionClient(client, result.error);
    result.error = officeCleanupError(result.error, result.cleanup);
  }
  return result;
}

export async function closeMicrosoftOfficeSession(sessionId, {
  save = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  closeTimeoutMs = 15_000,
  signal = null,
} = {}) {
  const client = sessionClients.get(String(sessionId));
  if (!client) return { ok: false, closed: false, error: 'Office session host is unavailable; application cleanup cannot be confirmed.' };
  const result = await requestSessionClient(client, {
    action: 'close_session',
    session: String(sessionId),
    save,
  }, timeoutMs, signal);
  if (result.ok) {
    sessionClients.delete(String(sessionId));
    try { client.child.stdin.end(); } catch {}
    const graceful = client.closed || client.child.exitCode !== null
      ? true
      : await Promise.race([
        new Promise((resolve) => client.child.once('close', () => resolve(true))),
        new Promise((resolve) => setTimeout(() => resolve(false), closeTimeoutMs)),
      ]);
    client.closed = true;
    try { client.readline.close(); } catch {}
    if (!graceful) {
      try { client.child.kill(); } catch {}
      result.forcedHostCleanup = true;
    }
  }
  return result;
}

export async function callMicrosoftOffice(payload, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal = null,
} = {}) {
  if (!microsoftOfficeComSupported()) {
    return { ok: false, available: false, error: 'Microsoft Office COM is available on Windows only' };
  }
  const sessionId = String(payload?.session || '');
  if (sessionId) {
    const client = sessionClients.get(sessionId);
    if (!client) {
      return { ok: false, backend: 'microsoft-office-com', error: `Unknown Microsoft Office session: ${sessionId}` };
    }
    return await requestSessionClient(client, payload, timeoutMs, signal);
  }
  return await callMicrosoftOfficeOnce(payload, { timeoutMs, signal });
}

export async function detectMicrosoftOffice({ format = '', path = '' } = {}) {
  return await callMicrosoftOfficeOnce({ action: 'detect', format, path }, { timeoutMs: 20_000 });
}

export function resetMicrosoftOfficeSessionsForTest() {
  stopMicrosoftOfficeSessionClients(sessionClients, 'Microsoft Office test reset');
}
