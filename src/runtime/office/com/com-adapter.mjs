import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { physicalAsarPath } from '../shared/asar-path.mjs';

const HOST_SCRIPT = physicalAsarPath(
  fileURLToPath(new URL('./office-com-host.ps1', import.meta.url)),
);
const SESSION_HOST_SCRIPT = physicalAsarPath(
  fileURLToPath(new URL('./office-com-session-host.ps1', import.meta.url)),
);
const DEFAULT_TIMEOUT_MS = 90_000;
const sessionClients = new Map();
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
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      try { child.kill(); } catch {}
      finish({ ok: false, cancelled: true, error: 'Microsoft Office operation was cancelled' });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, error: `Microsoft Office operation timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ ok: false, error: error?.message || String(error) }));
    child.on('close', (code) => {
      if (settled) return;
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const last = lines.at(-1) || '';
      try {
        const parsed = JSON.parse(last);
        finish(parsed);
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

function stopSessionClient(client, error = '') {
  if (!client || client.closed) return;
  client.closed = true;
  sessionClients.delete(client.sessionId);
  const failure = {
    ok: false,
    backend: 'microsoft-office-com',
    error: error || 'Microsoft Office session host stopped',
  };
  for (const pending of client.pending.values()) {
    clearTimeout(pending.timer);
    pending.resolve(failure);
  }
  client.pending.clear();
  try { client.readline.close(); } catch {}
  try { client.child.stdin.end(); } catch {}
  try { client.child.kill(); } catch {}
  if (client.ownership === 'owned' && Number(client.appPid) > 0) {
    try { process.kill(Number(client.appPid)); } catch {}
  }
}

function createSessionClient(sessionId) {
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
  if (!client || client.closed) {
    return { ok: false, backend: 'microsoft-office-com', error: 'Microsoft Office session host is unavailable' };
  }
  const requestId = `office_request_${nextRequestId++}`;
  return await new Promise((resolve) => {
    const settle = (value) => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      client.pending.delete(requestId);
      clearTimeout(timer);
      settle({ ok: false, backend: 'microsoft-office-com', cancelled: true, error: 'Microsoft Office operation was cancelled' });
      stopSessionClient(client, 'Microsoft Office operation was cancelled');
    };
    const timer = setTimeout(() => {
      client.pending.delete(requestId);
      settle({
        ok: false,
        backend: 'microsoft-office-com',
        error: `Microsoft Office operation timed out after ${timeoutMs}ms`,
      });
      stopSessionClient(client, `Microsoft Office session timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    client.pending.set(requestId, { resolve: settle, timer });
    try {
      client.child.stdin.write(`${JSON.stringify({ ...payload, requestId })}\n`, 'utf8');
    } catch (error) {
      clearTimeout(timer);
      client.pending.delete(requestId);
      settle({ ok: false, backend: 'microsoft-office-com', error: error?.message || String(error) });
      stopSessionClient(client, error?.message || String(error));
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
  if (!result.ok) {
    stopSessionClient(client, result.error);
  } else {
    client.ownership = result.ownership;
    client.appPid = result.appPid;
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
  if (!client) return { ok: true, closed: true, alreadyClosed: true };
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
      if (result.ownership === 'owned' && Number(result.appPid) > 0) {
        try { process.kill(Number(result.appPid)); } catch {}
      }
      result.forcedProcessCleanup = result.ownership === 'owned';
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
  for (const client of sessionClients.values()) stopSessionClient(client, 'Microsoft Office test reset');
  sessionClients.clear();
}
