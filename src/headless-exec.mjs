import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stderr, stdout } from 'node:process';

import {
  createPristineExecutionBoundary,
  validateExplicitPristineRoute,
} from './runtime/shared/pristine-execution.mjs';
import { hasActiveBackgroundTasks } from './runtime/shared/background-tasks.mjs';
import { installProcessSignalCleanup } from './runtime/shared/process-shutdown.mjs';
import { closeUsageLedgers } from './runtime/shared/llm/usage-ledger.mjs';
import { stopStandaloneMemoryRuntimesForProcess } from './standalone/memory-runtime-proxy.mjs';
import { shutdownDaemonForRuntimeRoot } from './standalone/session-client.mjs';
import { applyUsageDelta, createSessionStats } from './ui/session-stats.mjs';
import { clean } from './runtime/shared/clean.mjs';
import { createJsonLifecycle, nonNegativeNumber } from './headless-json-lifecycle.mjs';

export async function prewarmHeadlessSearch(
  _cwd,
  { loadNativeSearch = () => import('./runtime/agent/orchestrator/tools/builtin/native-search-client.mjs') } = {}
) {
  const nativeSearch = await loadNativeSearch();
  await nativeSearch.warmNativeSearchServer();
}

function writeUsageDocument(path, stats, runtime, toolCallCount = 0, observedModels = []) {
  const target = clean(path);
  if (!target) return;
  const models = [clean(runtime?.model), ...Array.from(observedModels || [], clean)].filter(
    (value, index, values) => value && values.indexOf(value) === index
  );
  const session = {
    sessionId: clean(runtime?.id),
    agentRole: 'primary',
    models,
    inputTokens: stats.inputTokens,
    cacheTokens: stats.cachedTokens,
    cacheWriteTokens: stats.cacheWriteTokens,
    outputTokens: stats.outputTokens,
    toolCallCountApprox: nonNegativeNumber(toolCallCount),
  };
  const document = {
    schemaVersion: 1,
    sessions: [session],
    totals: {
      inputTokens: stats.inputTokens,
      cacheTokens: stats.cachedTokens,
      cacheWriteTokens: stats.cacheWriteTokens,
      outputTokens: stats.outputTokens,
      toolCallCountApprox: nonNegativeNumber(toolCallCount),
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
  webSearch = false,
  json = false,
  cwd = process.cwd(),
  write = (text) => stdout.write(text),
  writeErr = (text) => stderr.write(text),
  usageLogPath = process.env.MIXDOG_USAGE_LOG,
  boundaryFactory = createPristineExecutionBoundary,
  runtimeFactory = null,
  memoryRuntimeCleanup = stopStandaloneMemoryRuntimesForProcess,
  daemonRuntimeCleanup = shutdownDaemonForRuntimeRoot,
  usageLedgerCleanup = closeUsageLedgers,
  hasActiveTasks = hasActiveBackgroundTasks,
  installSignalCleanupFn = installProcessSignalCleanup,
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
  const observedModels = new Set();
  const lifecycle = json
    ? createJsonLifecycle({
        write,
        stats,
        provider,
        model,
        effort,
        fast,
        cwd,
        webSearch,
      })
    : null;
  const outcome = await executeHeadlessPrompt(prompt, {
    provider,
    model,
    effort,
    fast,
    cwd,
    webSearch,
    json,
    write,
    writeErr,
    usageLogPath,
    stats,
    observedModels,
    lifecycle,
    boundaryFactory,
    runtimeFactory,
    memoryRuntimeCleanup,
    daemonRuntimeCleanup,
    usageLedgerCleanup,
    hasActiveTasks,
    installSignalCleanupFn,
  });
  if (lifecycle) {
    if (outcome.code === 0) lifecycle.succeed(outcome.resultText, outcome.result);
    else lifecycle.fail(outcome.executionError || new Error('execution failed'));
  }
  return outcome.code;
}

// Boots the pristine runtime, asks once, and always closes it; the caller
// finalizes the lifecycle from the outcome.
async function executeHeadlessPrompt(
  prompt,
  {
    provider,
    model,
    effort,
    fast,
    cwd,
    webSearch,
    json,
    write,
    writeErr,
    usageLogPath,
    stats,
    observedModels,
    lifecycle,
    boundaryFactory,
    runtimeFactory,
    memoryRuntimeCleanup,
    daemonRuntimeCleanup,
    usageLedgerCleanup,
    hasActiveTasks,
    installSignalCleanupFn,
  }
) {
  // Live handles the shutdown path reads at exit time, not at creation.
  const run = {
    boundary: null,
    runtime: null,
    signalCleanup: null,
    unsubscribeNotification: null,
    completionPending: false,
  };
  const outcome = { code: 1, result: null, resultText: '', executionError: null };
  const cleanup = headlessCleanup(run, {
    writeErr,
    hasActiveTasks,
    usageLedgerCleanup,
    daemonRuntimeCleanup,
    memoryRuntimeCleanup,
  });
  const writeUsage = () =>
    writeUsageDocument(usageLogPath, stats, run.runtime, lifecycle?.toolCallCount || 0, observedModels);

  try {
    await startHeadlessRuntime(run, {
      provider,
      model,
      effort,
      fast,
      cwd,
      webSearch,
      lifecycle,
      boundaryFactory,
      runtimeFactory,
      installSignalCleanupFn,
      cleanup,
    });
    const askOptions = headlessAskOptions({ stats, lifecycle, observedModels, writeUsage });
    outcome.result = await askUntilSettled(run, prompt, askOptions);
    outcome.resultText = String(outcome.result?.content ?? outcome.result?.text ?? '');
    if (!json && outcome.resultText) {
      write(outcome.resultText.endsWith('\n') ? outcome.resultText : `${outcome.resultText}\n`);
    }
    outcome.code = 0;
  } catch (error) {
    outcome.executionError = error;
    writeErr(`mixdog: ${error?.message || error}\n`);
  } finally {
    const shutdown = await closeHeadlessRun(run, { writeUsage, cleanup, writeErr });
    if (shutdown) {
      outcome.executionError ??= shutdown.error;
      outcome.code = 1;
    }
  }
  return outcome;
}

// Exit NEVER waits on running background work. A job the model left
// running on purpose (a task's server) has no end, so waiting for it spent
// the whole remaining budget on an already-finished turn — 2026-08-23 full
// run: two trials, ~85s of real work each, 900s burned. Claude Code and
// Codex both leave the moment the turn ends. Completions that ALREADY
// arrived still get their follow-up turn: that is a queued message, not a
// wait, so no result the model can act on is dropped.
async function askUntilSettled(run, prompt, askOptions) {
  let { result } = await run.runtime.ask(prompt, askOptions);
  while (run.completionPending) {
    run.completionPending = false;
    ({ result } = await run.runtime.ask('', askOptions));
  }
  return result;
}

// Exit-path teardown: drop the notification listener, write the usage
// document, run the memoized shutdown, then uninstall the signal handlers.
// Listener and usage failures only log; a shutdown failure is returned.
async function closeHeadlessRun(run, { writeUsage, cleanup, writeErr }) {
  try {
    run.unsubscribeNotification?.();
  } catch {
    // Listener cleanup is best-effort.
  }
  try {
    writeUsage();
  } catch (error) {
    writeErr(`mixdog: usage log write failed: ${error?.message || error}\n`);
  }
  try {
    await cleanup('exec-exit');
    return null;
  } catch (error) {
    writeErr(`mixdog: shutdown failed: ${error?.message || error}\n`);
    return { error };
  } finally {
    run.signalCleanup?.uninstall();
  }
}

function taskScopeFor(session) {
  return {
    ...(clean(session?.id) ? { callerSessionId: clean(session.id) } : {}),
    clientHostPid: session?.clientHostPid,
  };
}

// The one-shot shutdown sequence, memoized so the signal handler and the
// exit path share a single run: close the runtime, drain the trace, release
// the usage ledger, stop the daemon and memory runtimes, then remove the
// pristine root.
function headlessCleanup(
  run,
  { writeErr, hasActiveTasks, usageLedgerCleanup, daemonRuntimeCleanup, memoryRuntimeCleanup }
) {
  let cleanupPromise = null;
  const shutdown = async (reason) => {
    const { runtime, boundary } = run;
    const errors = [];
    // Background jobs the model left running ON PURPOSE (a task's required
    // server) must outlive this process: reaping them at exit destroys the
    // very artifact the caller asked for. Detach instead of reap. cli.mjs
    // exits explicitly, so surviving children cannot hold the process open.
    await attemptShutdownStep(errors, async () => {
      if (runtime) {
        await runtime.close(reason, hasActiveTasks(taskScopeFor(runtime)) ? { keepBackgroundWork: true } : {});
      }
    });
    // Explicit CLI exit cannot finish an asynchronous append. Drain both
    // in-flight and queued rows before services or the runtime root go away.
    await attemptShutdownStep(errors, async () => {
      if (boundary) {
        const { drainAgentTrace } = await import('./runtime/agent/orchestrator/agent-trace.mjs');
        await drainAgentTrace();
      }
    });
    // The usage ledger lives inside the pristine root. Its open SQLite
    // handle blocks the root removal below on Windows (EBUSY) for the whole
    // rmSync retry budget, so release it once the last usage row is in.
    await attemptShutdownStep(errors, () => usageLedgerCleanup());
    let resourceCleanupFailed = false;
    if (boundary?.runtimeRoot) {
      const ok = await attemptShutdownStep(errors, () =>
        daemonRuntimeCleanup(boundary.runtimeRoot, { waitForExit: true, timeoutMs: 8_000 })
      );
      resourceCleanupFailed = !ok;
    }
    if (boundary) {
      const ok = await attemptShutdownStep(errors, () =>
        memoryRuntimeCleanup({ waitForExit: true, timeoutMs: 10_000 })
      );
      if (!ok) resourceCleanupFailed = true;
    }
    await attemptShutdownStep(errors, () => removeBoundaryRoot(boundary, resourceCleanupFailed, writeErr));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'headless shutdown failed');
  };
  return (reason = 'exec-exit') => {
    cleanupPromise ??= shutdown(reason);
    return cleanupPromise;
  };
}

// Runs one shutdown step, collecting its failure so the remaining steps still
// run; true when the step succeeded.
async function attemptShutdownStep(errors, step) {
  try {
    await step();
    return true;
  } catch (error) {
    errors.push(error);
    return false;
  }
}

// The answer is already final here. A root whose memory daemon is still
// winding down (its pg.log stays open for a while) must not hold the
// exit for the default ≈128s retry budget; 10 linear retries ≈ 5.5s,
// and the periodic orphan sweep reclaims whatever is left.
function removeBoundaryRoot(boundary, preserveRoot, writeErr) {
  const cleanupResult = boundary?.cleanup(
    preserveRoot ? { preserveRoot: true } : { tolerateRootRemovalFailure: true, rootRemovalRetries: 10 }
  );
  if (cleanupResult?.rootRemovalError) {
    writeErr(
      `mixdog: shutdown cleanup failed (result unaffected): ${cleanupResult.rootRemovalError?.message || cleanupResult.rootRemovalError}\n`
    );
  }
}

// Pristine boundary, signal handlers, then the session runtime; every
// handle lands on `run` so the shutdown path can see whatever was reached.
async function startHeadlessRuntime(
  run,
  {
    provider,
    model,
    effort,
    fast,
    cwd,
    webSearch,
    lifecycle,
    boundaryFactory,
    runtimeFactory,
    installSignalCleanupFn,
    cleanup,
  }
) {
  run.boundary = boundaryFactory({ provider, model, effort, fast });
  // Fire-and-forget resident search server prewarm, matching the long-lived
  // host. Non-fatal by construction.
  if (!/^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_DISABLE_TOOL_PREWARM || '').trim())) {
    void prewarmHeadlessSearch(cwd).catch(() => {});
  }
  run.signalCleanup = installSignalCleanupFn({
    name: 'mixdog-exec',
    timeoutMs: 20_000,
    cleanup,
  });
  const runtime = await createHeadlessSessionRuntime(run.boundary, { provider, model, cwd, webSearch, runtimeFactory });
  run.runtime = runtime;
  if (lifecycle && !clean(runtime?.id) && typeof runtime?.reserveSessionId === 'function') {
    runtime.reserveSessionId(lifecycle.threadId);
  }
  lifecycle?.start(runtime);
  if (typeof runtime?.onNotification === 'function') {
    run.unsubscribeNotification = runtime.onNotification((event) => {
      lifecycle?.onNotification(event);
      const status = clean(event?.meta?.status).toLowerCase();
      if (['completed', 'failed', 'cancelled', 'canceled', 'timed_out'].includes(status)) {
        run.completionPending = true;
      }
    });
  }
}

// Headless defaults: web research stays OFF unless the caller opts in via
// --web-search; memory and delegation stay disallowed. The per-process
// MIXDOG_FEATURE_* overrides are the runtime's canonical switches.
async function createHeadlessSessionRuntime(boundary, { provider, model, cwd, webSearch, runtimeFactory }) {
  const createRuntime = runtimeFactory || (await import('./mixdog-session-runtime.mjs')).createMixdogSessionRuntime;
  process.env.MIXDOG_FEATURE_WEB_SEARCH = webSearch === true ? '1' : '0';
  process.env.MIXDOG_FEATURE_MEMORY = '0';
  return createRuntime({
    provider,
    model,
    cwd,
    toolMode: 'full',
    toolProfile: 'headless',
    approvalMode: 'implicit',
    disallowDelegation: true,
    autoWakeCompletions: false,
    initialConfig: {
      ...boundary.loadConfig(),
      workflow: { active: 'headless' },
      orchestrationMode: 'none',
    },
  });
}

// Per-ask callbacks. The usage snapshot is rewritten after every model
// response, not only on the way out: a session killed mid-run — agent
// timeout, SIGKILL — never reaches the exit path, and used to leave no usage
// document at all while its token spend was already real. The file is a few
// hundred bytes and the write is atomic, so the cost is negligible and a
// live run stays readable from outside.
function headlessAskOptions({ stats, lifecycle, observedModels, writeUsage }) {
  return {
    onTextReset: () => true,
    onUsageDelta: (delta) => {
      const observedModel = clean(delta?.model);
      if (observedModel) observedModels.add(observedModel);
      applyUsageDelta(stats, delta);
      lifecycle?.onUsageDelta(delta);
      try {
        writeUsage();
      } catch {
        // Telemetry must never break the session; the exit path reports.
      }
    },
    ...(lifecycle
      ? {
          onProviderSendStarted: () => lifecycle.onProviderSendStarted(),
          onReasoningDelta: (chunk) => lifecycle.onReasoningDelta(chunk),
          onAssistantText: (text) => lifecycle.onAssistantText(text),
          onAssistantToolCallObserved: (call) => lifecycle.onAssistantToolCallObserved(call),
          onToolCall: (iteration, calls) => lifecycle.onToolCall(iteration, calls),
          onToolResult: (message) => lifecycle.onToolResult(message),
          onToolPhaseStarted: () => lifecycle.onToolBatchStarted(),
          onToolPhaseCompleted: (detail) => lifecycle.onToolBatchCompleted(detail),
          onStageChange: (stage, detail) => lifecycle.onStageChange(stage, detail),
        }
      : {}),
  };
}
