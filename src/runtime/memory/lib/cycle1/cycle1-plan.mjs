// cycle1/cycle1-plan.mjs
// The bounds one cycle1 run works within, resolved once from the flat config,
// the nested cycle1 wrap shape and the caller's options.
import { CYCLE1_INPUT_TOKEN_BUDGET } from '../memory-chunk-quality.mjs';
import { resolveMaintenancePreset } from '../../../shared/llm/index.mjs';

const CYCLE1_MIN_BATCH = 3;
const CYCLE1_SESSION_CAP = 10;
export const CYCLE1_PACKET_MAX_ROWS = 50;
export const CYCLE1_MAX_PACKETS = 4;
export const CYCLE1_OMITTED_COOLDOWN_MS = 60 * 60 * 1000;
// A session is chunked only after it has been quiet this long, so one task's
// request, work, result and correction reach the classifier together instead
// of being split at every scheduler tick.
export const CYCLE1_SESSION_QUIET_MS = 15 * 60 * 1000;
// A session that never pauses is still drained once its oldest pending row has
// waited this long.
export const CYCLE1_SESSION_FORCE_AGE_MS = 2 * 60 * 60 * 1000;

export function resolveCycle1Plan(config = {}, options = {}) {
  const batchSize = Math.max(1, Number(config.batch_size ?? 100));
  const windowSize = Math.min(
    CYCLE1_PACKET_MAX_ROWS,
    Math.max(1, Number(config.window_size ?? config.windowSize ?? batchSize))
  );
  const maxPackets = Math.min(
    CYCLE1_MAX_PACKETS,
    Math.max(1, Number(config.max_packets ?? config.maxPackets ?? CYCLE1_MAX_PACKETS))
  );
  const rowsPerSession = Math.max(
    windowSize,
    Number(
      config.rows_per_session ??
        config.rowsPerSession ??
        config.max_rows_per_session ??
        config.maxRowsPerSession ??
        batchSize
    ) || batchSize
  );
  // Fallback chain handles flat config + nested cycle1 wrap shapes.
  const minBatch = Math.max(1, Number(config?.min_batch ?? config?.cycle1?.min_batch ?? CYCLE1_MIN_BATCH));
  const sessionCap = Math.max(1, Number(config?.session_cap ?? config?.cycle1?.session_cap ?? CYCLE1_SESSION_CAP));
  // Starvation backfill. Session selection is recency-first, which on a busy
  // daemon means the newest sessions refill every slot on every run: a row that
  // is omitted or fails once lands behind CYCLE1_OMITTED_COOLDOWN_MS, and by
  // the time that cooldown lapses newer sessions own the whole cap again, so
  // the session is never selected a second time. Observed effect: the unchunked
  // backlog sat flat at ~550 rows across 28 starved sessions for hours while
  // each run cheerfully drained only the freshest ones. Reserve a slice of the
  // cap for the OLDEST eligible sessions so the tail always drains. Recency
  // still owns the majority of slots and the per-run session count is
  // unchanged, so classifier cost per run is not affected.
  const backfillCap = Math.min(Math.max(1, Math.floor(sessionCap / 3)), Math.max(1, sessionCap - 1));
  // Inner LLM timeout aligns to caller deadline -1s so the channel side can ack gracefully.
  const callerDeadlineMs = Number(options.callerDeadlineMs ?? 0);
  const baseTimeout = Number(config?.timeout ?? config?.cycle1?.timeout ?? 180000);
  // Cap fan-out concurrency so a large batch (or a manual run) doesn't fire all
  // window LLM calls at once and spike the provider / collide with the global
  // agent-IPC limit. Small batches (<= cap) still run fully parallel.
  const concurrency = Math.min(
    CYCLE1_MAX_PACKETS,
    Math.max(
      1,
      Number(
        config.cycle1_concurrency ??
          config.concurrency ??
          options.concurrency ??
          options.maxConcurrent ??
          CYCLE1_MAX_PACKETS
      )
    )
  );
  return {
    windowSize,
    maxPackets,
    rowsPerSession,
    minBatch,
    sessionCap,
    backfillCap,
    sessionQuietMs: Math.max(
      0,
      Number(config.session_quiet_ms ?? config.sessionQuietMs ?? CYCLE1_SESSION_QUIET_MS) || 0
    ),
    sessionForceAgeMs: Math.max(
      0,
      Number(config.session_force_age_ms ?? config.sessionForceAgeMs ?? CYCLE1_SESSION_FORCE_AGE_MS) || 0
    ),
    onlySessionId: String(config.session_id ?? config.sessionId ?? '').trim(),
    preset: options.preset || resolveMaintenancePreset('memory'),
    timeout: callerDeadlineMs > 0 ? Math.min(baseTimeout, Math.max(5000, callerDeadlineMs - 1000)) : baseTimeout,
    inputTokenBudget: config.input_token_budget ?? CYCLE1_INPUT_TOKEN_BUDGET,
    concurrency,
  };
}
