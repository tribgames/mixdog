/**
 * components/Spinner.jsx — the "thinking" indicator (Claude Code shape).
 *
 *   ✻ Burrowing… (23s · ↑ 621 tokens · esc to interrupt)
 *
 * Ported from Claude Code's Spinner/SpinnerGlyph:
 *   - frames = [...DEFAULT_CHARACTERS, ...reverse] so it sweeps forward then
 *     back (CC SpinnerGlyph.tsx SPINNER_FRAMES).
 *   - the glyph sits in a `width={2}` box (CC's <Box height={1} width={2}>).
 *   - verb…  + a dim meta line (elapsed · tokens · interrupt hint).
 */
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.mjs';
import { SPINNER_FRAMES } from '../spinner-verbs.mjs';
import { UP_ARROW } from '../figures.mjs';

const FRAME_MS = 120;
// CC plays the frames forward, then in reverse — a smooth there-and-back sweep.
const FRAMES = [...SPINNER_FRAMES, ...[...SPINNER_FRAMES].reverse()];

export function Spinner({ verb = 'Working', startedAt, tokens = 0 }) {
  const [frame, setFrame] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
      setNow(Date.now());
    }, FRAME_MS);
    return () => clearInterval(id);
  }, []);

  const elapsed = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const glyph = FRAMES[frame % FRAMES.length];
  const meta = [
    `${elapsed}s`,
    tokens > 0 ? `${UP_ARROW} ${tokens} tokens` : null,
    'esc to interrupt',
  ].filter(Boolean).join(' · ');

  return (
    <Box marginTop={1} flexDirection="row">
      <Box flexWrap="wrap" height={1} width={2}>
        <Text color={theme.text}>{glyph}</Text>
      </Box>
      <Text color={theme.text}>{verb}…</Text>
      <Text color={theme.inactive}>{` (${meta})`}</Text>
    </Box>
  );
}
