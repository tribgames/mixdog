import { fork } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHANNEL_TOOLS = new Set([
  'reply',
  'fetch',
  'react',
  'edit_message',
  'download_attachment',
  'schedule_status',
  'trigger_schedule',
  'schedule_control',
  'reload_config',
]);

const WORKER_PRELOAD = fileURLToPath(new URL('./channel-worker-preload.cjs', import.meta.url));

function logLine(path, line) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Logging must never break the TUI.
  }
}

export function createStandaloneChannelWorker({
  entry,
  rootDir,
  dataDir,
  cwd = process.cwd(),
  onNotify,
} = {}) {
  if (!entry) throw new Error('channels worker entry is required');
  if (!rootDir) throw new Error('channels worker rootDir is required');
  if (!dataDir) throw new Error('channels worker dataDir is required');

  let child = null;
  let readyPromise = null;
  let readyResolve = null;
  let readyReject = null;
  let nextCallId = 1;
  const pending = new Map();
  const logPath = join(dataDir, 'channels-worker-standalone.log');

  function status() {
    return {
      running: Boolean(child && child.exitCode == null && !child.killed),
      pid: child?.pid || null,
      pending: pending.size,
    };
  }

  function rejectPending(error) {
    for (const [, item] of pending) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  }

  function start() {
    if (child && child.exitCode == null && !child.killed) return readyPromise || Promise.resolve(status());
    readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    child = fork(entry, [], {
      cwd,
      execArgv: ['--require', WORKER_PRELOAD],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: rootDir,
        CLAUDE_PLUGIN_DATA: dataDir,
        MIXDOG_STANDALONE: '1',
        MIXDOG_WORKER_MODE: '1',
        MIXDOG_CHANNEL_FLAG: '1',
        MIXDOG_QUIET_SESSION_LOG: process.env.MIXDOG_QUIET_SESSION_LOG ?? '1',
      },
      windowsHide: true,
    });

    child.stderr?.on('data', (chunk) => {
      const text = String(chunk || '').trimEnd();
      if (text) logLine(logPath, text);
    });

    child.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') {
        readyResolve?.(status());
        readyResolve = null;
        readyReject = null;
        return;
      }
      if (msg.type === 'result' && msg.callId) {
        const item = pending.get(msg.callId);
        if (!item) return;
        pending.delete(msg.callId);
        clearTimeout(item.timer);
        if (msg.error) item.reject(new Error(msg.error));
        else item.resolve(msg.result);
        return;
      }
      if (msg.type === 'notify') {
        try { onNotify?.(msg); } catch {}
      }
    });

    child.on('exit', (code, signal) => {
      const error = new Error(`channels worker exited (${signal || (code ?? 'unknown')})`);
      if (readyReject) readyReject(error);
      readyResolve = null;
      readyReject = null;
      rejectPending(error);
      child = null;
      readyPromise = null;
    });

    child.on('error', (error) => {
      logLine(logPath, `worker error: ${error?.message || error}`);
      if (readyReject) readyReject(error);
      readyResolve = null;
      readyReject = null;
      rejectPending(error);
    });

    return readyPromise;
  }

  async function execute(name, args = {}, { timeoutMs = 120_000 } = {}) {
    if (!CHANNEL_TOOLS.has(name)) throw new Error(`unknown channel tool: ${name}`);
    await start();
    if (!child || !child.send) throw new Error('channels worker is not running');
    const callId = `ch_${nextCallId++}`;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(callId);
        reject(new Error(`channels tool timed out: ${name}`));
      }, timeoutMs);
      pending.set(callId, { resolve, reject, timer });
      child.send({ type: 'call', callId, name, args: args || {} }, (error) => {
        if (!error) return;
        pending.delete(callId);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function stop(reason = 'standalone shutdown') {
    if (!child) return;
    const target = child;
    child = null;
    try { target.send?.({ type: 'shutdown', reason }); } catch {}
    setTimeout(() => {
      try {
        if (target.exitCode == null && !target.killed) target.kill('SIGTERM');
      } catch {}
    }, 1500).unref?.();
  }

  return {
    start,
    execute,
    stop,
    status,
    isChannelTool: (name) => CHANNEL_TOOLS.has(name),
  };
}
