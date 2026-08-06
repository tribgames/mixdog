// Env-tunable boot timings and feature gates for the session runtime, lifted
// out of runtime-core so the facade reads as wiring instead of a wall of
// knobs. Values are read ONCE per runtime construction: a mid-session env
// change must not retune a schedule that is already armed.
import { envDelayMs, envFlag, envPresent } from './env.mjs';

export function readRuntimeTunables() {
  const codeGraphPrewarmEnabled = !envFlag('MIXDOG_DISABLE_CODE_GRAPH_PREWARM');
  return {
    providerSetupWarmupDelayMs: envDelayMs('MIXDOG_PROVIDER_SETUP_WARMUP_DELAY_MS', 300, { min: 0, max: 60_000 }),
    modelCatalogWarmupDelayMs: envDelayMs('MIXDOG_MODEL_CATALOG_WARMUP_DELAY_MS', 200, { min: 0, max: 60_000 }),
    providerWarmupDelayMs: envDelayMs('MIXDOG_PROVIDER_WARMUP_DELAY_MS', 1_500, { min: 0, max: 60_000 }),
    // Background model-catalog prefetch delay. Kept short so the first `/model`
    // open finds a warm cache instead of paying a cold full network load. The
    // work is async + unref'd, so short-lived detached runtimes still exit
    // cleanly without waiting on it. Operators can raise it via env if a
    // detached runtime must avoid the /models round-trip entirely.
    providerModelWarmupDelayMs: envDelayMs('MIXDOG_PROVIDER_MODEL_WARMUP_DELAY_MS', 2_000, { min: 0, max: 120_000 }),
    codeGraphPrewarmDelayMs: envDelayMs('MIXDOG_CODE_GRAPH_PREWARM_DELAY_MS', 250, { min: 0, max: 60_000 }),
    statuslineUsageWarmupDelayMs: envDelayMs('MIXDOG_STATUSLINE_USAGE_WARMUP_DELAY_MS', 800, { min: 0, max: 60_000 }),
    // Idle keep-alive: re-fetch usage before the statusline's 10-min staleness
    // cut (LIVE_USAGE_SNAPSHOT_MAX_AGE_MS) so the usage segment does not
    // disappear while the session sits idle with no turns to trigger a refresh.
    statuslineUsageRefreshDelayMs: envDelayMs('MIXDOG_STATUSLINE_USAGE_REFRESH_MS', 240_000, { min: 30_000, max: 540_000 }),
    channelStartDelayMs: envDelayMs('MIXDOG_CHANNEL_START_DELAY_MS', 10_000, { min: 0, max: 120_000 }),
    backgroundBusyRetryMs: envDelayMs('MIXDOG_BACKGROUND_BUSY_RETRY_MS', 1_000, { min: 50, max: 10_000 }),
    // MCP startup never owns the first-token critical path by default. Already
    // connected tools fold synchronously; in-flight servers join through the
    // late-tool announcement path. Operators may opt back into a grace window.
    mcpTurnGraceMs: envDelayMs('MIXDOG_MCP_TURN_GRACE_MS', 0, { min: 0, max: 2_000 }),
    // Boot-time remote start is deferred past the first frame; see the caller.
    remoteAutoStartDelayMs: envDelayMs('MIXDOG_REMOTE_AUTOSTART_DELAY_MS', 1_500, { min: 0, max: 60_000 }),
    providerWarmupEnabled: !envFlag('MIXDOG_DISABLE_PROVIDER_WARMUP')
      && (
        envFlag('MIXDOG_ENABLE_PROVIDER_WARMUP')
        || envFlag('MIXDOG_PROVIDER_WARMUP_BEFORE_FIRST_TURN')
        || envPresent('MIXDOG_PROVIDER_WARMUP_DELAY_MS')
        || envPresent('MIXDOG_PROVIDER_MODEL_WARMUP_DELAY_MS')
      ),
    // Boot-time model-catalog prefetch is intentionally decoupled from the
    // heavier providerWarmupEnabled gate (which stays opt-in for provider
    // *init* side effects). Fetching the model list in the background after a
    // short delay is cheap, fire-and-forget and unref'd, so it is ON by
    // default — otherwise the FIRST `/model` open always paid a cold full
    // network load. Operators can still disable it explicitly.
    modelPrefetchEnabled: !envFlag('MIXDOG_DISABLE_PROVIDER_WARMUP')
      && !envFlag('MIXDOG_DISABLE_MODEL_PREFETCH'),
    codeGraphPrewarmEnabled,
    modelCatalogWarmupEnabled: !envFlag('MIXDOG_DISABLE_MODEL_CATALOG_WARMUP'),
    // Lazy code-graph prewarm (default ON): do NOT prewarm at startup / on cwd
    // change — that fired ~250ms after the first frame and, in a large tree,
    // burned a worker (and felt like a freeze) before the user did anything.
    // Instead prewarm ONCE on the first real turn, when a code lookup is
    // actually imminent. MIXDOG_CODE_GRAPH_PREWARM_EAGER=1 restores the old
    // eager behavior.
    codeGraphPrewarmLazy: codeGraphPrewarmEnabled && !envFlag('MIXDOG_CODE_GRAPH_PREWARM_EAGER'),
  };
}
