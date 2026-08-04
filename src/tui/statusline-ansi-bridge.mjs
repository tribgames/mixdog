/**
 * TUI-only bridge: remap hardcoded footer ANSI from `src/ui/statusline.mjs` and
 * vendored `statusline-lib` into the active React TUI theme.
 *
 * CLI/REPL keeps emitting the fixed Mixdog statusline palette; the Ink footer
 * normalizes that at display time so `/theme` can re-tone without touching ui/.
 */

import { rgbToAnsi256 } from '../ui/ansi.mjs';

const RESET = '\x1b[0m';

/** Truecolor SGR sequences emitted by the shared statusline stack (not theme). */
export const STATUSLINE_CANONICAL_TRUECOLOR = Object.freeze({
  statusText: [198, 198, 198],
  subtle: [136, 136, 136],
  success: [0, 170, 75],
  successBright: [0, 185, 88],
  warning: [255, 193, 7],
  warningBright: [255, 210, 80],
  error: [220, 70, 88],
});

function truecolorSgr(r, g, b) {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function ansi256Sgr(r, g, b) {
  return `\x1b[38;5;${rgbToAnsi256(r, g, b)}m`;
}

function canonicalSgrVariants(rgb) {
  return [truecolorSgr(...rgb), ansi256Sgr(...rgb)];
}

function footerLocalNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Mirrors StatusLine `isResetStatsState` — stats-only identity for footer cache. */
function isResetStatsState(stats) {
  const s = stats && typeof stats === 'object' ? stats : {};
  return footerLocalNum(s.currentContextTokens) === 0
    && footerLocalNum(s.currentEstimatedContextTokens) === 0
    && footerLocalNum(s.inputTokens) === 0
    && footerLocalNum(s.latestInputTokens) === 0
    && footerLocalNum(s.promptTokens) === 0
    && footerLocalNum(s.turns) === 0;
}

/**
 * True when the footer should snap local / invalidate cached async output.
 * Keep in sync with `shouldSnapLocalStatusline` in StatusLine.jsx.
 * `agentRevision` is intentionally NOT checked here: agent worker/job churn
 * must only kick off the async full-render refresh (the render effect already
 * depends on `agentRevision`), never snap the footer back to the usage-less
 * `localBootStatusLine` before/after the first full render — that was the
 * source of the boot-entry flicker. `agentRevision` still participates in
 * `statuslineFooterCacheKey` below so the async cache key churns correctly.
 */
export function statuslineFooterIdentityChanged(args, lastArgs) {
  if (!args) return false;
  if (!lastArgs) return true;
  if (args.sessionId !== lastArgs.sessionId) return true;
  if (args.provider !== lastArgs.provider || args.model !== lastArgs.model) return true;
  if (args.effort !== lastArgs.effort || args.fast !== lastArgs.fast) return true;
  if (args.contextWindow !== lastArgs.contextWindow || args.rawContextWindow !== lastArgs.rawContextWindow) return true;
  if (args.displayContextWindow !== lastArgs.displayContextWindow) return true;
  if (args.compactBoundaryTokens !== lastArgs.compactBoundaryTokens) return true;
  if (args.autoCompactTokenLimit !== lastArgs.autoCompactTokenLimit) return true;
  if (isResetStatsState(args.stats) && !isResetStatsState(lastArgs.stats)) return true;
  return false;
}

/**
 * Cache key for the last async full statusline (identity-changing props only).
 * Includes `agentRevision` as a churn key (so a stale async result is not kept
 * forever), but `agentRevision` is deliberately excluded from
 * `statuslineFooterIdentityChanged` above — it must not itself force a local
 * snap-back. Stats reset is not keyed here; `statuslineFooterIdentityChanged`
 * clears cache instead.
 */
export function statuslineFooterCacheKey({
  agentRevision = '',
  sessionId = '',
  clientHostPid = '',
  provider = '',
  model = '',
  effort = '',
  fast = false,
  contextWindow = 0,
  displayContextWindow = 0,
  rawContextWindow = 0,
  compactBoundaryTokens = 0,
  autoCompactTokenLimit = 0,
} = {}) {
  return [
    String(agentRevision),
    String(sessionId),
    String(clientHostPid ?? ''),
    String(provider),
    String(model),
    String(effort),
    fast === true ? '1' : '0',
    String(contextWindow),
    String(displayContextWindow),
    String(rawContextWindow),
    String(compactBoundaryTokens),
    String(autoCompactTokenLimit),
  ].join('\0');
}

/**
 * Gateway quota segments often end a dim label with reset then bare values
 * (`Credit $1.23`, `used/limit`). Ink defaults reset to terminal fg; apply
 * themed status text until the next explicit SGR.
 */
function applyDefaultStatusForegroundAfterReset(text, STATUS, reset = RESET) {
  const src = String(text || '');
  if (!STATUS || !reset) return src;
  let out = '';
  let i = 0;
  while (i < src.length) {
    const at = src.indexOf(reset, i);
    if (at === -1) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, at + reset.length);
    i = at + reset.length;
    let j = i;
    while (j < src.length && src[j] === ' ') {
      out += src[j];
      j += 1;
    }
    if (j < src.length && src[j] !== '\x1b') {
      out += STATUS;
    }
    i = j;
  }
  return out;
}

/**
 * @param {string} text
 * @param {{ STATUS: string, SUBTLE: string, SUCCESS: string, WARNING: string, ERROR: string }} colors
 */
export function remapCanonicalStatuslineTruecolor(text, colors) {
  const c = STATUSLINE_CANONICAL_TRUECOLOR;
  const pairs = [
    ...canonicalSgrVariants(c.statusText).map((from) => [from, colors.STATUS]),
    ...canonicalSgrVariants(c.subtle).map((from) => [from, colors.SUBTLE]),
    ...canonicalSgrVariants(c.success).map((from) => [from, colors.SUCCESS]),
    ...canonicalSgrVariants(c.successBright).map((from) => [from, colors.SUCCESS]),
    ...canonicalSgrVariants(c.warning).map((from) => [from, colors.WARNING]),
    ...canonicalSgrVariants(c.warningBright).map((from) => [from, colors.WARNING]),
    ...canonicalSgrVariants(c.error).map((from) => [from, colors.ERROR]),
  ];
  let out = String(text || '');
  for (const [from, to] of pairs) {
    if (from && to) out = out.split(from).join(to);
  }
  return out;
}

/**
 * Normalize vendored/native statusline ANSI for Ink `<Text>` using theme SGR.
 *
 * @param {string} text
 * @param {{ STATUS: string, SUBTLE: string, SUCCESS: string, WARNING: string, ERROR: string }} colors
 * @param {{ reset?: string }} [opts]
 */
export function normalizeStatuslineAnsi(text, colors, { reset = RESET } = {}) {
  const { STATUS, SUBTLE, SUCCESS, WARNING, ERROR } = colors;
  let out = remapCanonicalStatuslineTruecolor(text, colors)
    .replace(/\n+$/, '')
    .replace(/\x1b\[1m/g, STATUS)
    .replace(/\x1b\[2m/g, SUBTLE)
    .replace(/\x1b\[31m/g, ERROR)
    .replace(/\x1b\[32m/g, SUCCESS)
    .replace(/\x1b\[33m/g, WARNING)
    .replace(/\x1b\[36m/g, SUBTLE)
    .replace(/\x1b\[90m/g, SUBTLE)
    .replace(/^((?:\x1b\[[0-9;]*m)*)◆((?:\x1b\[[0-9;]*m)*)(\s?)/, `${STATUS}◆$2$3`)
    .replace(/(\x1b\[0m )(\d+(?:\.\d+)?%)(?= |$)/g, `$1${STATUS}$2${reset}`)
    .replaceAll(`${reset} ${SUBTLE}│${reset} `, ` ${SUBTLE}│${reset} `);
  out = applyDefaultStatusForegroundAfterReset(out, STATUS, reset);
  return out;
}
