// One spawned llama-server: the child, its bounded log, and the exit record
// that the owner publishes (lastExit / lastError) when it stops.
import { randomBytes } from 'node:crypto';

export function spawnServerState({ spawnFn, spec, launch, port, owner, onExit }) {
  const apiKey = randomBytes(32).toString('hex');
  const loadStartedAt = performance.now();
  const child = spawnFn(spec.executable, spec.args(port, apiKey, launch), {
    cwd: spec.cwd,
    env: { ...process.env, ...launch.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let resolveExit;
  const state = {
    child,
    key: spec.key,
    modelId: spec.modelId,
    apiKey,
    port,
    gpu: launch.gpu || null,
    baseURL: `http://127.0.0.1:${port}/v1`,
    loadStartedAt,
    ready: false,
    exited: false,
    expectedExit: false,
    log: '',
    spawnError: null,
    exit: new Promise((resolve) => {
      resolveExit = resolve;
    }),
  };
  owner.current = state;
  const appendLog = (chunk) => {
    state.log = `${state.log}${String(chunk)}`.slice(-16_384);
  };
  child.stdout?.on('data', appendLog);
  child.stderr?.on('data', appendLog);
  const recordExit = (exitCode, exitSignal) => {
    if (state.exited) return;
    state.exited = true;
    state.ready = false;
    owner.lastExit = {
      at: new Date().toISOString(),
      modelId: state.modelId,
      exitCode,
      signal: exitSignal || null,
      expected: state.expectedExit,
      log: redactedLog(state),
    };
    if (!state.expectedExit) {
      owner.lastError = `[local-provider] llama-server exited (${exitCode ?? exitSignal ?? 'spawn error'}): ${owner.lastExit.log.trim()}`;
    }
    if (owner.current === state) owner.current = null;
    resolveExit();
    try {
      onExit({ ...owner.lastExit });
    } catch {
      /* diagnostics cannot break lifecycle */
    }
  };
  child.once('error', (error) => {
    state.spawnError = error;
    appendLog(error.message);
    recordExit(null, null);
  });
  child.once('exit', recordExit);
  return state;
}

export function redactedLog(state) {
  return state.log.replaceAll(state.apiKey, '[redacted]');
}
