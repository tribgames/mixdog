/**
 * components/SpinnerByline.jsx — the verb + "(timer · tokens · thinking · hint)"
 * part of the Spinner row.
 *
 * Progressive width gating: status parts are shown left→right, each only if it
 * fits after the previous ones. The interrupt hint and thinking status win the
 * width race (they render LAST but are gated FIRST), then timer, then tokens.
 */
import { Text } from 'ink';
import { theme } from '../theme.mjs';
import { buildSpinnerMeta } from '../spinner-meta.mjs';
import { DOWN_ARROW, UP_ARROW } from '../figures.mjs';
import { formatDuration } from '../time-format.mjs';

// A running turn always states how to stop it.
const INTERRUPT_HINT = 'esc to interrupt';
// Thinking shimmer starts after this delay.
const THINKING_DELAY_MS = 3000;

// One-way shimmer. The tail runs past the final character before restarting.
const GLIMMER_SPEED_MS = {
  requesting: 70,
  'model-thinking': 70,
  reconnecting: 70,
  compacting: 120,
  'auto-clear': 120,
  resuming: 120,
  'tool-use': 120,
  responding: 120,
  thinking: 120,
  'tool-input': 120,
};
// A wider trail turns the highlight into a wipe travelling across the phrase
// instead of a single bright character hopping along it.
const GLIMMER_TRAIL = 6;
const THINKING_GLIMMER_SPEED_MS = 120;
const THINKING_GLIMMER_TRAIL = 4;

const STATUS_SEP = ' · ';
const SEP_WIDTH = STATUS_SEP.length;

export function interpolateColor(a, b, t) {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

export function toRgbString(c) {
  return `rgb(${c.r},${c.g},${c.b})`;
}

function renderShimmerText(text, head, trail, baseRgb, shimmerRgb, baseColor, keyPrefix, span) {
  if (!text) return null;
  if (!baseRgb || !shimmerRgb) return <Text color={baseColor}>{text}</Text>;

  // Wrap distance so the highlight flows continuously and at a constant cadence
  // regardless of text length. Without wrapping, longer text leaves a long dark
  // gap between sweeps (head exits past the end before resetting), which reads
  // as a stuttering, uneven glow. With a fixed span the rhythm stays uniform
  // from start to finish.
  const cycle = span || text.length + trail;
  return (
    <>
      {Array.from(text).map((char, index) => {
        let distance = head - index;
        // Treat the sweep as a loop: when head wraps past the end, the tail of
        // the previous pass is the same as the head of the next one.
        if (distance < 0) distance += cycle;
        const intensity = distance >= 0 && distance < trail ? 1 - distance / trail : 0;
        const color =
          intensity > 0 ? toRgbString(interpolateColor(baseRgb, shimmerRgb, 0.35 + intensity * 0.65)) : baseColor;
        return (
          <Text key={`${keyPrefix}-${index}`} color={color}>
            {char}
          </Text>
        );
      })}
    </>
  );
}

// Token-direction glyph by mode:
// up while uploading the request, down while receiving a response, and no
// glyph at all for non-streaming modes (compacting/resuming/auto-clear) where
// the arrow direction would be meaningless.
function tokenModeGlyph(mode) {
  switch (mode) {
    case 'tool-input':
    case 'tool-use':
    case 'responding':
    case 'thinking':
      return DOWN_ARROW;
    // The request is sent and nothing has come back yet.
    case 'requesting':
    case 'model-thinking':
      return UP_ARROW;
    default:
      return '';
  }
}

export function SpinnerByline({
  displayVerb,
  mode,
  rawElapsedMs,
  elapsedMs,
  displayedOutputTokens,
  thinking,
  thinkingActiveSince,
  thinkingMs,
  effort,
  quiet = null,
  now = Date.now(),
  interruptible,
  columns,
  reducedMotion,
  colors,
}) {
  const { TEXT_RGB, SHIMMER_RGB, THINKING_INACTIVE, THINKING_SHIMMER } = colors;
  const messageLen = displayVerb.length;

  // Glimmer speed per mode.
  const glimmerSpeed = GLIMMER_SPEED_MS[mode] ?? 200;
  const shimmerSpan = Math.max(1, messageLen + GLIMMER_TRAIL);
  const shimmerHead = Math.floor(rawElapsedMs / glimmerSpeed) % shimmerSpan;

  // Keep the verb shimmer moving even during stalls/tool waits. Stall tinting is
  // limited to the glyph; tinting the whole verb made the sweep disappear after
  // a few seconds and read as a stuck dark label.
  let verbContent = null;
  if (messageLen > 0) {
    if (!reducedMotion && TEXT_RGB && SHIMMER_RGB) {
      verbContent = renderShimmerText(
        displayVerb,
        shimmerHead,
        GLIMMER_TRAIL,
        TEXT_RGB,
        SHIMMER_RGB,
        theme.spinnerText,
        'verb',
        shimmerSpan
      );
    } else {
      verbContent = <Text color={theme.spinnerText}>{displayVerb}</Text>;
    }
  }

  // Byline text comes from the shared builder so the desktop band reads the
  // same way (token gate, thinking vs "thought for Ns").
  const meta = buildSpinnerMeta({
    elapsedMs,
    outputTokens: displayedOutputTokens,
    thinking,
    thinkingSince: thinkingActiveSince,
    thinkingMs,
    effort,
    quiet,
    now,
  });
  const tokenGlyph = tokenModeGlyph(mode);
  let tokenText = '';
  if (meta.tokensText) {
    tokenText = tokenGlyph ? `${tokenGlyph} ${meta.tokensText}` : meta.tokensText;
  }
  const tokenW = tokenText.length;

  // Hidden for short turns by default; thinking status can still show alone.
  const avail = columns - messageLen - 5; // glyph(2) + ' (' + ')'

  const timerLabel = formatDuration(elapsedMs);
  const timerW = timerLabel.length;
  const thinkingActive = meta.thinkingActive;
  const thinkingStatusText = meta.thinkingText;
  const thinkingStatusW = thinkingStatusText.length;
  // Turn elapsed time is the headline metric here, not a thinking sub-stat, so
  // it shows from 1s onward (formatDuration returns '' below 1s). Tokens keep a
  // short-turn gate: they only appear once the turn runs long.
  const wantsTokens = meta.showTokens;

  const interruptText = interruptible ? INTERRUPT_HINT : '';
  const interruptW = interruptText.length;
  const showInterrupt = Boolean(interruptText) && avail > interruptW;
  const usedAfterInterrupt = showInterrupt ? interruptW + SEP_WIDTH : 0;
  // A quiet turn says so before any other stat: it is the one that explains a
  // long silence (the interrupt hint beside it is how to stop it).
  const quietText = meta.quietText;
  const showQuiet = Boolean(quietText) && avail > usedAfterInterrupt + quietText.length;
  const usedAfterQuiet = usedAfterInterrupt + (showQuiet ? quietText.length + SEP_WIDTH : 0);
  const showThinkingStatus = Boolean(thinkingStatusText) && avail > usedAfterQuiet + thinkingStatusW;
  const usedAfterThinking = usedAfterQuiet + (showThinkingStatus ? thinkingStatusW + SEP_WIDTH : 0);
  const showTimer = Boolean(timerLabel) && avail > usedAfterThinking + timerW;
  const usedAfterTimer = usedAfterThinking + (showTimer ? timerW + SEP_WIDTH : 0);
  const showTokens = wantsTokens && tokenText && avail > usedAfterTimer + tokenW;

  // Build meta line segments — elapsed, tokens, thinking.
  const segments = [];
  if (showTimer) {
    segments.push(
      <Text key="elapsed" color={theme.timerText}>
        {timerLabel}
      </Text>
    );
  }
  if (showTokens) {
    segments.push(
      <Text key="tokens" color={theme.statusSubtle}>
        {tokenText}
      </Text>
    );
  }
  if (showThinkingStatus) {
    const thinkingSpan = Math.max(1, thinkingStatusText.length + THINKING_GLIMMER_TRAIL);
    const thinkingHead =
      Math.floor(Math.max(0, rawElapsedMs - THINKING_DELAY_MS) / THINKING_GLIMMER_SPEED_MS) % thinkingSpan;
    segments.push(
      thinkingActive && !reducedMotion ? (
        <Text key="thinking-status">
          {renderShimmerText(
            thinkingStatusText,
            thinkingHead,
            THINKING_GLIMMER_TRAIL,
            THINKING_INACTIVE,
            THINKING_SHIMMER,
            theme.thinkingBase,
            'thinking-status',
            thinkingSpan
          )}
        </Text>
      ) : (
        <Text key="thinking-status" color={theme.statusSubtle}>
          {thinkingStatusText}
        </Text>
      )
    );
  }
  if (showQuiet) {
    segments.push(
      <Text key="quiet" color={meta.quietParts?.escalated ? theme.warning : theme.statusSubtle}>
        {quietText}
      </Text>
    );
  }
  if (showInterrupt) {
    segments.push(
      <Text key="interrupt" color={theme.statusSubtle}>
        {interruptText}
      </Text>
    );
  }
  const separatedSegments = [];
  for (const [index, segment] of segments.entries()) {
    if (index > 0) {
      separatedSegments.push(
        <Text key={`s${index}`} color={theme.statusSubtle}>
          {STATUS_SEP}
        </Text>
      );
    }
    separatedSegments.push(segment);
  }
  return (
    <>
      {verbContent}
      {segments.length > 0 ? (
        <Text color={theme.inactive}>
          {' ('}
          {separatedSegments}
          {')'}
        </Text>
      ) : null}
    </>
  );
}
