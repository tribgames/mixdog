/**
 * src/ui/statusline-format.mjs — pure formatting primitives for the footer.
 *
 * Extracted verbatim from statusline.mjs: ANSI SGR constants, the context%
 * bar/segment formatters, small numeric helpers, and the TUI-independent
 * formatElapsed() replica. No behavior change — statusline.mjs re-imports these.
 */
import { colorEnabled, rgb, rgbSgr } from './ansi.mjs';
import { displayModelName, shortenModelName } from './model-display.mjs';
import { getModelMetadataSync } from '../runtime/agent/orchestrator/providers/model-catalog.mjs';

// Token window used to compute a fallback context% from our own session usage.
// The live gateway (when up) overrides this with the real route's window. This
// is only the last resort for unknown local models.
export const FALLBACK_CONTEXT_WINDOW = 200000;
export const statusText = rgb(198, 198, 198);
export const statusSubtle = rgb(136, 136, 136);

function sgr(code) {
  return colorEnabled() ? `\x1b[${code}m` : '';
}

export const R = sgr('0');
export const B = sgr('1');
export const D = colorEnabled() ? rgbSgr(136, 136, 136) : '';
export const GRN = colorEnabled() ? rgbSgr(0, 170, 75) : '';
export const YLW = colorEnabled() ? rgbSgr(255, 193, 7) : '';
export const RED = colorEnabled() ? rgbSgr(220, 70, 88) : '';
export const GREY = colorEnabled() ? rgbSgr(136, 136, 136) : '';

export function terminalColumns() {
  const cols = Number(process.stdout?.columns);
  return Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 120;
}

export function modelContextWindow(provider, model, explicitContextWindow = 0) {
  const explicit = num(explicitContextWindow);
  if (explicit > 0) return explicit;
  const metaWindow = num(getModelMetadataSync(model, provider)?.contextWindow);
  if (metaWindow > 0) return metaWindow;
  return FALLBACK_CONTEXT_WINDOW;
}

export function formatModelSegment({ provider, model, effort, fast, cols }) {
  const raw = String(model || '').trim();
  const meta = getModelMetadataSync(raw, provider) || {};
  const displayHint = String(meta.displayName || meta.display || meta.name || '').trim();
  const modelName = shortenModelName(displayModelName(raw, provider, displayHint), cols);
  const bits = [`${B}${modelName}${R}`];
  if (effort) bits.push(`${B}${String(effort).toUpperCase()}${R}`);
  if (fast === true) bits.push(`${B}FAST${R}`);
  return bits.join(` ${D}·${R} `);
}

/** Display label for context % (clamped to 100); raw pct still drives bar/color thresholds. */
export function contextPctDisplayLabel(ctxPct) {
  const pct = Number(ctxPct);
  if (!Number.isFinite(pct) || pct <= 0) return '0';
  if (pct > 0 && pct < 1) return String(Math.round(pct * 10) / 10);
  return String(Math.floor(Math.min(100, pct)));
}

export function formatContextSegment(ctxPct, cols) {
  const raw = Number(ctxPct);
  const pct = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  const barPct = clampPct(pct);
  const fill = pct >= 90 ? RED : pct >= 70 ? YLW : GRN;
  const label = contextPctDisplayLabel(pct);
  // Keep a full-width bar wherever there is room for one. Below 80 cols the bar
  // is dropped (label-only) so the footer never overflows a narrow terminal;
  // at 80+ it stays a fixed 14 cells instead of shrinking to 8, which read as
  // too small/cramped on mid-width terminals.
  const cells = cols >= 80 ? 14 : 0;
  if (!cells) return `${fill}${label}%${R}`;
  const bar = makeBar(barPct, cells);
  const filled = bar.replace(/░/g, '');
  const empty = bar.replace(/▓/g, '');
  return `${fill}${filled}${R}${D}${empty}${R} ${label}%`;
}

function makeBar(pct, cells) {
  let filled = Math.floor((Number(pct) || 0) * cells / 100);
  if (filled < 0) filled = 0;
  if (filled > cells) filled = cells;
  if (pct >= 1 && filled === 0) filled = 1;
  return '▓'.repeat(filled) + '░'.repeat(cells - filled);
}

export function colourPct(p) {
  if (p >= 90) return `${RED}${p}%${R}`;
  if (p >= 70) return `${YLW}${p}%${R}`;
  return `${GRN}${p}%${R}`;
}

export function epochMsToHHMM(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/** Human-friendly token count: 1234 -> 1.2k. */
export function fmt(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) {
    const k = Math.round(v / 1000);
    return k >= 1000 ? '1M' : `${k}k`;
  }
  return (v / 1_000_000).toFixed(1) + 'M';
}

// Byte-identical replica of src/tui/time-format.mjs formatDuration() with
// DEFAULT options (no mostSignificantOnly / hideTrailingZeros), wrapped to drop
// sub-1s like formatElapsed there. Output shape: '' (<1s), `Xs`, `Xm Ys`,
// `Xh Ym Zs`, `Xd Yh Zm`. statusline.mjs is a standalone UI module that should
// not depend on the React/ink TUI tree, so the algorithm is replicated rather
// than imported. Used for ALL L2 elapsed (Agents/Explore/Search/Shell).
export function formatElapsed(ms) {
  if (!Number.isFinite(Number(ms))) return '';
  const value = Math.max(0, Number(ms) || 0);
  if (value < 60_000) {
    if (value < 1_000) return '';
    return `${Math.floor(value / 1000)}s`;
  }
  const days = Math.floor(value / 86_400_000);
  const hours = Math.floor((value % 86_400_000) / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
