/**
 * components/MarkdownTable.jsx — GFM table → ink <Text> lines.
 *
 * The width-fitting algorithm (ideal vs min widths, proportional shrink, hard
 * wrap, vertical fallback for narrow terminals) lives in
 * markdown/table-layout.mjs; <Text> passes its ANSI escapes through.
 */
import { Text, useStdout } from 'ink';
import { buildTableRender } from '../markdown/table-layout.mjs';

export function MarkdownTable({ token, forceWidth }) {
  // App owns resize reflow and there is no <Static> transcript anymore, so table
  // width can follow the current terminal width without duplicating scrollback.
  const actualTerminalWidth = useStdout()?.stdout?.columns ?? 80;
  const terminalWidth = forceWidth ?? actualTerminalWidth;

  // The entire layout (column fit, vertical fallback, bordered box, overflow
  // re-fallback) lives in the pure markdown/table-layout.mjs module so the
  // renderer and the row-height estimator (measure-rendered-rows.mjs) share one source of truth and
  // can never drift. The component just draws the lines it returns verbatim.
  const { lines } = buildTableRender(token, terminalWidth);
  return <Text>{lines.join('\n')}</Text>;
}
