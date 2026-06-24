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
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { bold, green, rgb } from './ansi.mjs';
import { renderStatusLine as renderVendoredStatusLine } from '../vendor/statusline/bin/statusline-lib.mjs';
import { getModelMetadataSync } from '../runtime/agent/orchestrator/providers/model-catalog.mjs';

// Token window used to compute a fallback context% from our own session usage.
// The live gateway (when up) overrides this with the real route's window. This
// is only the last resort for unknown local models.
const FALLBACK_CONTEXT_WINDOW = 200000;
const statusText = rgb(198, 198, 198);
const statusSubtle = rgb(136, 136, 136);
const statusAccent = rgb(215, 119, 87);

/** Create a mutable session-usage accumulator. */
export function createSessionStats() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    promptTokens: 0,
    latestInputTokens: 0,
    latestOutputTokens: 0,
    latestCachedTokens: 0,
    latestCacheWriteTokens: 0,
    latestPromptTokens: 0,
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
  stats.promptTokens += num(delta.deltaPrompt);
  stats.latestInputTokens = num(delta.deltaInput);
  stats.latestOutputTokens = num(delta.deltaOutput);
  stats.latestCachedTokens = num(delta.deltaCachedRead);
  stats.latestCacheWriteTokens = num(delta.deltaCacheWrite);
  stats.latestPromptTokens = num(delta.deltaPrompt);
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
function providerInputExcludesCache(provider) {
  return String(provider || '').toLowerCase().includes('anthropic');
}

function promptFootprintTokens(provider, stats) {
  const s = stats || createSessionStats();
  const explicit = num(s.promptTokens);
  if (explicit > 0) return explicit;
  const input = num(s.inputTokens);
  if (providerInputExcludesCache(provider)) {
    return input + num(s.cachedTokens) + num(s.cacheWriteTokens);
  }
  return input;
}

function currentContextTokens(provider, stats) {
  const s = stats || createSessionStats();
  const explicit = num(s.latestPromptTokens ?? s.contextTokens ?? s.currentContextTokens);
  if (explicit > 0) return explicit;
  const latestInput = num(s.latestInputTokens);
  const latestCacheRead = num(s.latestCachedTokens);
  const latestCacheWrite = num(s.latestCacheWriteTokens);
  if (latestInput || latestCacheRead || latestCacheWrite) {
    return providerInputExcludesCache(provider)
      ? latestInput + latestCacheRead + latestCacheWrite
      : latestInput;
  }
  return promptFootprintTokens(provider, s);
}

function modelContextWindow(provider, model, explicitContextWindow = 0) {
  const explicit = num(explicitContextWindow);
  if (explicit > 0) return explicit;
  const metaWindow = num(getModelMetadataSync(model, provider)?.contextWindow);
  if (metaWindow > 0) return metaWindow;
  return FALLBACK_CONTEXT_WINDOW;
}

function buildCcJson({ provider = '', model = '', effort = '', stats, sessionId = 'mixdog-cli-repl', contextWindow = 0, rawContextWindow = 0 } = {}) {
  const s = stats || createSessionStats();
  const promptTokens = currentContextTokens(provider, s);
  const used = promptTokens;
  const resolvedContextWindow = modelContextWindow(provider, model, contextWindow);
  const resolvedRawContextWindow = num(rawContextWindow) || resolvedContextWindow;
  const pct = clampPct((used / resolvedContextWindow) * 100);
  return {
    session_id: String(sessionId || 'mixdog-cli-repl'),
    display_name: String(model || ''),
    ...(effort ? { effort: { level: String(effort) } } : {}),
    context_window: {
      used_percentage: pct,
      context_window_size: resolvedContextWindow,
      raw_context_window_size: resolvedRawContextWindow,
      total_input_tokens: promptTokens,
      total_output_tokens: num(s.outputTokens),
      cache_read_input_tokens: num(s.cachedTokens),
      cache_creation_input_tokens: num(s.cacheWriteTokens),
      current_usage: {
        input_tokens: promptTokens,
        output_tokens: num(s.outputTokens),
      },
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
export async function renderStatusline({ provider = '', model = '', effort = '', cwd = '', stats, sessionId, contextWindow = 0, rawContextWindow = 0 } = {}) {
  const prevPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const prevStandalone = process.env.MIXDOG_STANDALONE;
  try {
    process.env.CLAUDE_PLUGIN_DATA = process.env.MIXDOG_DATA_DIR || join(homedir(), '.mixdog', 'data');
    process.env.MIXDOG_STANDALONE = '1';
    const ccJson = JSON.stringify(buildCcJson({ provider, model, effort, stats, sessionId, contextWindow, rawContextWindow }));
    const out = await renderVendoredStatusLine(ccJson);
    const text = typeof out === 'string' ? out.replace(/\n+$/, '') : '';
    if (text) return text;
    return fallbackLine({ provider, model, cwd, stats });
  } catch {
    return fallbackLine({ provider, model, cwd, stats });
  } finally {
    if (prevPluginData == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevPluginData;
    if (prevStandalone == null) delete process.env.MIXDOG_STANDALONE;
    else process.env.MIXDOG_STANDALONE = prevStandalone;
  }
}

// --- helpers -----------------------------------------------------------------

/** Minimal one-line footer used when the vendored renderer is unavailable. */
function fallbackLine({ provider = '', model = '', cwd = '', stats } = {}) {
  const s = stats || createSessionStats();
  const sep = statusSubtle(' · ');
  const id = statusAccent(`${provider}/${model}`);
  const tokens = statusText(
    `${fmt(s.inputTokens)} in / ${fmt(s.outputTokens)} out` +
      (s.cachedTokens ? ` / ${fmt(s.cachedTokens)} read` : '') +
      (s.cacheWriteTokens ? ` / ${fmt(s.cacheWriteTokens)} write` : ''),
  );
  const cost = s.costUsd > 0 ? green('$' + s.costUsd.toFixed(4)) : statusSubtle('$0.0000');
  const dir = bold(basename(cwd || process.cwd()) || cwd);
  return statusSubtle('▸ ') + [id, tokens, cost, dir].join(sep);
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
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) {
    const k = Math.round(v / 1000);
    return k >= 1000 ? '1M' : `${k}k`;
  }
  return (v / 1_000_000).toFixed(1) + 'M';
}
