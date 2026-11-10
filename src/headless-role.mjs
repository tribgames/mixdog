import { stdout, stderr } from 'node:process';
import {
  createPristineExecutionBoundary,
  formatPristineExecutionAudit,
  validateExplicitPristineRoute,
} from './runtime/shared/pristine-execution.mjs';
import { BUNDLED_PATCH_MANIFEST_PATH } from './runtime/agent/orchestrator/tools/patch-manifest-path.mjs';
import { installProcessSignalCleanup, waitWithTimeout } from './runtime/shared/process-shutdown.mjs';
import { sleep } from './runtime/shared/sleep.mjs';
import { clean } from './runtime/shared/clean.mjs';

const TERMINAL_STATUS_RE = /^status:\s*(completed|failed|error|cancelled|canceled)\b/im;
const FAILURE_STATUS_RE = /^status:\s*(failed|error|cancelled|canceled)\b/im;

function taskIdFromOutput(text) {
  return clean(text).match(/agent task:\s*(\S+)/i)?.[1] || null;
}

function makeTag(agent) {
  return `headless-${agent}-${process.pid}-${Date.now()}`.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
}

function buildHeadlessSpawnArgs({ agent, tag, cwd, message, provider, model, effort, fast } = {}) {
  const spawnArgs = {
    type: 'spawn',
    agent: clean(agent),
    tag,
    cwd,
    prompt: clean(message),
  };
  if (clean(provider)) spawnArgs.provider = clean(provider);
  if (clean(model)) spawnArgs.model = clean(model);
  if (clean(effort)) spawnArgs.effort = clean(effort);
  if (fast === true) spawnArgs.fast = true;
  return spawnArgs;
}

const HEADLESS_CLOSE_TIMEOUT_MS = 4500;
const HEADLESS_SHUTDOWN_TIMEOUT_MS = 6000;
const HEADLESS_CLEANUP_RESERVE_MS = 500;

async function buildAgentRunner(cwd, boundary) {
  // Import runtime/config modules only after MIXDOG_DATA_DIR and all behavioral
  // guards point at the ephemeral pristine boundary.
  const [{ createStandaloneAgent }, cfgMod, reg, mgr] = await Promise.all([
    import('./session-runtime/services/agent-tool.mjs'),
    import('./runtime/agent/orchestrator/config.mjs'),
    import('./runtime/agent/orchestrator/providers/registry.mjs'),
    import('./runtime/agent/orchestrator/session/manager.mjs'),
  ]);
  return createStandaloneAgent({
    cfgMod: {
      // Never call the general loader here: it scans every OS-keychain provider.
      loadConfig: boundary.loadConfig,
      resolveRuntimeSpec: cfgMod.resolveRuntimeSpec,
    },
    reg,
    mgr,
    dataDir: cfgMod.getPluginData(),
    cwd,
  });
}

// One-shot memoized shutdown: close the agent, drain the trace, close native
// patch servers, then remove the pristine boundary. Each step is time-boxed
// against a shared deadline and failures never skip the later steps.
function createRoleCleanup(run, { tag, context }) {
  let cleanupPromise = null;
  const shutdown = async () => {
    const deadline = Date.now() + HEADLESS_SHUTDOWN_TIMEOUT_MS - HEADLESS_CLEANUP_RESERVE_MS;
    const runCleanupStep = async (start, maxMs, label) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const budget = Math.min(maxMs, remaining);
      // waitWithTimeout intentionally unrefs its timer. Keep this one-shot
      // headless cleanup alive until the step settles or consumes its budget,
      // otherwise an unresolved close can terminate Node before `finally`.
      const keepAlive = setTimeout(() => {}, budget + 1);
      try {
        await waitWithTimeout(start(), budget, label);
      } finally {
        clearTimeout(keepAlive);
      }
    };
    try {
      if (run.agentRunner) {
        await runCleanupStep(
          () => run.agentRunner.execute({ type: 'close', tag }, context),
          HEADLESS_CLOSE_TIMEOUT_MS,
          'headless agent close'
        );
      }
    } catch {
      // Trace drain and boundary cleanup remain mandatory when close hangs.
    }
    try {
      if (run.drainTrace) {
        await runCleanupStep(run.drainTrace, HEADLESS_SHUTDOWN_TIMEOUT_MS, 'headless trace drain');
      }
    } catch {
      // Telemetry must never block cleanup of the pristine boundary.
    } finally {
      try {
        await runCleanupStep(
          async () => {
            const closeNativePatchServers = globalThis.__mixdogCloseNativePatchServers;
            if (typeof closeNativePatchServers === 'function') {
              await closeNativePatchServers();
            }
          },
          HEADLESS_CLOSE_TIMEOUT_MS,
          'headless native patch close'
        );
      } catch {
        // The boundary cleanup below remains mandatory if native shutdown hangs.
      } finally {
        run.boundary?.cleanup();
      }
    }
  };
  return () => {
    cleanupPromise ??= shutdown();
    return cleanupPromise;
  };
}

export async function runHeadlessRole({
  agent,
  message,
  provider,
  model,
  effort,
  fast,
  webSearch = false,
  memory = false,
  cwd = process.cwd(),
  write = (text) => stdout.write(text),
  writeErr = (text) => stderr.write(text),
  agentRunnerFactory = buildAgentRunner,
} = {}) {
  const cleanAgent = clean(agent);
  const cleanMessage = clean(message);
  // Web search and memory start OFF. This call can pass webSearch or memory;
  // exec accepts --web-search and rejects --memory. An explicit
  // MIXDOG_FEATURE_* value from the caller environment always wins.
  for (const [key, enabled] of [
    ['MIXDOG_FEATURE_WEB_SEARCH', webSearch],
    ['MIXDOG_FEATURE_MEMORY', memory],
  ]) {
    if (!clean(process.env[key])) process.env[key] = enabled === true ? '1' : '0';
  }
  if (!cleanAgent) {
    writeErr('mixdog: agent is required\n');
    return 1;
  }
  if (!cleanMessage) {
    writeErr('mixdog: message is required\n');
    return 1;
  }
  const routeError = validateExplicitPristineRoute({ provider, model, effort, fast });
  if (routeError) {
    writeErr(`mixdog: ${routeError}\n`);
    return 1;
  }

  const tag = makeTag(cleanAgent);
  const context = {
    invocationSource: 'headless',
    cwd,
    callerCwd: cwd,
    clientHostPid: process.pid,
  };
  const spawnArgs = buildHeadlessSpawnArgs({
    agent: cleanAgent,
    tag,
    cwd,
    message: cleanMessage,
    provider,
    model,
    effort,
    fast,
  });

  let signalCleanup = null;
  let taskId = null;
  let lastOutput = '';
  // Live handles the shutdown path reads at cleanup time, not at creation.
  const run = { boundary: null, agentRunner: null, drainTrace: null };
  const cleanup = createRoleCleanup(run, { tag, context });
  try {
    try {
      run.boundary = createPristineExecutionBoundary({
        provider,
        model,
        effort,
        fast,
        patchManifestPath: BUNDLED_PATCH_MANIFEST_PATH,
      });
    } catch (error) {
      writeErr(`mixdog: ${error?.message || error}\n`);
      return 1;
    }
    writeErr(`${formatPristineExecutionAudit(run.boundary.audit)}\n`);
    signalCleanup = installProcessSignalCleanup({
      name: 'mixdog-headless',
      timeoutMs: HEADLESS_SHUTDOWN_TIMEOUT_MS,
      cleanup,
    });
    run.agentRunner = await agentRunnerFactory(cwd, run.boundary);
    try {
      ({ drainAgentTrace: run.drainTrace } = await import('./runtime/agent/orchestrator/agent-trace.mjs'));
    } catch {
      run.drainTrace = null;
    }
    const started = await run.agentRunner.execute(spawnArgs, context);
    lastOutput = clean(started);
    taskId = taskIdFromOutput(started);
    if (!taskId) {
      write(`${lastOutput}\n`);
      return /^Error\b/i.test(lastOutput) ? 1 : 0;
    }

    for (;;) {
      lastOutput = clean(await run.agentRunner.execute({ type: 'read', task_id: taskId }, context));
      if (TERMINAL_STATUS_RE.test(lastOutput)) break;
      await sleep(500);
    }

    write(`${lastOutput}\n`);
    return FAILURE_STATUS_RE.test(lastOutput) ? 1 : 0;
  } finally {
    try {
      await cleanup('headless-exit');
    } finally {
      signalCleanup?.uninstall();
    }
  }
}
