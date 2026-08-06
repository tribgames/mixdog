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
import React, { useRef } from 'react';
import { Box, Text } from 'ink';
import { useSharedTick } from '../hooks/useSharedTick.mjs';
import { theme } from '../theme.mjs';
import { SPINNER_FRAMES, SPINNER_MODE_OVERRIDE_VERBS, spinnerVerbFor } from '../spinner-verbs.mjs';
import { buildSpinnerMeta, isReducedMotion } from '../spinner-meta.mjs';
import { DOWN_ARROW, UP_ARROW } from '../figures.mjs';
import { formatDuration } from '../time-format.mjs';

const FRAME_MS = 130;
// Play frames forward, then in reverse — a smooth there-and-back sweep.
const FRAMES = [...SPINNER_FRAMES, ...[...SPINNER_FRAMES].reverse()];

// Stall: response must grow within this window or the glyph reddens.
const STALL_TIMEOUT_MS = 3000;
const STALL_FADE_MS = 2000; // fade red over 2s
// Reduced motion: the glyph freezes, the shimmer stops and the tick drops to
// one second so only the timer keeps moving.
const REDUCED_MOTION_TICK_MS = 1000;
// A running turn always states how to stop it.
const INTERRUPT_HINT = 'esc to interrupt';
// Thinking shimmer starts after this delay.
const THINKING_DELAY_MS = 3000;

// One-way shimmer. The tail runs past the final character before restarting.
const GLIMMER_SPEED_MS = { requesting: 70, reconnecting: 70, compacting: 120, 'auto-clear': 120, resuming: 120, 'tool-use': 120, responding: 120, thinking: 120, 'tool-input': 120 };
// A wider trail turns the highlight into a wipe travelling across the phrase
// instead of a single bright character hopping along it.
const GLIMMER_TRAIL = 6;
const THINKING_GLIMMER_SPEED_MS = 120;
const THINKING_GLIMMER_TRAIL = 4;
// The phrase itself comes from the shared pool in spinner-verbs.mjs — see
// spinnerVerbFor(). Mode only drives shimmer speed, token glyph and stall tint.

function interpolateColor(a, b, t) {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

function toRgbString(c) {
  return `rgb(${c.r},${c.g},${c.b})`;
}

function parseRgb(str) {
  const m = str.match(/^rgb\((\d+),(\d+),(\d+)\)$/);
  return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
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
        const intensity = distance >= 0 && distance < trail
          ? 1 - distance / trail
          : 0;
        const color = intensity > 0
          ? toRgbString(interpolateColor(baseRgb, shimmerRgb, 0.35 + intensity * 0.65))
          : baseColor;
        return <Text key={`${keyPrefix}-${index}`} color={color}>{char}</Text>;
      })}
    </>
  );
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

const STATUS_SEP = ' · ';
const SEP_WIDTH = STATUS_SEP.length;

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
    case 'requesting':
      return UP_ARROW;
    default:
      return '';
  }
}

export function Spinner({ verb = 'Working', startedAt, outputTokens = 0, tokens = 0, thinking = false, thinkingActiveSince = 0, thinkingMs = 0, effort = '', hasActiveTools = false, paused = false, interruptible = false, mode = 'responding', columns = 80, marginTop = 1 }) {
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
  const lastGrowRef = useRef(now);
  const lastTokensRef = useRef(0);
  const displayedOutputRef = useRef(0);
  // Pause accounting: time spent waiting on the USER (a tool approval prompt)
  // is not turn time. Without this the reported duration counts however long
  // the prompt sat unanswered and the short-turn token gate opens on it.
  const turnAnchorRef = useRef(startedAt);
  const pausedTotalRef = useRef(0);
  const pauseStartRef = useRef(0);
  // Stall smoothing refs (exponential fade)
  const stallSmoothRef = useRef(0);
  const lastStallTickRef = useRef(0);

  if (turnAnchorRef.current !== startedAt) {
    turnAnchorRef.current = startedAt;
    pausedTotalRef.current = 0;
    pauseStartRef.current = 0;
  }
  if (paused && !pauseStartRef.current) {
    pauseStartRef.current = now;
  } else if (!paused && pauseStartRef.current) {
    pausedTotalRef.current += Math.max(0, now - pauseStartRef.current);
    pauseStartRef.current = 0;
  }
  const pausedMs = pausedTotalRef.current + (pauseStartRef.current ? Math.max(0, now - pauseStartRef.current) : 0);
  const elapsedMs = Math.max(0, rawElapsedMs - pausedMs);

  const targetOutputTokens = Math.max(0, Number(outputTokens || tokens || 0));

  // Stall detection — track output growth, because input usually arrives as one
  // usage update while the assistant/tool response is what should keep moving.
  if (targetOutputTokens > lastTokensRef.current) {
    lastTokensRef.current = targetOutputTokens;
    lastGrowRef.current = now;
  }

  // Waiting is not stalling: while a tool runs (no tokens can arrive) or while
  // the user owns an approval prompt, hold the stall clock at zero. Otherwise a
  // 30s shell command or a slow approval reddens a perfectly healthy turn.
  const workBlocked = paused || hasActiveTools || mode === 'tool-use' || mode === 'tool-input';
  if (workBlocked) lastGrowRef.current = now;

  const stallMs = now - lastGrowRef.current;
  const isStalled = !reducedMotion && targetOutputTokens > 0 && stallMs > STALL_TIMEOUT_MS;
  // Stall smoothing: exponential fade toward target
  const rawIntensity = isStalled
    ? Math.min(1, (stallMs - STALL_TIMEOUT_MS) / STALL_FADE_MS)
    : 0;
  if (rawIntensity > 0 || stallSmoothRef.current > 0) {
    const dt = frame - lastStallTickRef.current;
    if (dt > 0) {
      let cur = stallSmoothRef.current;
      for (let i = 0; i < dt; i++) {
        const diff = rawIntensity - cur;
        if (Math.abs(diff) < 0.01) { cur = rawIntensity; break; }
        cur += diff * 0.1;
      }
      stallSmoothRef.current = cur;
    }
  }
  lastStallTickRef.current = frame;
  const stalledIntensity = stallSmoothRef.current;

  const glyph = FRAMES[frame % FRAMES.length];

  // Glyph color — interpolate toward red when stalled.
  const glyphColor = stalledIntensity > 0
    ? toRgbString(interpolateColor(
        SPINNER_GLYPH_RGB,
        STALL_RGB,
        stalledIntensity
      ))
    : theme.spinnerGlyph;

  // --- Verb (one common pool, one phrase per 30s window) ---
  // Anchored to `startedAt`, so a mode flip cannot rewrite the label and the
  // desktop shows the same word at the same second.
  const displayVerb = SPINNER_MODE_OVERRIDE_VERBS[mode]
    || (mode === 'reconnecting' ? (String(verb || '').trim() || 'Reconnecting') : spinnerVerbFor(startedAt, now));
  const messageText = mode === 'reconnecting' ? displayVerb : `${displayVerb}…`;
  const messageLen = messageText.length;

  // Glimmer speed per mode.
  const glimmerSpeed = GLIMMER_SPEED_MS[mode] ?? 200;
  const shimmerSpan = Math.max(1, messageLen + GLIMMER_TRAIL);
  const shimmerHead = Math.floor(rawElapsedMs / glimmerSpeed) % shimmerSpan;

  // Keep the verb shimmer moving even during stalls/tool waits. Stall tinting is
  // limited to the glyph; tinting the whole verb made the sweep disappear after
  // a few seconds and read as a stuck dark label.
  const verbContent = messageLen > 0 && !reducedMotion && TEXT_RGB && SHIMMER_RGB
    ? renderShimmerText(messageText, shimmerHead, GLIMMER_TRAIL, TEXT_RGB, SHIMMER_RGB, theme.spinnerText, 'verb', shimmerSpan)
    : (messageLen > 0 ? <Text color={theme.spinnerText}>{messageText}</Text> : null);

  const advanceCounter = (ref, target) => {
    if (reducedMotion) {
      ref.current = target;
      return Math.round(target);
    }
    if (ref.current > target) {
      ref.current = target;
    } else if (ref.current < target) {
      const gap = target - ref.current;
      let increment;
      if (gap < 70) increment = 3;
      else if (gap < 200) increment = Math.max(8, Math.ceil(gap * 0.15));
      else increment = 50;
      ref.current = Math.min(ref.current + increment, target);
    }
    return Math.round(ref.current);
  };

  // Token counter animation — single "<glyph> N tokens" segment. N is the output/response
  // token count, smoothly incremented toward the current turn's value. The
  // glyph is mode-driven: up while requesting, down otherwise (responding,
  // thinking, tool-use, tool-input). Input token totals are not shown.
  const displayedOutputTokens = advanceCounter(displayedOutputRef, targetOutputTokens);

  // Byline text comes from the shared builder so the desktop band reads the
  // same way (token gate, thinking vs "thought for Ns").
  const meta = buildSpinnerMeta({
    elapsedMs,
    outputTokens: displayedOutputTokens,
    thinking,
    thinkingSince: thinkingActiveSince,
    thinkingMs,
    effort,
  });
  const tokenGlyph = tokenModeGlyph(mode);
  const tokenText = meta.tokensText
    ? (tokenGlyph ? `${tokenGlyph} ${meta.tokensText}` : meta.tokensText)
    : '';
  const tokenW = tokenText.length;

  // Progressive width gating: show status parts
  // left→right, each only if it fits after the previous ones. Timer/tokens are
  // hidden for short turns by default; thinking status can still show alone.
  const avail = columns - messageLen - 5; // glyph(2) + ' (' + ')'

  const timerText = formatDuration(elapsedMs);
  const timerLabel = timerText;
  const timerW = timerLabel.length;
  const thinkingActive = meta.thinkingActive;
  const thinkingStatusText = meta.thinkingText;
  const thinkingStatusW = thinkingStatusText.length;
  // Turn elapsed time is the headline metric here, not a thinking sub-stat, so
  // it shows from 1s onward (formatDuration returns '' below 1s). Tokens keep
  // Short-turn gate: tokens only appear once the turn runs long.
  const wantsTokens = meta.showTokens;

  // Interrupt hint and thinking status win the width race (they render LAST in
  // the byline but are gated FIRST), then timer, then tokens.
  const interruptText = interruptible ? INTERRUPT_HINT : '';
  const interruptW = interruptText.length;
  const showInterrupt = Boolean(interruptText) && avail > interruptW;
  const usedAfterInterrupt = showInterrupt ? interruptW + SEP_WIDTH : 0;
  const showThinkingStatus = Boolean(thinkingStatusText) && avail > usedAfterInterrupt + thinkingStatusW;
  const usedAfterThinking = usedAfterInterrupt + (showThinkingStatus ? thinkingStatusW + SEP_WIDTH : 0);
  const showTimer = Boolean(timerLabel) && avail > usedAfterThinking + timerW;
  const usedAfterTimer = usedAfterThinking + (showTimer ? timerW + SEP_WIDTH : 0);
  const showTokens = wantsTokens && tokenText && avail > usedAfterTimer + tokenW;

  // Build meta line segments — elapsed, tokens, thinking.
  const segments = [];
  if (showTimer) {
    segments.push(
      <Text key="elapsed" color={theme.timerText}>{timerLabel}</Text>
    );
  }
  if (showTokens) {
    segments.push(
      <Text key="tokens" color={theme.statusSubtle}>{tokenText}</Text>
    );
  }
  if (showThinkingStatus) {
    const thinkingSpan = Math.max(1, thinkingStatusText.length + THINKING_GLIMMER_TRAIL);
    const thinkingHead = Math.floor(Math.max(0, rawElapsedMs - THINKING_DELAY_MS) / THINKING_GLIMMER_SPEED_MS) % thinkingSpan;
    segments.push(
      thinkingActive && !reducedMotion
        ? <Text key="thinking-status">{renderShimmerText(thinkingStatusText, thinkingHead, THINKING_GLIMMER_TRAIL, THINKING_INACTIVE, THINKING_SHIMMER, theme.thinkingBase, 'thinking-status', thinkingSpan)}</Text>
        : <Text key="thinking-status" color={theme.statusSubtle}>{thinkingStatusText}</Text>
    );
  }
  if (showInterrupt) {
    segments.push(
      <Text key="interrupt" color={theme.statusSubtle}>{interruptText}</Text>
    );
  }
  return (
    <Box marginTop={marginTop} flexDirection="row">
      <Box flexWrap="wrap" height={1} width={2}>
        <Text color={glyphColor}>{glyph}</Text>
      </Box>
      {verbContent}
      {segments.length > 0 ? (
        <Text color={theme.inactive}>
          {' ('}
          {segments.reduce((acc, el, i) => (
            i === 0 ? [el] : [...acc, <Text key={`s${i}`} color={theme.statusSubtle}>{STATUS_SEP}</Text>, el]
          ), [])}
          {')'}
        </Text>
      ) : null}
    </Box>
  );
}
