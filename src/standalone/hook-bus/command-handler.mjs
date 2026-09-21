import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { MAX_BUFFER_BYTES } from './constants.mjs';
import { handlerTimeoutS } from './handler-timeout.mjs';
import { abortReason, throwIfAborted } from '../../runtime/shared/abort-race.mjs';

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

export function defaultShellKind() {
  return process.platform === 'win32' ? 'powershell' : 'bash';
}

// POSIX children share a detached process group; Windows taskkill owns the tree.
function killProcessTree(child, signal = 'SIGTERM') {
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

const KILL_GRACE_MS = 2000;
function terminateTree(child) {
  killProcessTree(child, 'SIGTERM');
  // /F is already a hard termination. A later Windows retry could address a
  // recycled PID instead of the process this handler created.
  if (process.platform === 'win32') return;
  const timer = setTimeout(() => killProcessTree(child, 'SIGKILL'), KILL_GRACE_MS);
  timer.unref?.();
}

function withProcessGroup(opts) {
  return process.platform === 'win32' ? opts : { ...opts, detached: true };
}

function commandSpawnSpec(handler, projectDir, pluginData) {
  const command = resolvePlaceholders(handler.command, projectDir, pluginData, handler._pluginRoot || null);
  if (Array.isArray(handler.args)) {
    return {
      command,
      args: handler.args.map((a) =>
        resolvePlaceholders(String(a), projectDir, pluginData, handler._pluginRoot || null)
      ),
      shellKind: 'exec',
    };
  }
  const shellKind = handler.shell === 'powershell' || handler.shell === 'bash' ? handler.shell : defaultShellKind();
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

function writeHookInput(child, input, onError) {
  if (!child.stdin) return;
  const failed = (error) => {
    // Hooks may ignore their JSON input and exit before the write drains.
    // EOF is the Windows pipe-close result; EPIPE is its POSIX counterpart.
    if (error?.code === 'EOF' || error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED') return;
    onError(error);
  };
  child.stdin.on('error', failed);
  try {
    child.stdin.end(input);
  } catch (error) {
    failed(error);
  }
}

export function runCommandHandler(handler, payload, eventName, pluginData, onSpawnError = null, { signal } = {}) {
  throwIfAborted(signal);
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

  if (handler.async === true) {
    try {
      const child = spawn(
        spec.command,
        spec.args,
        withProcessGroup({
          ...baseOpts,
          stdio: ['pipe', 'ignore', 'ignore'],
        })
      );
      // Explicit async hooks outlive the initiating turn, but retain a bounded lifetime.
      const killTimer = setTimeout(() => terminateTree(child), timeoutMs);
      killTimer.unref?.();
      child.on('error', () => clearTimeout(killTimer));
      child.on('close', () => clearTimeout(killTimer));
      child.on('error', (error) => {
        if (typeof onSpawnError === 'function') onSpawnError(error);
      });
      writeHookInput(child, stdin, (error) => {
        terminateTree(child);
        if (typeof onSpawnError === 'function') onSpawnError(error);
      });
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
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Decode once: pipe chunks can split a UTF-8 code point. The retained
      // buffers remain subject to the same raw-byte cap as before.
      resolveRun({
        ...result,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8') || result.stderr || '',
      });
    };
    const fail = (error) =>
      finish({
        exitCode: -1,
        stderr: error?.message || String(error),
        timedOut: false,
        spawnError: error,
      });
    const onAbort = () => {
      fail(abortReason(signal));
      terminateTree(child);
    };
    try {
      child = spawn(spec.command, spec.args, withProcessGroup(baseOpts));
    } catch (error) {
      fail(error);
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      terminateTree(child);
      finish({
        exitCode: -1,
        stderr: `hook command timed out after ${timeoutMs}ms`,
        timedOut,
        spawnError: null,
      });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_BUFFER_BYTES) stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_BUFFER_BYTES) stderrChunks.push(chunk);
    });
    child.on('error', fail);
    child.on('close', (code, terminationSignal) => {
      finish({
        exitCode: !timedOut && typeof code === 'number' ? code : -1,
        stderr: terminationSignal ? `hook command terminated by ${terminationSignal}` : '',
        timedOut,
        spawnError: null,
      });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    writeHookInput(child, stdin, (error) => {
      terminateTree(child);
      fail(error);
    });
  });
}
