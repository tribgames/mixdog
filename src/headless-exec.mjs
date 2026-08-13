import {
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { stderr, stdout } from 'node:process';

import {
  createPristineExecutionBoundary,
  validateExplicitPristineRoute,
} from './runtime/shared/pristine-execution.mjs';
import { hasActiveBackgroundTasks } from './runtime/shared/background-tasks.mjs';
import { installProcessSignalCleanup } from './runtime/shared/process-shutdown.mjs';
import { applyUsageDelta, createSessionStats } from './ui/session-stats.mjs';

function clean(value) {
  return String(value ?? '').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForTrackedTasks({
  sessionId,
  clientHostPid = process.pid,
  hasActiveTasks = hasActiveBackgroundTasks,
  pollMs = 100,
} = {}) {
  const scope = {
    ...(clean(sessionId) ? { callerSessionId: clean(sessionId) } : {}),
    clientHostPid,
  };
  while (hasActiveTasks(scope)) {
    await sleep(Math.max(10, Number(pollMs) || 100));
  }
}

function writeUsageDocument(path, stats, runtime) {
  const target = clean(path);
  if (!target) return;
  const session = {
    sessionId: clean(runtime?.id),
    agentRole: 'primary',
    models: [clean(runtime?.model)].filter(Boolean),
    inputTokens: stats.inputTokens,
    cacheTokens: stats.cachedTokens,
    cacheWriteTokens: stats.cacheWriteTokens,
    outputTokens: stats.outputTokens,
    toolCallCountApprox: 0,
  };
  const document = {
    schemaVersion: 1,
    sessions: [session],
    totals: {
      inputTokens: stats.inputTokens,
      cacheTokens: stats.cachedTokens,
      cacheWriteTokens: stats.cacheWriteTokens,
      outputTokens: stats.outputTokens,
      toolCallCountApprox: 0,
    },
  };
  const temp = `${target}.tmp-${process.pid}`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

export async function runHeadlessExec({
  message,
  provider,
  model,
  effort,
  fast,
  cwd = process.cwd(),
  write = (text) => stdout.write(text),
  writeErr = (text) => stderr.write(text),
  usageLogPath = process.env.MIXDOG_USAGE_LOG,
  boundaryFactory = createPristineExecutionBoundary,
  runtimeFactory = null,
  hasActiveTasks = hasActiveBackgroundTasks,
  installSignalCleanupFn = installProcessSignalCleanup,
  idlePollMs = 100,
} = {}) {
  const prompt = clean(message);
  if (!prompt) {
    writeErr('mixdog: message is required\n');
    return 1;
  }
  const routeError = validateExplicitPristineRoute({ provider, model, effort, fast });
  if (routeError) {
    writeErr(`mixdog: ${routeError}\n`);
    return 1;
  }

  const stats = createSessionStats();
  let boundary = null;
  let runtime = null;
  let signalCleanup = null;
  let cleanupPromise = null;
  let code = 1;
  const cleanup = (reason = 'exec-exit') => {
    cleanupPromise ??= (async () => {
      try {
        if (runtime) await runtime.close(reason);
      } finally {
        boundary?.cleanup();
      }
    })();
    return cleanupPromise;
  };

  try {
    boundary = boundaryFactory({ provider, model, effort, fast });
    signalCleanup = installSignalCleanupFn({
      name: 'mixdog-exec',
      timeoutMs: 6500,
      cleanup,
    });
    const createRuntime = runtimeFactory || (
      await import('./mixdog-session-runtime.mjs')
    ).createMixdogSessionRuntime;
    runtime = await createRuntime({
      provider,
      model,
      cwd,
      toolMode: 'full',
      approvalMode: 'implicit',
      disallowDelegation: true,
      initialConfig: boundary.loadConfig(),
    });
    const { result } = await runtime.ask(prompt, {
      onTextReset: () => true,
      onUsageDelta: (delta) => applyUsageDelta(stats, delta),
    });
    await waitForTrackedTasks({
      sessionId: runtime.id,
      clientHostPid: runtime.clientHostPid,
      hasActiveTasks,
      pollMs: idlePollMs,
    });
    const text = String(result?.content ?? result?.text ?? '');
    if (text) write(text.endsWith('\n') ? text : `${text}\n`);
    code = 0;
  } catch (error) {
    writeErr(`mixdog: ${error?.message || error}\n`);
  } finally {
    try {
      writeUsageDocument(usageLogPath, stats, runtime);
    } catch (error) {
      writeErr(`mixdog: usage log write failed: ${error?.message || error}\n`);
    }
    try {
      await cleanup('exec-exit');
    } catch (error) {
      writeErr(`mixdog: shutdown failed: ${error?.message || error}\n`);
      code = 1;
    } finally {
      signalCleanup?.uninstall();
    }
  }
  return code;
}
