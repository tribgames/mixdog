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
 *   - thinking shimmer: pulsing "thinking" label after delay (CC
 *     ThinkingShimmerText, inlined from useAnimationFrame).
 *   - progressive width gating: timer/tokens/hint shown left→right only if
 *     they fit after the previous segments (CC SpinnerAnimationRow).
 *   - progressive width gating: meta (elapsed/tokens) shown immediately as soon
 *     as columns allow (no time gate — live estimate from streamed text length).
 *   - token counter animation: smooth increment toward real count (CC
 *     tokenCounterRef ratcheting).
 *   - mode-aware token glyph: ↑ for requesting, ↓ for others (CC
 *     SpinnerModeGlyph).
 *   - elided duration formatting (CC formatDuration: "0:25" after 60s).
 *   - mode prop: 'responding' | 'thinking' | 'tool-use' | 'tool-input' |
 *     'requesting' (default 'responding').
 */
import React, { useEffect, useState, useRef } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.mjs';
import { SPINNER_FRAMES } from '../spinner-verbs.mjs';
import { DOWN_ARROW, UP_ARROW } from '../figures.mjs';

const FRAME_MS = 50;
// CC plays the frames forward, then in reverse — a smooth there-and-back sweep.
const FRAMES = [...SPINNER_FRAMES, ...[...SPINNER_FRAMES].reverse()];

// Stall: response must grow within this window or the glyph reddens.
const STALL_TIMEOUT_MS = 3000;
const STALL_FADE_MS = 2000; // CC fades red over 2s
// Hint ("esc to interrupt") shown after this threshold — timer/tokens are always visible.
const SHOW_HINT_AFTER_MS = 30000;
// Thinking shimmer starts after this delay (CC THINKING_DELAY_MS).
const THINKING_DELAY_MS = 3000;
const THINKING_GLOW_PERIOD_S = 2;

// CC SpinnerAnimationRow: requesting glimmer advances every tick, others are slower.
const GLIMMER_SPEED_MS = { requesting: 50, 'tool-use': 200, responding: 200, thinking: 200, 'tool-input': 200 };

// Color constants matching CC's THINKING_INACTIVE / THINKING_INACTIVE_SHIMMER
const THINKING_INACTIVE = { r: 153, g: 153, b: 153 };
const THINKING_SHIMMER = { r: 185, g: 185, b: 185 };
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

const TEXT_RGB = parseRgb(theme.text);
const SHIMMER_RGB = parseRgb(theme.claudeShimmer);

function formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatNumber(n) {
  return n.toLocaleString('en-US');
}

const SEP_WIDTH = 3; // stringWidth(' · ')
const THINKING_WIDTH = 8; // 'thinking'
const HINT_WIDTH = 16; // 'esc to interrupt'

export function Spinner({ verb = 'Working', startedAt, tokens = 0, thinking = false, mode = 'responding', columns = 80 }) {
  const [frame, setFrame] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const lastGrowRef = useRef(now);
  const lastTokensRef = useRef(0);
  const displayedRef = useRef(0);
  // Stall smoothing refs (CC useStalledAnimation exponential fade)
  const stallSmoothRef = useRef(0);
  const lastStallTickRef = useRef(0);

  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
      setNow(Date.now());
    }, FRAME_MS);
    return () => clearInterval(id);
  }, []);

  // Stall detection — track when the token count last grew.
  if (tokens > lastTokensRef.current) {
    lastTokensRef.current = tokens;
    lastGrowRef.current = now;
  }

  const elapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const stallMs = now - lastGrowRef.current;
  const isStalled = tokens > 0 && stallMs > STALL_TIMEOUT_MS;
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

  // Monotonic animation clock (CC SpinnerAnimationRow uses useAnimationFrame's `time`)
  const time = frame * FRAME_MS;

  const glyph = FRAMES[frame % FRAMES.length];

  // Glyph color — interpolate toward red when stalled (CC SpinnerGlyph).
  const glyphColor = stalledIntensity > 0
    ? toRgbString(interpolateColor(
        { r: 240, g: 240, b: 240 }, // ~theme.text RGB
        ERROR_RED,
        stalledIntensity
      ))
    : theme.text;

  // Thinking shimmer (CC thinkingShimmerColor from shared clock).
  const thinkingSec = (elapsedMs - THINKING_DELAY_MS) / 1000;
  const thinkingOpacity = elapsedMs < THINKING_DELAY_MS
    ? 0
    : (Math.sin(thinkingSec * Math.PI * 2 / THINKING_GLOW_PERIOD_S) + 1) / 2;
  const thinkingColor = toRgbString(
    interpolateColor(THINKING_INACTIVE, THINKING_SHIMMER, thinkingOpacity)
  );

  // --- Verb shimmer (CC GlimmerMessage traveling highlight) ---
  const messageText = `${verb}…`;
  const messageLen = messageText.length;

  // Glimmer speed per mode (CC: requesting=50, others=200)
  const glimmerSpeed = GLIMMER_SPEED_MS[mode] ?? 200;
  // Glimmer sweeps forward then backward across the message
  const glimmerPeriod = Math.max(1, messageLen * 2 - 2);
  const glimmerStep = Math.floor(time / glimmerSpeed);
  const glimmerRaw = glimmerStep % glimmerPeriod;
  const glimmerIndex = glimmerRaw < messageLen ? glimmerRaw : glimmerPeriod - glimmerRaw;

  // Pulsing shimmer intensity (same period as thinking glow)
  const glimmerOpacity = (Math.sin(elapsedMs / 1000 * Math.PI * 2 / THINKING_GLOW_PERIOD_S) + 1) / 2;
  const glimmerColor = TEXT_RGB && SHIMMER_RGB
    ? toRgbString(interpolateColor(TEXT_RGB, SHIMMER_RGB, glimmerOpacity))
    : theme.claudeShimmer;

  // Build shimmer-aware verb content
  let verbContent;
  if (stalledIntensity > 0 && TEXT_RGB) {
    const stalledColor = toRgbString(interpolateColor(TEXT_RGB, ERROR_RED, stalledIntensity));
    verbContent = <Text color={stalledColor}>{messageText}</Text>;
  } else if (messageLen > 0) {
    const windowR = 1;
    const shimmerStart = Math.max(0, glimmerIndex - windowR);
    const shimmerEnd = Math.min(messageLen, glimmerIndex + windowR + 1);
    const before = messageText.slice(0, shimmerStart);
    const shimmer = messageText.slice(shimmerStart, shimmerEnd);
    const after = messageText.slice(shimmerEnd);
    verbContent = (
      <>
        {before ? <Text color={theme.text}>{before}</Text> : null}
        {shimmer ? <Text color={glimmerColor}>{shimmer}</Text> : null}
        {after ? <Text color={theme.text}>{after}</Text> : null}
      </>
    );
  } else {
    verbContent = null;
  }

  // Token counter animation — smooth increment toward token target (CC pattern).
  // `tokens` is a per-turn value (max of real usage & live text estimate);
  // shown as "0 tokens" from turn start, then climbs as estimates/usage arrive.
  if (displayedRef.current > tokens) {
    displayedRef.current = tokens;
  } else if (displayedRef.current < tokens) {
    const gap = tokens - displayedRef.current;
    let increment;
    if (gap < 70) increment = 3;
    else if (gap < 200) increment = Math.max(8, Math.ceil(gap * 0.15));
    else increment = 50;
    displayedRef.current = Math.min(displayedRef.current + increment, tokens);
  }
  const displayedTokens = Math.round(displayedRef.current);

  // Progressive width gating (CC SpinnerAnimationRow:
  //   show things left→right, each only if it fits after the previous ones).
  // Timer and tokens show immediately as columns allow; hint ("esc to interrupt")
  // is gated behind SHOW_HINT_AFTER_MS so it doesn't crowd the line early.
  const showHintNow = elapsedMs > SHOW_HINT_AFTER_MS;
  const avail = columns - messageLen - 5; // glyph(2) + ' (' + ')'

  // Token glyph per mode: ↑ for requesting, ↓ for others (CC SpinnerModeGlyph)
  const tokenGlyph = mode === 'requesting' ? UP_ARROW : DOWN_ARROW;

  const timerText = formatDuration(elapsedMs);
  const timerW = timerText.length;
  // Always show token count (even at 0) so the user sees it animate from the start.
  const tokenText = `${formatNumber(displayedTokens)} tokens`;
  const tokenW = tokenGlyph.length + 1 + tokenText.length;

  // Gate left→right; each segment after the first needs a sep.
  let usedW = 0;
  const showThinking = thinking && elapsedMs > THINKING_DELAY_MS && avail > usedW + THINKING_WIDTH;
  if (showThinking) usedW += THINKING_WIDTH;

  const showTimer = avail > usedW + (usedW > 0 ? SEP_WIDTH : 0) + timerW;
  if (showTimer) usedW += (usedW > 0 ? SEP_WIDTH : 0) + timerW;

  const showTokens = avail > usedW + (usedW > 0 ? SEP_WIDTH : 0) + tokenW;
  if (showTokens) usedW += (usedW > 0 ? SEP_WIDTH : 0) + tokenW;

  const showHint = showHintNow && avail > usedW + (usedW > 0 ? SEP_WIDTH : 0) + HINT_WIDTH;

  // Build meta line segments — order matches CC: thinking, elapsed, tokens, hint.
  const segments = [];
  if (showThinking) {
    segments.push(
      <Text key="thinking" color={thinkingColor}>thinking</Text>
    );
  }
  if (showTimer) {
    segments.push(
      <Text key="elapsed" dimColor>{timerText}</Text>
    );
  }
  if (showTokens) {
    segments.push(
      <Text key="tokens" dimColor>{tokenGlyph} {tokenText}</Text>
    );
  }
  if (showHint) {
    segments.push(
      <Text key="hint" dimColor>esc to interrupt</Text>
    );
  }

  return (
    <Box marginTop={1} flexDirection="row">
      <Box flexWrap="wrap" height={1} width={2}>
        <Text color={glyphColor}>{glyph}</Text>
      </Box>
      {verbContent}
      {segments.length > 0 ? (
        <Text color={theme.inactive}>
          {' ('}
          {segments.reduce((acc, el, i) =>
            i === 0 ? [el] : [...acc, <Text key={`s${i}`} dimColor> · </Text>, el]
          )}
          {')'}
        </Text>
      ) : null}
    </Box>
  );
}
