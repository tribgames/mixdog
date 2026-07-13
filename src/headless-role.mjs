import { stdout, stderr } from 'node:process';
import {
  createPristineExecutionBoundary,
  formatPristineExecutionAudit,
  validateExplicitPristineRoute,
} from './runtime/shared/pristine-execution.mjs';
import {
  installProcessSignalCleanup,
  waitWithTimeout,
} from './runtime/shared/process-shutdown.mjs';

const TERMINAL_STATUS_RE = /^status:\s*(completed|failed|error|cancelled|canceled)\b/im;
const FAILURE_STATUS_RE = /^status:\s*(failed|error|cancelled|canceled)\b/im;

function clean(value) {
  return String(value ?? '').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskIdFromOutput(text) {
  return clean(text).match(/agent task:\s*(\S+)/i)?.[1] || null;
}

function makeTag(agent) {
  return `headless-${agent}-${process.pid}-${Date.now()}`
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildHeadlessSpawnArgs({ agent, tag, cwd, message, provider, model, effort, fast } = {}) {
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

const HEADLESS_CLOSE_TIMEOUT_MS = 5000;
const HEADLESS_SHUTDOWN_TIMEOUT_MS = 6000;

async function buildAgentRunner(cwd, boundary) {
  // Import runtime/config modules only after MIXDOG_DATA_DIR and all behavioral
  // guards point at the ephemeral pristine boundary.
  const [
    { createStandaloneAgent },
    cfgMod,
    reg,
    mgr,
  ] = await Promise.all([
    import('./standalone/agent-tool.mjs'),
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

export async function runHeadlessRole({
  agent,
  message,
  provider,
  model,
  effort,
  fast,
  cwd = process.cwd(),
  write = (text) => stdout.write(text),
  writeErr = (text) => stderr.write(text),
  agentRunnerFactory = buildAgentRunner,
} = {}) {
  const cleanAgent = clean(agent);
  const cleanMessage = clean(message);
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

  let boundary = null;
  let agentRunner = null;
  let signalCleanup = null;
  let cleanupPromise = null;
  let taskId = null;
  let lastOutput = '';
  const cleanup = (reason = 'headless-exit') => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      try {
        if (agentRunner) {
          await waitWithTimeout(
            agentRunner.execute({ type: 'close', tag }, context),
            HEADLESS_CLOSE_TIMEOUT_MS,
            'headless agent close',
          );
        }
      } catch {
        // Boundary cleanup is mandatory even when the runtime close hangs.
      } finally {
        boundary?.cleanup();
      }
    })();
    return cleanupPromise;
  };
  try {
    try {
      boundary = createPristineExecutionBoundary({ provider, model, effort, fast });
    } catch (error) {
      writeErr(`mixdog: ${error?.message || error}\n`);
      return 1;
    }
    writeErr(`${formatPristineExecutionAudit(boundary.audit)}\n`);
    signalCleanup = installProcessSignalCleanup({
      name: 'mixdog-headless',
      timeoutMs: HEADLESS_SHUTDOWN_TIMEOUT_MS,
      cleanup,
    });
    agentRunner = await agentRunnerFactory(cwd, boundary);
    const started = await agentRunner.execute(spawnArgs, context);
    lastOutput = clean(started);
    taskId = taskIdFromOutput(started);
    if (!taskId) {
      write(`${lastOutput}\n`);
      return /^Error\b/i.test(lastOutput) ? 1 : 0;
    }

    for (;;) {
      lastOutput = clean(await agentRunner.execute({ type: 'read', task_id: taskId }, context));
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
