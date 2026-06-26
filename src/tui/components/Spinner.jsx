/**
 * components/Spinner.jsx — the "thinking" indicator (Claude Code shape).
 *
 * Ported from Claude Code's SpinnerAnimationRow + SpinnerGlyph + GlimmerMessage:
 *   - frames = [...DEFAULT_CHARACTERS, ...reverse] so it sweeps forward then
 *     back (CC SpinnerGlyph SPINNER_FRAMES).
 *   - the glyph sits in a `width={2}` box (CC's <Box height={1} width={2}>).
 *   - verb… verb shimmer: traveling highlight in claudeShimmer with
 *     mode-aware glimmer speed (CC GlimmerMessage).
 *   - stall detection with exponential smoothing: intensity fades in/out over
 *     2s (CC useStalledAnimation).
 *   - thinking shimmer: left-to-right "thinking" label after delay (CC
 *     ThinkingShimmerText, inlined from useAnimationFrame).
 *   - progressive width gating: timer/tokens/thinking shown left→right only if
 *     they fit after the previous segments (CC SpinnerAnimationRow).
 *   - token counter animation: smooth increment toward the current turn's
 *     output token count, shown Claude Code style as a single "<glyph> N
 *     tokens" segment (CC SpinnerAnimationRow + SpinnerModeGlyph). The glyph
 *     is mode-driven: up while requesting, down otherwise. Input totals hidden.
 *   - elided duration formatting (CC formatDuration: "0:25" after 60s).
 *   - mode prop: 'responding' | 'thinking' | 'tool-use' | 'tool-input' |
 *     'requesting' | 'compacting' | 'resuming' (default 'responding').
 */
import React, { useRef } from 'react';
import { Box, Text, useAnimation } from 'ink';
import { theme } from '../theme.mjs';
import { SPINNER_FRAMES } from '../spinner-verbs.mjs';
import { DOWN_ARROW, UP_ARROW } from '../figures.mjs';
import { formatDuration } from '../time-format.mjs';

const FRAME_MS = 130;
// CC plays the frames forward, then in reverse — a smooth there-and-back sweep.
const FRAMES = [...SPINNER_FRAMES, ...[...SPINNER_FRAMES].reverse()];

// Stall: response must grow within this window or the glyph reddens.
const STALL_TIMEOUT_MS = 3000;
const STALL_FADE_MS = 2000; // CC fades red over 2s
// Claude Code hides elapsed/token meta on short turns unless verbose/teammates
// are active. Mixdog has no spinner verbose/teammate row here, so mirror the
// default 30s threshold.
const SHOW_TOKENS_AFTER_MS = 30_000;
// Thinking shimmer starts after this delay (CC THINKING_DELAY_MS).
const THINKING_DELAY_MS = 3000;

// One-way shimmer. The tail runs past the final character before restarting.
const GLIMMER_SPEED_MS = { requesting: 70, compacting: 120, 'auto-clear': 120, resuming: 120, 'tool-use': 120, responding: 120, thinking: 120, 'tool-input': 120 };
const GLIMMER_TRAIL = 4;
const THINKING_GLIMMER_SPEED_MS = 120;
const THINKING_GLIMMER_TRAIL = 4;
const VERB_ROTATE_MIN_MS = 10000;
const VERB_ROTATE_SPREAD_MS = 10000;
const VERB_CHANGE_PROBABILITY = 0.65;

const MODE_VERBS = {
  requesting: ['Requesting', 'Preparing', 'Routing'],
  compacting: ['Compacting conversation'],
  'auto-clear': ['Auto-clearing conversation'],
  resuming: ['Resuming conversation'],
  thinking: ['Thinking', 'Reasoning', 'Mapping'],
  'tool-use': ['Using tools', 'Checking files', 'Running tools', 'Reading output'],
  'tool-input': ['Using tools', 'Checking files', 'Running tools', 'Reading output'],
  responding: ['Responding', 'Composing', 'Writing', 'Wrapping up'],
};

const ERROR_RED = { r: 171, g: 43, b: 63 };

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

const TEXT_RGB = parseRgb(theme.spinnerText) ?? parseRgb(theme.text);
const SHIMMER_RGB = parseRgb(theme.spinnerShimmer) ?? parseRgb(theme.claudeShimmer);
const SPINNER_GLYPH_RGB = parseRgb(theme.spinnerGlyph) ?? { r: 240, g: 240, b: 240 };
const THINKING_INACTIVE = parseRgb(theme.thinkingBase) ?? parseRgb(theme.thinkingAccent) ?? { r: 153, g: 153, b: 153 };
const THINKING_SHIMMER = parseRgb(theme.thinkingGlow) ?? { r: 255, g: 205, b: 175 };

const compactNumberFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});

function formatNumber(n) {
  const value = Math.max(0, Number(n || 0));
  if (value >= 1000) return compactNumberFormatter.format(value).toLowerCase();
  return String(Math.round(value));
}

const STATUS_SEP = ' · ';
const SEP_WIDTH = STATUS_SEP.length;

function stableModeVerb(mode, fallback) {
  const phrases = MODE_VERBS[mode] || [fallback || 'Working'];
  return phrases[0] || fallback || 'Working';
}

function nextVerbCheckAt(now) {
  return now + VERB_ROTATE_MIN_MS + Math.floor(Math.random() * VERB_ROTATE_SPREAD_MS);
}

function chooseNextVerb(mode, fallback, current) {
  const phrases = MODE_VERBS[mode] || [fallback || 'Working'];
  if (phrases.length <= 1 || Math.random() > VERB_CHANGE_PROBABILITY) return current || phrases[0];
  const candidates = phrases.filter((phrase) => phrase && phrase !== current);
  if (!candidates.length) return current || phrases[0];
  return candidates[Math.floor(Math.random() * candidates.length)];
}

export function Spinner({ verb = 'Working', startedAt, outputTokens = 0, tokens = 0, thinking = false, thinkingActiveSince = 0, mode = 'responding', columns = 80, marginTop = 1 }) {
  useAnimation({ interval: FRAME_MS });
  const now = Date.now();
  const elapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const frame = Math.floor(elapsedMs / FRAME_MS);
  const lastGrowRef = useRef(now);
  const lastTokensRef = useRef(0);
  const displayedOutputRef = useRef(0);
  const displayVerbRef = useRef('');
  const displayVerbModeRef = useRef('');
  const nextVerbCheckRef = useRef(0);
  // Stall smoothing refs (CC useStalledAnimation exponential fade)
  const stallSmoothRef = useRef(0);
  const lastStallTickRef = useRef(0);

  const targetOutputTokens = Math.max(0, Number(outputTokens || tokens || 0));

  // Stall detection — track output growth, because input usually arrives as one
  // usage update while the assistant/tool response is what should keep moving.
  if (targetOutputTokens > lastTokensRef.current) {
    lastTokensRef.current = targetOutputTokens;
    lastGrowRef.current = now;
  }

  const stallMs = now - lastGrowRef.current;
  const isStalled = targetOutputTokens > 0 && stallMs > STALL_TIMEOUT_MS;
  // Stall smoothing: exponential fade toward target (CC useStalledAnimation)
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

  // Glyph color — interpolate toward red when stalled (CC SpinnerGlyph).
  const glyphColor = stalledIntensity > 0
    ? toRgbString(interpolateColor(
        SPINNER_GLYPH_RGB,
        ERROR_RED,
        stalledIntensity
      ))
    : theme.spinnerGlyph;

  // --- Verb shimmer (CC GlimmerMessage traveling highlight) ---
  if (displayVerbModeRef.current !== mode || !displayVerbRef.current) {
    displayVerbModeRef.current = mode;
    displayVerbRef.current = stableModeVerb(mode, verb);
    nextVerbCheckRef.current = nextVerbCheckAt(now);
  } else if (now >= nextVerbCheckRef.current) {
    displayVerbRef.current = chooseNextVerb(mode, verb, displayVerbRef.current);
    nextVerbCheckRef.current = nextVerbCheckAt(now);
  }
  const displayVerb = displayVerbRef.current;
  const messageText = `${displayVerb}…`;
  const messageLen = messageText.length;

  // Glimmer speed per mode.
  const glimmerSpeed = GLIMMER_SPEED_MS[mode] ?? 200;
  const shimmerSpan = Math.max(1, messageLen + GLIMMER_TRAIL);
  const shimmerHead = Math.floor(elapsedMs / glimmerSpeed) % shimmerSpan;

  // Keep the verb shimmer moving even during stalls/tool waits. Stall tinting is
  // limited to the glyph; tinting the whole verb made the sweep disappear after
  // a few seconds and read as a stuck dark label.
  const verbContent = messageLen > 0 && TEXT_RGB && SHIMMER_RGB
    ? renderShimmerText(messageText, shimmerHead, GLIMMER_TRAIL, TEXT_RGB, SHIMMER_RGB, theme.spinnerText, 'verb', shimmerSpan)
    : null;

  const advanceCounter = (ref, target) => {
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

  // Token counter animation — Claude Code shows a single "<glyph> N tokens"
  // segment (SpinnerAnimationRow + SpinnerModeGlyph). N is the output/response
  // token count, smoothly incremented toward the current turn's value. The
  // glyph is mode-driven: up while requesting, down otherwise (responding,
  // thinking, tool-use, tool-input). Input token totals are not shown.
  const displayedOutputTokens = advanceCounter(displayedOutputRef, targetOutputTokens);

  const tokenGlyph = mode === 'requesting' ? UP_ARROW : DOWN_ARROW;
  const tokenText = displayedOutputTokens > 0 ? `${tokenGlyph} ${formatNumber(displayedOutputTokens)} tokens` : '';
  const tokenW = tokenText.length;

  // Progressive width gating (CC SpinnerAnimationRow): show status parts
  // left→right, each only if it fits after the previous ones. Timer/tokens are
  // hidden for short turns by default; thinking status can still show alone.
  const avail = columns - messageLen - 5; // glyph(2) + ' (' + ')'

  const timerText = formatDuration(elapsedMs);
  const timerLabel = timerText;
  const timerW = timerLabel.length;
  const thinkingActive = Boolean(thinking || thinkingActiveSince);
  const thinkingStatusText = thinkingActive
    ? 'thinking'
    : '';
  const thinkingStatusW = thinkingStatusText.length;
  const wantsTimerAndTokens = elapsedMs > SHOW_TOKENS_AFTER_MS;

  // Claude Code gives thinking display priority for narrow widths, but renders
  // it after timer/tokens in the final byline.
  const showThinkingStatus = Boolean(thinkingStatusText) && avail > thinkingStatusW;
  const usedAfterThinking = showThinkingStatus ? thinkingStatusW + SEP_WIDTH : 0;
  const showTimer = wantsTimerAndTokens && Boolean(timerLabel) && avail > usedAfterThinking + timerW;
  const usedAfterTimer = usedAfterThinking + (showTimer ? timerW + SEP_WIDTH : 0);
  const showTokens = wantsTimerAndTokens && tokenText && avail > usedAfterTimer + tokenW;

  // Build meta line segments — elapsed, tokens, thinking (Claude Code order).
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
    const thinkingHead = Math.floor(Math.max(0, elapsedMs - THINKING_DELAY_MS) / THINKING_GLIMMER_SPEED_MS) % thinkingSpan;
    segments.push(
      thinkingActive
        ? <Text key="thinking-status">{renderShimmerText(thinkingStatusText, thinkingHead, THINKING_GLIMMER_TRAIL, THINKING_INACTIVE, THINKING_SHIMMER, theme.thinkingBase, 'thinking-status', thinkingSpan)}</Text>
        : <Text key="thinking-status" color={theme.statusSubtle}>{thinkingStatusText}</Text>
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
