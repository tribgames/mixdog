/**
 * components/MarkdownTable.jsx — GFM table → ink Box layout.
 *
 * GFM table layout for ink:
 *   - <Ansi> → <Text> (ink 7 has no <Ansi>; <Text> passes ANSI escapes through).
 *   - useTerminalSize() → ink useStdout().stdout.columns.
 *   - stringWidth / wrapAnsi from npm packages.
 *   - formatCell uses our format-token.formatToken (no highlight arg).
 *
 * The width-fitting algorithm (ideal vs min widths, proportional shrink, hard
 * wrap, vertical fallback for narrow terminals) is preserved verbatim.
 */
import React from 'react';
import { Text, useStdout } from 'ink';
import { buildTableRender } from '../markdown/table-layout.mjs';

export function MarkdownTable({ token, forceWidth }) {
  // App owns resize reflow and there is no <Static> transcript anymore, so table
  // width can follow the current terminal width without duplicating scrollback.
  const actualTerminalWidth = useStdout()?.stdout?.columns ?? 80;
  const terminalWidth = forceWidth ?? actualTerminalWidth;

  // The entire layout (column fit, vertical fallback, bordered box, overflow
  // re-fallback) lives in the pure markdown/table-layout.mjs module so the
  // renderer and the App.jsx row-height estimator share one source of truth and
  // can never drift. The component just draws the lines it returns verbatim.
  const { lines } = buildTableRender(token, terminalWidth);
  return <Text>{lines.join('\n')}</Text>;
}
