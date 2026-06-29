#!/usr/bin/env node
// Focused coverage for the legacy derived full-window autoCompactTokenLimit
// migration and the buffer-config preservation fix. No provider / network /
// disk-store dependency — pure function assertions on the manager helpers.
import {
  _resolveSessionContextMeta as resolveSessionContextMeta,
  _compactTriggerForSession as compactTriggerForSession,
  _preserveBufferConfigFields as preserveBufferConfigFields,
} from '../src/runtime/agent/orchestrator/session/manager.mjs';
import { _autoCompactTokenLimit as routeMetaAutoCompactTokenLimit } from '../src/vendor/statusline/src/gateway/route-meta.mjs';
import {
  _routeContextMeta as routeContextMeta,
  _resolveStatusAutoCompactTokenLimit as resolveStatusAutoCompactTokenLimit,
} from '../src/vendor/statusline/bin/statusline-route.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// 1) A legacy seed where autoCompactTokenLimit == contextWindow/boundary must
//    NOT be re-accepted as an explicit limit; it is dropped to null so the
//    trigger falls back to the default boundary trigger.
{
  const seed = {
    contextWindow: 200000,
    rawContextWindow: 200000,
    effectiveContextWindowPercent: 100,
    autoCompactTokenLimit: 200000, // legacy derived full-window value
    compactBoundaryTokens: 200000,
  };
  const meta = resolveSessionContextMeta(null, 'claude-haiku-4-5-20251001', seed);
  assert(meta.autoCompactTokenLimit === null,
    `legacy full-window autoCompactTokenLimit should drop to null, got ${meta.autoCompactTokenLimit}`);
  assert(meta.compactBoundaryTokens === 200000,
    `boundary should stay full window, got ${meta.compactBoundaryTokens}`);
}

// 2) A genuinely-lower explicit limit (< boundary) is preserved.
{
  const seed = {
    contextWindow: 200000,
    rawContextWindow: 200000,
    effectiveContextWindowPercent: 100,
    autoCompactTokenLimit: 120000,
    compactBoundaryTokens: 200000,
  };
  const meta = resolveSessionContextMeta(null, 'claude-haiku-4-5-20251001', seed);
  assert(meta.autoCompactTokenLimit === 120000,
    `sub-boundary explicit limit should be preserved, got ${meta.autoCompactTokenLimit}`);
}

// 3) compactTriggerForSession ignores a boundary-equal stored autoCompactTokenLimit
//    (legacy artifact) and returns the boundary; honors a sub-boundary one.
{
  const boundary = 200000;
  const legacy = compactTriggerForSession({ autoCompactTokenLimit: boundary, compaction: {} }, boundary);
  assert(legacy === boundary, `legacy boundary-equal limit should yield boundary trigger ${boundary}, got ${legacy}`);
  const explicit = compactTriggerForSession({ autoCompactTokenLimit: 150000, compaction: {} }, boundary);
  assert(explicit === 150000, `sub-boundary explicit limit should be the trigger, got ${explicit}`);
}

// 4) A configured bufferPercent flows into the trigger via session.compaction.
{
  const boundary = 200000;
  // bufferPercent: 5 → 5% → trigger 190000.
  const trigger = compactTriggerForSession({ compaction: { bufferPercent: 5 } }, boundary);
  assert(trigger === 190000, `bufferPercent 5 should yield trigger 190000, got ${trigger}`);
}

// 5) Legacy telemetry from the old default 10% buffer must not keep resumed
//    sessions compacting at boundary 90%; it now migrates to the boundary.
{
  const boundary = 200000;
  const legacyTelemetry = compactTriggerForSession({
    compaction: {
      boundaryTokens: boundary,
      triggerTokens: 180000,
      bufferTokens: 20000,
      bufferRatio: 0.1,
    },
  }, boundary);
  assert(legacyTelemetry === boundary,
    `legacy default buffer telemetry should migrate to boundary trigger ${boundary}, got ${legacyTelemetry}`);
  const explicitTokens = compactTriggerForSession({ compaction: { bufferTokens: 10000 } }, boundary);
  assert(explicitTokens === 190000,
    `explicit bufferTokens should still lower trigger to 190000, got ${explicitTokens}`);
}

// 6) preserveBufferConfigFields copies only finite-positive percent/ratio fields.
{
  const out = preserveBufferConfigFields({ bufferPercent: 5, bufferRatio: 0.02, bufferFraction: 0, bufferPct: undefined, other: 9 });
  assert(out.bufferPercent === 5 && out.bufferRatio === 0.02, 'should copy positive percent/ratio fields');
  assert(!('bufferFraction' in out), 'zero buffer field should be dropped');
  assert(!('bufferPct' in out), 'undefined buffer field should be dropped');
  assert(!('other' in out), 'non-buffer fields should not be copied');
}

// 7) route-meta.autoCompactTokenLimit(): legacy seed/info value == boundary/window
//    returns null; value >= window returns null; sub-window explicit preserved;
//    no boundary keeps positive explicit; never derives.
{
  // explicit == contextWindow (boundary) → null
  assert(routeMetaAutoCompactTokenLimit('openai-oauth', 272000, 244800, {}, { autoCompactTokenLimit: 244800 }) === null,
    'route-meta: explicit == contextWindow should be null');
  // explicit == rawContextWindow (above effective boundary) → null
  assert(routeMetaAutoCompactTokenLimit('openai-oauth', 272000, 244800, {}, { autoCompactTokenLimit: 272000 }) === null,
    'route-meta: explicit >= boundary should be null');
  // sub-boundary explicit preserved
  assert(routeMetaAutoCompactTokenLimit('openai-oauth', 272000, 244800, {}, { autoCompactTokenLimit: 150000 }) === 150000,
    'route-meta: sub-boundary explicit should be preserved');
  // no explicit → null (never derived)
  assert(routeMetaAutoCompactTokenLimit('openai-oauth', 272000, 244800, {}, {}) === null,
    'route-meta: no explicit should be null (never derived)');
  // no boundary known, positive explicit → kept
  assert(routeMetaAutoCompactTokenLimit('local', 0, 0, {}, { autoCompactTokenLimit: 60000 }) === 60000,
    'route-meta: positive explicit with no boundary should be kept');
}

// 8) statusline-route.routeContextMeta(): same explicit-only sanitization.
{
  // inherited full-window autoCompactTokenLimit (== rawContextWindow) → null
  const legacy = routeContextMeta('anthropic-oauth', { contextWindow: 200000 }, { autoCompactTokenLimit: 200000 });
  assert(legacy.autoCompactTokenLimit === null,
    `statusline-route: full-window inherited limit should be null, got ${legacy.autoCompactTokenLimit}`);
  assert(legacy.contextWindow > 0, 'statusline-route: contextWindow display should remain');
  // sub-boundary explicit preserved (effective window = 200000*0.9 = 180000)
  const lower = routeContextMeta('anthropic-oauth', { contextWindow: 200000 }, { autoCompactTokenLimit: 120000 });
  assert(lower.autoCompactTokenLimit === 120000,
    `statusline-route: sub-boundary explicit should be preserved, got ${lower.autoCompactTokenLimit}`);
  // no explicit → null (never derived from window)
  const none = routeContextMeta('anthropic-oauth', { contextWindow: 200000 }, {});
  assert(none.autoCompactTokenLimit === null,
    `statusline-route: no explicit should be null, got ${none.autoCompactTokenLimit}`);
}

// 9) loadGatewayStatus auto-compact resolver: a stale active full-window limit
//    must be validated against the ACTIVE window, not the (larger) configured
//    window. Configured contextWindow=244800 > active gateway_context_window=200000,
//    active gateway_auto_compact_token_limit=200000 (== active window) => null.
{
  const active = {
    gateway_context_window: 200000,
    gateway_raw_context_window: 200000,
    gateway_auto_compact_token_limit: 200000, // stale full-window (== active window)
  };
  // No configured route → active value is sanitized against the active window.
  const activeOnly = resolveStatusAutoCompactTokenLimit(null, active, null);
  assert(activeOnly === null,
    `status: stale active full-window limit should be null vs active window, got ${activeOnly}`);

  // Configured route present with a LARGER window must not validate the stale
  // active value; the configured route's own (here absent) explicit limit wins.
  const configuredLarger = { contextWindow: 244800, autoCompactTokenLimit: null };
  const withConfigured = resolveStatusAutoCompactTokenLimit(configuredLarger, active, null);
  assert(withConfigured === null,
    `status: configured larger window must not validate stale active limit, got ${withConfigured}`);

  // A lower active explicit value (below the active window) is preserved when
  // there is no configured route.
  const lowerActive = resolveStatusAutoCompactTokenLimit(null, {
    gateway_context_window: 200000,
    gateway_raw_context_window: 200000,
    gateway_auto_compact_token_limit: 150000,
  }, null);
  assert(lowerActive === 150000,
    `status: sub-active-boundary explicit should be preserved, got ${lowerActive}`);

  // A configured route's own sanitized explicit limit is surfaced.
  const configuredExplicit = resolveStatusAutoCompactTokenLimit(
    { contextWindow: 244800, autoCompactTokenLimit: 120000 }, active, null,
  );
  assert(configuredExplicit === 120000,
    `status: configured explicit limit should surface, got ${configuredExplicit}`);
}

process.stdout.write('compact-trigger-migration smoke passed ✓\n');
