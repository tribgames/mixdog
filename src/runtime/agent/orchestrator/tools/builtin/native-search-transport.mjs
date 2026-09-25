// Crash-isolated transport for the resident native search engine.
//
// Search runs as one long-lived `mixdog-graph --serve-search` child. Keeping
// the Rust engine outside the daemon is intentional: a stuck native scan can
// be killed and restarted without blocking every session on the daemon loop.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { hiddenSpawnOpts } from '../../../../shared/spawn-flags.mjs';

/** Minimal event fan-out: one transport feeds exactly one client. */
function createEmitter() {
  const handlers = { line: null, stderr: null, error: null, exit: null };
  return {
    handlers,
    emit(name, ...args) {
      const handler = handlers[name];
      if (typeof handler !== 'function') return;
      try {
        handler(...args);
      } catch {
        /* a listener fault must not kill the transport */
      }
    },
  };
}

function createChildTransport(binaryPath, cwd) {
  const child = spawn(binaryPath, [cwd, '--serve-search'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...hiddenSpawnOpts,
  });
  const { handlers, emit } = createEmitter();
  // ref()/unref() apply to the child and each of its stdio handles.
  const setReferenced = (method) => {
    for (const handle of [child, child.stdin, child.stdout, child.stderr]) {
      try {
        handle?.[method]?.();
      } catch {
        /* detached handle */
      }
    }
  };
  child.stderr?.on?.('data', (chunk) => emit('stderr', chunk));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => emit('line', line));
  bindChildLifecycle(child, {
    onError: (error) => emit('error', error),
    onExit: (code, signal) => emit('exit', code, signal),
  });
  return {
    kind: 'child',
    child,
    write(text) {
      child.stdin.write(text);
    },
    end() {
      try {
        child.stdin?.end?.();
      } catch {
        /* already closed */
      }
    },
    kill(signal) {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    },
    ref() {
      setReferenced('ref');
    },
    unref() {
      setReferenced('unref');
    },
    on(name, handler) {
      handlers[name] = handler;
    },
  };
}

/**
 * ChildProcess stdin emits write failures asynchronously. A sync try/catch
 * around stdin.write cannot catch EPIPE; without this listener the session
 * runtime worker itself terminates and every active/queued turn is recovered.
 */
export function bindChildLifecycle(child, { onError, onExit } = {}) {
  if (!child?.on) return;
  child.on('error', onError);
  child.on('exit', onExit);
  child.stdin?.on?.('error', onError);
}

/**
 * Attach to the engine. Returns null until the verified binary is available;
 * throws only on an unexpected spawn failure, which the caller counts.
 */
export function createNativeSearchTransport({ binaryPath, cwd }) {
  if (!binaryPath) return null;
  return createChildTransport(binaryPath, cwd);
}
