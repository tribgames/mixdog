/**
 * src/tui/spinner-meta.mjs — the spinner BYLINE contract, shared by the TUI
 * spinner row and the desktop live-activity band.
 *
 * The verb pool already lives in spinner-verbs.mjs so both surfaces say the
 * same word at the same second. Everything AFTER the verb (elapsed gate, token
 * label, thinking / "thought for Ns") used to be assembled twice, which is how
 * the desktop ended up showing tokens from second one while the TUI hid them
 * for 30s. One builder, one answer.
 */

const compactNumberFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});

export function formatSpinnerTokens(value) {
  const tokens = Math.max(0, Number(value || 0));
  if (tokens >= 1000) return compactNumberFormatter.format(tokens).toLowerCase();
  return String(Math.round(tokens));
}

// `auto` is the absence of a choice, so it never becomes a visible suffix —
// only an explicitly picked level earns "thinking (high)".
function effortSuffix(effort) {
  const level = String(effort || '').trim().toLowerCase();
  if (!level || level === 'auto' || level === 'default' || level === 'off' || level === 'none') return '';
  return ` (${level})`;
}

/**
 * Live thinking reads as `thinking`; a finished thinking span reads as
 * `thought for Ns` until the next one starts. Sub-second
 * spans are noise and stay hidden.
 */
export function spinnerThinkingLabel({ thinking = false, thinkingSince = 0, thinkingMs = 0, effort = '' } = {}) {
  if (thinking || Number(thinkingSince) > 0) return `thinking${effortSuffix(effort)}`;
  const ms = Math.max(0, Number(thinkingMs) || 0);
  if (ms >= 1000) return `thought for ${Math.max(1, Math.round(ms / 1000))}s`;
  return '';
}

/**
 * Byline pieces for one live turn. Width gating stays with each surface (the
 * TUI measures terminal columns, the desktop wraps in CSS) — this only decides
 * WHAT is worth showing and how it reads.
 */
export function buildSpinnerMeta({
  elapsedMs = 0,
  outputTokens = 0,
  thinking = false,
  thinkingSince = 0,
  thinkingMs = 0,
  effort = '',
  verbose = false,
} = {}) {
  const tokens = Math.max(0, Number(outputTokens) || 0);
  const thinkingText = spinnerThinkingLabel({ thinking, thinkingSince, thinkingMs, effort });
  return {
    tokensText: tokens > 0 ? `${formatSpinnerTokens(tokens)} tokens` : '',
    // The count appears with the FIRST token (user: 30초가 아니라 바로).
    // Elapsed was never gated, so the byline used to grow a second field
    // mid-turn for no reason the reader could see; now both arrive together.
    showTokens: tokens > 0,
    thinkingText,
    thinkingActive: Boolean(thinking || Number(thinkingSince) > 0),
  };
}

/**
 * Reduced motion: one switch for the whole process — animation is a nicety,
 * and low-power/SSH/recording sessions must be able to drop it without losing
 * the timer or the token readout.
 */
export function isReducedMotion(env) {
  const source = env || (typeof process !== 'undefined' && process?.env) || {};
  const value = String(source.MIXDOG_REDUCED_MOTION ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on' || value === 'yes';
}
