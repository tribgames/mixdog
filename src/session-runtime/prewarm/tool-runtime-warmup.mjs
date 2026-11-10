// prewarm/tool-runtime-warmup.mjs — warming the native tool servers off the
// first-token path: shell manager + orphaned shell-job recovery, and the
// resident search server that the first grep/find would otherwise spawn.
export function createToolRuntimeWarmup({ timers, bootProfile, isCloseRequested, envFlag }) {
  async function warmToolRuntime() {
    if (isCloseRequested()) return;
    try {
      const { warmNativeSpawnServer } = await import(
        '../../runtime/agent/orchestrator/tools/lib/native-spawn-client.mjs'
      );
      bootProfile('tool-runtime:native-shell', { warmed: (await warmNativeSpawnServer()) === true });
    } catch (error) {
      bootProfile('tool-runtime:native-shell-failed', { error: error?.message || String(error) });
    }
    try {
      // Shell jobs orphaned by a daemon restart: finalize their records and
      // deliver one completion notice to each owner session so the outcome
      // is never silently dropped.
      const { reconcileRecoveredShellJobCompletions } = await import(
        '../../runtime/agent/orchestrator/tools/builtin/shell-jobs.mjs'
      );
      bootProfile('tool-runtime:shell-job-recovery', { notified: await reconcileRecoveredShellJobCompletions() });
    } catch (error) {
      bootProfile('tool-runtime:shell-job-recovery-failed', { error: error?.message || String(error) });
    }
  }

  function scheduleToolRuntimeWarmup(delayMs = 2500) {
    if (envFlag('MIXDOG_DISABLE_TOOL_PREWARM')) {
      bootProfile('tool-runtime:prewarm-skipped');
      return;
    }
    const timer = setTimeout(() => void warmToolRuntime(), delayMs);
    timer.unref?.();
  }

  async function warmSearchRuntime() {
    timers.searchRuntimeWarmupTimer = null;
    if (isCloseRequested()) return;
    const nativeSearchWarm = (async () => {
      const { warmNativeSearchServer } = await import(
        '../../runtime/agent/orchestrator/tools/builtin/native-search-client.mjs'
      );
      bootProfile('native-search:warm', { up: (await warmNativeSearchServer()) === true });
    })().catch((error) => {
      bootProfile('native-search:warm-failed', { error: error?.message || String(error) });
    });
    const nativeSpawnWarm = (async () => {
      const { warmNativeSpawnServer } = await import(
        '../../runtime/agent/orchestrator/tools/lib/native-spawn-client.mjs'
      );
      bootProfile('native-spawn:warm', { up: (await warmNativeSpawnServer()) === true });
    })().catch((error) => {
      bootProfile('native-spawn:warm-failed', { error: error?.message || String(error) });
    });
    await Promise.all([nativeSearchWarm, nativeSpawnWarm]);
  }

  // Search warmup overlaps session/provider prep so the first grep/find does
  // not wait for the resident server spawn. Kept off the first-token path
  // that still owns PowerShell and code-graph workers.
  function scheduleSearchRuntimeWarmup(delayMs = 0) {
    if (envFlag('MIXDOG_DISABLE_TOOL_PREWARM')) {
      bootProfile('search-runtime:prewarm-skipped');
      return;
    }
    if (timers.searchRuntimeWarmupTimer || timers.searchRuntimeWarmupStarted) return;
    timers.searchRuntimeWarmupStarted = true;
    const start = () => void warmSearchRuntime();
    if (delayMs <= 0) {
      start();
      return;
    }
    timers.searchRuntimeWarmupTimer = setTimeout(start, delayMs);
    timers.searchRuntimeWarmupTimer.unref?.();
  }

  return { scheduleToolRuntimeWarmup, scheduleSearchRuntimeWarmup };
}
