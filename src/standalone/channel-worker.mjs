import { execFile, fork, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startChildGuardian } from '../runtime/shared/child-guardian.mjs';
import { claimSingletonOwner, readSingletonOwner, releaseSingletonOwner } from '../runtime/shared/singleton-owner.mjs';

const CHANNEL_TOOLS = new Set([
  'reply',
  'fetch',
  'react',
  'edit_message',
  'download_attachment',
  'schedule_status',
  'trigger_schedule',
  'schedule_control',
  'activate_channel_bridge',
  'reload_config',
  'inject_command',
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

function runtimeRoot() {
  return process.env.MIXDOG_RUNTIME_ROOT ? resolve(process.env.MIXDOG_RUNTIME_ROOT) : join(tmpdir(), 'mixdog');
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function parsePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

function readActiveInstance() {
  return readJson(join(runtimeRoot(), 'active-instance.json'));
}

function readOwnerSecret(instanceId) {
  const parsed = readJson(join(runtimeRoot(), `owner-secret-${String(instanceId)}.json`));
  return typeof parsed?.secret === 'string' ? parsed.secret : '';
}

function requestJson({ port, method = 'GET', path = '/', body = null, headers = {}, timeoutMs = 120_000 }) {
  return new Promise((resolvePromise, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch {}
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(parsed?.error || data || `HTTP ${res.statusCode}`));
          return;
        }
        resolvePromise(parsed ?? { raw: data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`channel owner request timed out: ${method} ${path}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text: String(text ?? '') }], ...(isError ? { isError: true } : {}) };
}

export function createStandaloneChannelWorker({
  entry,
  rootDir,
  dataDir,
  cwd = process.cwd(),
  onNotify,
} = {}) {
  if (!entry) throw new Error('channels runtime entry is required');
  if (!rootDir) throw new Error('channels runtime rootDir is required');
  if (!dataDir) throw new Error('channels runtime dataDir is required');

  let child = null;
  let readyPromise = null;
  let readyResolve = null;
  let readyReject = null;
  let stopPromise = null;
  let inProcessMod = null;
  let inProcessStartPromise = null;
  let nextCallId = 1;
  let parentExitHookInstalled = false;
  const pending = new Map();
  const ownedChildPids = new Set();
  const logPath = join(dataDir, 'channels-worker-standalone.log');
  const useProcessWorker = process.env.MIXDOG_CHANNEL_WORKER_PROCESS !== '0';
  const singletonEnabled = process.env.MIXDOG_CHANNEL_SINGLETON !== '0';
  const daemonEnabled = process.env.MIXDOG_CHANNEL_DAEMON !== '0';
  const ownerPath = join(dataDir, 'channels-worker-owner.json');
  const notifyBusPath = join(runtimeRoot(), 'channel-notifications.jsonl');
  const clientDir = join(runtimeRoot(), 'channel-clients');
  const clientPath = join(clientDir, `${process.pid}.json`);
  let ownerClaim = null;
  let ownerPid = process.pid;
  let notifyBusTimer = null;
  let notifyBusOffset = 0;
  let clientHeartbeatTimer = null;

  function writeClientHeartbeat() {
    try {
      mkdirSync(clientDir, { recursive: true });
      writeFileSync(clientPath, JSON.stringify({
        pid: process.pid,
        cwd,
        updatedAt: Date.now(),
      }));
    } catch {}
  }

  function startClientHeartbeat() {
    if (clientHeartbeatTimer) return;
    writeClientHeartbeat();
    clientHeartbeatTimer = setInterval(writeClientHeartbeat, 5000);
    clientHeartbeatTimer.unref?.();
    process.once('exit', stopClientHeartbeat);
  }

  function stopClientHeartbeat() {
    if (clientHeartbeatTimer) {
      clearInterval(clientHeartbeatTimer);
      clientHeartbeatTimer = null;
    }
    try { rmSync(clientPath, { force: true }); } catch {}
  }

  function startNotifyBus() {
    if (!onNotify || notifyBusTimer) return;
    try { notifyBusOffset = statSync(notifyBusPath).size; } catch { notifyBusOffset = 0; }
    notifyBusTimer = setInterval(pollNotifyBus, 500);
    notifyBusTimer.unref?.();
  }

  function stopNotifyBus() {
    if (!notifyBusTimer) return;
    clearInterval(notifyBusTimer);
    notifyBusTimer = null;
  }

  function pollNotifyBus() {
    let size = 0;
    try { size = statSync(notifyBusPath).size; } catch { return; }
    if (size < notifyBusOffset) notifyBusOffset = 0;
    if (size === notifyBusOffset) return;
    let chunk;
    try {
      const data = readFileSync(notifyBusPath);
      chunk = data.subarray(notifyBusOffset, size).toString('utf8');
      notifyBusOffset = size;
    } catch {
      return;
    }
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (!msg || typeof msg !== 'object') continue;
        onNotify({ type: 'notify', method: msg.method, params: msg.params, busId: msg.id, busPid: msg.pid });
      } catch {}
    }
  }

  startNotifyBus();
  startClientHeartbeat();

  function status() {
    const external = externalOwner();
    if (external) {
      return {
        running: false,
        pid: null,
        pending: pending.size,
        mode: 'external-owner',
        ownerPid: Number(external.pid) || null,
      };
    }
    if (!useProcessWorker) {
      return {
        running: Boolean(inProcessMod),
        pid: inProcessMod ? process.pid : null,
        pending: 0,
        mode: 'in-process',
      };
    }
    return {
      running: Boolean(child && child.exitCode == null && !child.killed),
      pid: child?.pid || null,
      pending: pending.size,
      mode: 'runtime',
    };
  }

  function externalOwner() {
    if (!singletonEnabled || ownerClaim?.owned) return null;
    const current = readSingletonOwner(ownerPath);
    if (current.alive && current.owner?.pid && Number(current.owner.pid) !== process.pid) return current.owner;
    return null;
  }

  function ensureOwner() {
    if (!singletonEnabled || ownerClaim?.owned) return true;
    ownerClaim = claimSingletonOwner(ownerPath, {
      kind: 'channel-worker-host',
      pid: process.pid,
      meta: { cwd },
    });
    if (!ownerClaim.owned) {
      logLine(logPath, `runtime owned by pid ${ownerClaim.owner?.pid || 'unknown'}; skipping local channel worker`);
      return false;
    }
    installParentExitHook();
    return true;
  }

  function releaseOwner() {
    if (!singletonEnabled || !ownerClaim?.owned) return;
    releaseSingletonOwner(ownerPath, ownerPid);
    ownerClaim = null;
    ownerPid = process.pid;
  }

  function rejectPending(error) {
    for (const [, item] of pending) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  }

  function start() {
    if (!useProcessWorker) return startInProcess();
    if (!ensureOwner()) return Promise.resolve(status());
    if (stopPromise) {
      return stopPromise.then(() => start());
    }
    if (child && child.exitCode == null && !child.killed) return readyPromise || Promise.resolve(status());
    readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    child = fork(entry, [], {
      cwd,
      execArgv: ['--require', WORKER_PRELOAD],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      detached: daemonEnabled,
      env: {
        ...process.env,
        MIXDOG_ROOT: rootDir,
        MIXDOG_DATA_DIR: dataDir,
        MIXDOG_STANDALONE: '1',
        MIXDOG_WORKER_MODE: '1',
        MIXDOG_CLI_OWNED: daemonEnabled ? '0' : '1',
        MIXDOG_CHANNEL_DAEMON: daemonEnabled ? '1' : '0',
        MIXDOG_CHANNELS_AUTO_BOOT: '0',
        MIXDOG_CHANNEL_FLAG: '1',
        MIXDOG_QUIET_SESSION_LOG: process.env.MIXDOG_QUIET_SESSION_LOG ?? '1',
      },
      windowsHide: true,
    });
    const spawnedPid = child.pid;
    if (daemonEnabled && spawnedPid && singletonEnabled) {
      releaseSingletonOwner(ownerPath, process.pid);
      ownerClaim = claimSingletonOwner(ownerPath, {
        kind: 'channel-worker-daemon',
        pid: spawnedPid,
        meta: { cwd, launcherPid: process.pid },
      });
      ownerPid = spawnedPid;
    }
    if (!daemonEnabled) {
      startChildGuardian({ childPid: spawnedPid, label: 'channel-worker', orphanGraceMs: 8000, forceGraceMs: 3000 });
      if (spawnedPid) ownedChildPids.add(spawnedPid);
    }
    installParentExitHook();

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
        if (!daemonEnabled) {
          try { onNotify?.(msg); } catch {}
        }
      }
    });

    child.on('exit', (code, signal) => {
      if (spawnedPid) ownedChildPids.delete(spawnedPid);
      if (daemonEnabled && spawnedPid) releaseSingletonOwner(ownerPath, spawnedPid);
      if (daemonEnabled && ownerPid === spawnedPid) {
        ownerClaim = null;
        ownerPid = process.pid;
      }
      const error = new Error(`channels runtime exited (${signal || (code ?? 'unknown')})`);
      if (readyReject) readyReject(error);
      readyResolve = null;
      readyReject = null;
      rejectPending(error);
      child = null;
      readyPromise = null;
    });

    child.on('error', (error) => {
      logLine(logPath, `runtime error: ${error?.message || error}`);
      if (readyReject) readyReject(error);
      readyResolve = null;
      readyReject = null;
      rejectPending(error);
    });

    return readyPromise;
  }

  async function startInProcess() {
    if (!ensureOwner()) return status();
    if (inProcessMod) return status();
    if (inProcessStartPromise) return inProcessStartPromise;
    inProcessStartPromise = (async () => {
      process.env.MIXDOG_ROOT = rootDir;
      process.env.MIXDOG_DATA_DIR = dataDir;
      process.env.MIXDOG_STANDALONE ??= '1';
      process.env.MIXDOG_CHANNEL_FLAG ??= '1';
      process.env.MIXDOG_CHANNELS_AUTO_BOOT = '0';
      process.env.MIXDOG_CLI_OWNED = '1';
      const mod = await import(pathToFileURL(entry).href);
      if (typeof mod?.start !== 'function') throw new Error('channels runtime does not export start()');
      await mod.start();
      inProcessMod = mod;
      return status();
    })().finally(() => {
      inProcessStartPromise = null;
    });
    return inProcessStartPromise;
  }

  async function execute(name, args = {}, { timeoutMs = 120_000 } = {}) {
    if (!CHANNEL_TOOLS.has(name)) throw new Error(`unknown channel tool: ${name}`);
    if (!ensureOwner()) {
      return await executeViaOwnerHttp(name, args || {}, timeoutMs);
    }
    await start();
    if (!useProcessWorker) {
      const call = inProcessMod?.handleToolCallWithBridgeRetry || inProcessMod?.handleToolCall;
      if (typeof call !== 'function') throw new Error('channels runtime is not running');
      let timer = null;
      try {
        return await Promise.race([
          call(name, args || {}),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`channels tool timed out: ${name}`)), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
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

  async function executeViaOwnerHttp(name, args, timeoutMs) {
    const active = readActiveInstance();
    const port = parsePort(active?.httpPort);
    const instanceId = active?.instanceId;
    const token = readOwnerSecret(instanceId);
    if (!port || !token) {
      const owner = externalOwner();
      throw new Error(`channels runtime is owned by pid ${owner?.pid || 'unknown'} but owner HTTP is unavailable`);
    }
    const headers = {
      'x-owner-token': token,
      'x-owner-instance': String(instanceId || ''),
    };
    const post = (path, body) => requestJson({ port, method: 'POST', path, body, headers, timeoutMs });
    const get = (path) => requestJson({ port, method: 'GET', path, headers, timeoutMs });

    switch (name) {
      case 'reply': {
        const result = await post('/send', {
          chatId: args.chat_id,
          text: args.text,
          opts: {
            replyTo: args.reply_to,
            files: args.files ?? [],
            embeds: args.embeds ?? [],
            components: args.components ?? [],
          },
        });
        const ids = Array.isArray(result?.sentIds) ? result.sentIds : [];
        return textResult(ids.length === 1 ? `sent (id: ${ids[0]})` : `sent ${ids.length} parts (ids: ${ids.join(', ')})`);
      }
      case 'fetch': {
        const channel = encodeURIComponent(String(args.channel || ''));
        const limit = Math.max(1, Number(args.limit) || 20);
        const result = await get(`/fetch?channel=${channel}&limit=${limit}`);
        const msgs = Array.isArray(result?.messages) ? result.messages : [];
        const text = msgs.length === 0 ? '(no messages)' : msgs.map((m) => {
          const atts = Number(m.attachmentCount) > 0 ? ` +${m.attachmentCount}att` : '';
          return `[${m.ts}] ${m.user}: ${m.text}  (id: ${m.id}${atts})`;
        }).join('\n');
        return textResult(text);
      }
      case 'react':
        await post('/react', { chatId: args.chat_id, messageId: args.message_id, emoji: args.emoji });
        return textResult('reacted');
      case 'edit_message': {
        const result = await post('/edit', {
          chatId: args.chat_id,
          messageId: args.message_id,
          text: args.text,
          opts: { embeds: args.embeds ?? [], components: args.components ?? [] },
        });
        return textResult(`edited (id: ${result?.id ?? ''})`);
      }
      case 'download_attachment': {
        const result = await post('/download', { chatId: args.chat_id, messageId: args.message_id });
        const files = Array.isArray(result?.files) ? result.files : [];
        if (files.length === 0) return textResult('message has no attachments');
        return textResult(`downloaded ${files.length} attachment(s):\n${files.map((f) => `  ${f.path}  (${f.name}, ${f.contentType}, ${(Number(f.size || 0) / 1024).toFixed(0)}KB)`).join('\n')}`);
      }
      case 'schedule_status': {
        const result = await get('/schedule-status');
        return result?.result ?? textResult('no schedules configured');
      }
      case 'trigger_schedule': {
        const result = await post('/trigger-schedule', { name: args.name });
        return textResult(result?.result == null ? '' : String(result.result));
      }
      case 'schedule_control': {
        const result = await post('/schedule-control', { name: args.name, action: args.action, minutes: args.minutes });
        return result?.result ?? textResult(`unknown action: ${args.action}`, true);
      }
      case 'activate_channel_bridge':
        await post('/bridge/activate', { active: args.active === true });
        return textResult(`channel bridge ${args.active ? 'activated' : 'deactivated'}`);
      case 'inject_command':
        await post('/inject', { content: `/${String(args.command || '').trim()}`, source: 'mixdog-agent', type: 'command' });
        return textResult(`queued /${String(args.command || '').trim()} via channel owner`);
      case 'reload_config':
        return textResult('reload_config must run in the channel owner process', true);
      default:
        return textResult(`unknown channel tool: ${name}`, true);
    }
  }

  function forceKillTree(pid) {
    if (!pid) return;
    if (process.platform === 'win32') {
      execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      return;
    }
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }

  function forceKillTreeSync(pid) {
    if (!pid) return;
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {}
      return;
    }
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }

  function installParentExitHook() {
    if (parentExitHookInstalled) return;
    parentExitHookInstalled = true;
    process.once('exit', () => {
      if (!daemonEnabled) {
        for (const pid of Array.from(ownedChildPids)) {
          forceKillTreeSync(pid);
        }
        releaseOwner();
      }
      ownedChildPids.clear();
    });
  }

  function unrefChildHandles(target) {
    try { target?.unref?.(); } catch {}
    try { target?.stderr?.unref?.(); } catch {}
    try { target?.stdout?.unref?.(); } catch {}
    try { target?.stdin?.unref?.(); } catch {}
    try { target?.channel?.unref?.(); } catch {}
  }

  function stop(reason = 'standalone shutdown', options = {}) {
    const waitForExit = options?.waitForExit !== false;
    stopNotifyBus();
    stopClientHeartbeat();
    if (stopPromise) return stopPromise;
    if (!useProcessWorker) {
      if (!inProcessMod && !inProcessStartPromise) {
        releaseOwner();
        return Promise.resolve(false);
      }
      stopPromise = Promise.resolve(inProcessStartPromise)
        .catch(() => null)
        .then(async () => {
          try { await inProcessMod?.stop?.(reason); } catch {}
          inProcessMod = null;
          releaseOwner();
          return true;
        })
        .finally(() => {
          stopPromise = null;
        });
      return stopPromise;
    }
    if (!child) {
      stopNotifyBus();
      releaseOwner();
      return Promise.resolve(false);
    }
    const target = child;
    const targetPid = target.pid;
    child = null;
    if (daemonEnabled && options?.force !== true) {
      rejectPending(new Error(`channels runtime detached (${reason})`));
      if (targetPid) ownedChildPids.delete(targetPid);
      try { target.disconnect?.(); } catch {}
      unrefChildHandles(target);
      ownerClaim = null;
      ownerPid = process.pid;
      return Promise.resolve(true);
    }
    if (!waitForExit) {
      rejectPending(new Error(`channels runtime shutdown requested (${reason})`));
      if (targetPid) ownedChildPids.delete(targetPid);
      stopPromise = new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(sendTimer);
          stopPromise = null;
          unrefChildHandles(target);
          releaseOwner();
          resolve(ok);
        };
        const sendTimer = setTimeout(() => finish(false), 250);
        try {
          target.send?.({ type: 'shutdown', reason }, () => {
            try { target.disconnect?.(); } catch {}
            finish(true);
          });
        } catch {
          try { target.disconnect?.(); } catch {}
          finish(false);
        }
      });
      return stopPromise;
    }
    stopPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        stopPromise = null;
        stopNotifyBus();
        releaseOwner();
        resolve(ok);
      };
      const termTimer = setTimeout(() => {
        try {
          if (target.exitCode == null && !target.killed) target.kill('SIGTERM');
        } catch {}
      }, 1500);
      const killTimer = setTimeout(() => {
        try {
          if (target.exitCode == null) forceKillTree(targetPid);
        } catch {}
        try {
          if (target.exitCode == null && !target.killed) target.kill('SIGKILL');
        } catch {}
        finish(false);
      }, 5000);
      target.once('exit', () => finish(true));
      target.once('error', () => finish(false));
      try {
        target.send?.({ type: 'shutdown', reason }, () => {
          try { target.disconnect?.(); } catch {}
        });
      } catch {
        try { target.disconnect?.(); } catch {}
      }
    });
    return stopPromise;
  }

  return {
    start,
    execute,
    stop,
    status,
    isChannelTool: (name) => CHANNEL_TOOLS.has(name),
  };
}
