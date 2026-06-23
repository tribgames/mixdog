/**
 * src/ui/statusline.mjs — per-turn footer status line.
 *
 * The bottom statusline is the EXISTING mixdog L1/L2 statusline, rendered by
 * the VENDORED original `renderStatusLine()` (src/vendor/statusline/...), which
 * is copied verbatim from the plugin and treated like an SDK. We don't
 * re-design it here — we build a Claude-Code-shaped JSON snapshot from our REPL
 * state and feed it to the original renderer.
 *
 * `createSessionStats()` returns a small accumulator the REPL feeds from the
 * engine's `onUsageDelta` callback; `renderStatusline()` builds the CC JSON and
 * awaits the vendored renderer. When the mixdog gateway is running,
 * `loadGatewayStatus()` (inside the vendored lib) OVERRIDES model / context% /
 * effort / 5H-7D from the live gateway; our adapter only supplies sane
 * fallbacks (model name + a context% from this session's token usage).
 */
import { basename } from 'node:path';
import { dim, gray, cyan, bold, green } from './ansi.mjs';
import { renderStatusLine as renderVendoredStatusLine } from '../vendor/statusline/bin/statusline-lib.mjs';

// Token window used to compute a fallback context% from our own session usage.
// The live gateway (when up) overrides this with the real route's window.
const FALLBACK_CONTEXT_WINDOW = 200000;

/** Create a mutable session-usage accumulator. */
export function createSessionStats() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    turns: 0,
  };
}

/**
 * Fold one `onUsageDelta` event into the accumulator.
 * @param {object} stats — from createSessionStats()
 * @param {object} delta — { deltaInput, deltaOutput, deltaCachedRead, deltaCacheWrite, costUsd }
 */
export function applyUsageDelta(stats, delta = {}) {
  if (!stats || !delta) return stats;
  stats.inputTokens += num(delta.deltaInput);
  stats.outputTokens += num(delta.deltaOutput);
  stats.cachedTokens += num(delta.deltaCachedRead);
  stats.cacheWriteTokens += num(delta.deltaCacheWrite);
  // costUsd from the engine is cumulative-per-call; we sum the per-turn deltas.
  stats.costUsd += num(delta.costUsd);
  return stats;
}

/**
 * Build the Claude-Code-shaped JSON the vendored renderer reads, from our REPL
 * state. Only the fields `renderStatusLine()` actually consumes are emitted:
 *   - display_name              → model name (L1)
 *   - effort.level              → effort string
 *   - context_window.*          → context% bar (used_percentage + raw tokens
 *                                 so the lib's activeContextTokens() also works)
 *   - session_id                → gateway session lookup
 * model / context% / effort / 5H-7D are overridden by the live gateway via
 * loadGatewayStatus() when it's running; these are the standalone fallbacks.
 */
function buildCcJson({ model = '', stats, sessionId = 'mixdog-cli-repl' } = {}) {
  const s = stats || createSessionStats();
  const used = num(s.inputTokens) + num(s.outputTokens);
  const pct = clampPct((used / FALLBACK_CONTEXT_WINDOW) * 100);
  return {
    session_id: String(sessionId || 'mixdog-cli-repl'),
    display_name: String(model || ''),
    context_window: {
      used_percentage: pct,
      total_input_tokens: num(s.inputTokens),
      total_output_tokens: num(s.outputTokens),
    },
  };
}

/**
 * Render the L1/L2 statusline footer via the vendored mixdog renderer.
 *
 * ASYNC: the vendored `renderStatusLine()` is async (it touches the gateway /
 * filesystem). On ANY error we fall back to a minimal one-line footer so the
 * REPL never sees a throw.
 *
 * @param {object} opts
 * @param {string} opts.provider
 * @param {string} opts.model
 * @param {string} opts.cwd
 * @param {object} opts.stats — createSessionStats() accumulator
 * @param {string} [opts.sessionId]
 * @returns {Promise<string>}
 */
export async function renderStatusline({ provider = '', model = '', cwd = '', stats, sessionId } = {}) {
  try {
    const ccJson = JSON.stringify(buildCcJson({ model, stats, sessionId }));
    const out = await renderVendoredStatusLine(ccJson);
    const text = typeof out === 'string' ? out.replace(/\n+$/, '') : '';
    if (text) return text;
    return fallbackLine({ provider, model, cwd, stats });
  } catch {
    return fallbackLine({ provider, model, cwd, stats });
  }
}

// --- helpers -----------------------------------------------------------------

/** Minimal one-line footer used when the vendored renderer is unavailable. */
function fallbackLine({ provider = '', model = '', cwd = '', stats } = {}) {
  const s = stats || createSessionStats();
  const sep = dim(' · ');
  const id = cyan(`${provider}/${model}`);
  const tokens = gray(
    `${fmt(s.inputTokens)} in / ${fmt(s.outputTokens)} out` +
      (s.cachedTokens ? ` / ${fmt(s.cachedTokens)} cached` : ''),
  );
  const cost = s.costUsd > 0 ? green('$' + s.costUsd.toFixed(4)) : dim('$0.0000');
  const dir = bold(basename(cwd || process.cwd()) || cwd);
  return dim('▸ ') + [id, tokens, cost, dir].join(sep);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/** Human-friendly token count: 1234 -> 1.2k. */
function fmt(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1_000_000) return (v / 1000).toFixed(v < 10_000 ? 1 : 0) + 'k';
  return (v / 1_000_000).toFixed(1) + 'M';
}
