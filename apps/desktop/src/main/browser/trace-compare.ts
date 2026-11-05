/**
 * Comparing the text of a performance trace result (`BrowserPerformanceTrace.summary`).
 *
 * Format, from performance.ts:
 *   Trace duration: <int>ms
 *   Events: <int>[; dropped after cap: <int>]
 *   Top trace events:
 *   - <name>: <int> event(s), <int>.<2 digits>ms total
 *
 * The duration and each entry's total are wall-clock numbers; `normalizeTraceDurations`
 * rewrites exactly those two number fields and nothing else, so counts, names
 * and structure still compare. Live traces of different runs never hold the
 * same events (Chromium's GC and sampling), so callers compare traces rendered
 * from one recorded event list.
 */

const DURATION_LINE = /^Trace duration: \d+ms$/;
const EVENTS_LINE = /^Events: \d+(; dropped after cap: \d+)?$/;
const HEADING_LINE = 'Top trace events:';
const ENTRY_LINE = /^- (.+): (\d+) event\(s\), \d+\.\d{2}ms total$/;
const TRACE_PREFIX = 'Performance trace stopped.\n';

/** The trace summary lines of a stop result, or throws when the text is not that format. */
function traceLines(text: string): string[] {
  if (!text.startsWith(TRACE_PREFIX)) throw new Error('not a performance trace result');
  const lines = text.slice(TRACE_PREFIX.length).split('\n');
  if (!DURATION_LINE.test(lines[0] ?? '') || !EVENTS_LINE.test(lines[1] ?? '')) {
    throw new Error(`unexpected trace header: ${JSON.stringify(lines.slice(0, 2))}`);
  }
  if (lines.length > 2) {
    if (lines[2] !== HEADING_LINE) throw new Error(`unexpected trace heading: ${JSON.stringify(lines[2])}`);
    for (const line of lines.slice(3)) {
      if (!ENTRY_LINE.test(line)) throw new Error(`unexpected trace entry: ${JSON.stringify(line)}`);
    }
  }
  return lines;
}

/** Only the wall-clock fields rewritten: the duration and each entry's total ms. */
export function normalizeTraceDurations(text: string): string {
  const lines = traceLines(text);
  return (
    TRACE_PREFIX +
    lines
      .map((line, index) =>
        index === 0 ? 'Trace duration: <N>ms' : line.replace(/, \d+\.\d{2}ms total$/, ', <N>ms total')
      )
      .join('\n')
  );
}

/** Whether two traces of the same events read the same: names, counts and structure included. */
export function traceTextsEqual(left: string, right: string): boolean {
  return normalizeTraceDurations(left) === normalizeTraceDurations(right);
}
