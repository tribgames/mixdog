/**
 * components/Spinner.jsx — the "thinking" indicator.
 *
 * Spinner row layout:
 *   - frames sweep forward then back.
 *   - the glyph sits in a `width={2}` box.
 *   - verb… verb shimmer: traveling highlight with mode-aware glimmer speed.
 *   - stall detection with exponential smoothing: intensity fades in/out over
 *     2s fade.
 *   - thinking shimmer: left-to-right "thinking" label after delay.
 *   - progressive width gating: timer/tokens/thinking shown left→right only if
 *     they fit after the previous segments.
 *   - token counter animation: smooth increment toward the current turn's
 *     output token count as a single "<glyph> N tokens" segment. The glyph
 *     is mode-driven: up while requesting, down otherwise. Input totals hidden.
 *   - elided duration formatting ("0:25" after 60s).
 *   - mode prop: 'responding' | 'thinking' | 'tool-use' | 'tool-input' |
 *     'requesting' | 'reconnecting' | 'compacting' | 'resuming' (default 'responding').
 */
import { Box, Text } from 'ink';
import { useSharedTick } from '../hooks/useSharedTick.mjs';
import { theme } from '../theme.mjs';
import { SPINNER_FRAMES, SPINNER_MODE_OVERRIDE_VERBS, spinnerVerbFor } from '../spinner-verbs.mjs';
import { isReducedMotion } from '../spinner-meta.mjs';
import { SpinnerByline, interpolateColor, toRgbString } from './SpinnerByline.jsx';
import { useSpinnerProgress } from './use-spinner-progress.mjs';

const FRAME_MS = 130;
// SPINNER_FRAMES is already a there-and-back sweep (first === last), so loop it
// without its closing frame; repeating the endpoint held ◇ for two ticks at
// every wrap and made the loop seam stutter.
const FRAMES = SPINNER_FRAMES.slice(0, -1);

// Reduced motion: the glyph freezes, the shimmer stops and the tick drops to
// one second so only the timer keeps moving.
const REDUCED_MOTION_TICK_MS = 1000;
// The phrase itself comes from the shared pool in spinner-verbs.mjs — see
// spinnerVerbFor(). Mode only drives shimmer speed, token glyph and stall tint.

function parseRgb(str) {
  const m = str.match(/^rgb\((\d+),(\d+),(\d+)\)$/);
  return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
}

// Parsed RGB tuples are derived from the active theme. They are resolved per
// render (cheap regex parse) so a live `/theme` switch — which mutates `theme`
// in-place and re-renders the tree — picks up the new shimmer/glyph colors
// instead of the colors captured at module load.
function spinnerRgb() {
  return {
    TEXT_RGB: parseRgb(theme.spinnerText) ?? parseRgb(theme.text),
    SHIMMER_RGB: parseRgb(theme.spinnerShimmer) ?? parseRgb(theme.claudeShimmer),
    SPINNER_GLYPH_RGB: parseRgb(theme.spinnerGlyph) ?? { r: 240, g: 240, b: 240 },
    THINKING_INACTIVE: parseRgb(theme.thinkingBase) ?? parseRgb(theme.thinkingAccent) ?? { r: 153, g: 153, b: 153 },
    THINKING_SHIMMER: parseRgb(theme.thinkingGlow) ?? { r: 255, g: 205, b: 175 },
    STALL_RGB: parseRgb(theme.error) ?? { r: 171, g: 43, b: 63 },
  };
}

export function Spinner({
  verb = 'Working',
  startedAt,
  outputTokens = 0,
  tokens = 0,
  thinking = false,
  thinkingActiveSince = 0,
  thinkingMs = 0,
  effort = '',
  // The turn's quiet state (`spinner.quiet`), shown as the quiet-time cue.
  quiet = null,
  hasActiveTools = false,
  paused = false,
  interruptible = false,
  mode = 'responding',
  columns = 80,
  marginTop = 1,
}) {
  const reducedMotion = isReducedMotion();
  // Re-render at the frame cadence off the shared tick (no dedicated timer).
  // Glyph/shimmer/token/elapsed values are all derived from Date.now() below.
  useSharedTick(reducedMotion ? REDUCED_MOTION_TICK_MS : FRAME_MS);
  const { TEXT_RGB, SHIMMER_RGB, SPINNER_GLYPH_RGB, THINKING_INACTIVE, THINKING_SHIMMER, STALL_RGB } = spinnerRgb();
  const now = Date.now();
  // Animation clock: raw wall time since the turn began. It never pauses, so a
  // frozen timer (below) still animates instead of looking hung.
  const rawElapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const frame = reducedMotion ? 0 : Math.floor(rawElapsedMs / FRAME_MS);
  const { elapsedMs, stalledIntensity, displayedOutputTokens } = useSpinnerProgress({
    now,
    startedAt,
    rawElapsedMs,
    frame,
    outputTokens,
    tokens,
    paused,
    hasActiveTools,
    mode,
    reducedMotion,
  });

  const glyph = FRAMES[frame % FRAMES.length];

  // Glyph color — interpolate toward red when stalled.
  const glyphColor =
    stalledIntensity > 0
      ? toRgbString(interpolateColor(SPINNER_GLYPH_RGB, STALL_RGB, stalledIntensity))
      : theme.spinnerGlyph;

  // --- Verb (one common pool, one phrase per 30s window) ---
  // Anchored to `startedAt`, so a mode flip cannot rewrite the label and the
  // desktop shows the same word at the same second.
  const displayVerb =
    SPINNER_MODE_OVERRIDE_VERBS[mode] ||
    (mode === 'reconnecting' ? String(verb || '').trim() || 'Reconnecting' : spinnerVerbFor(startedAt, now));

  return (
    <Box marginTop={marginTop} flexDirection="row">
      <Box flexWrap="wrap" height={1} width={2}>
        <Text color={glyphColor}>{glyph}</Text>
      </Box>
      <SpinnerByline
        displayVerb={displayVerb}
        mode={mode}
        rawElapsedMs={rawElapsedMs}
        elapsedMs={elapsedMs}
        displayedOutputTokens={displayedOutputTokens}
        thinking={thinking}
        thinkingActiveSince={thinkingActiveSince}
        thinkingMs={thinkingMs}
        effort={effort}
        quiet={quiet}
        now={now}
        interruptible={interruptible}
        columns={columns}
        reducedMotion={reducedMotion}
        colors={{ TEXT_RGB, SHIMMER_RGB, THINKING_INACTIVE, THINKING_SHIMMER }}
      />
    </Box>
  );
}
