import { Readable } from 'node:stream';
import { spec } from 'node:test/reporters';
import timingReporter from './test-timing-reporter.mjs';

// Filter structured success events, never arbitrary stdout/stderr text.
// Node's own reporter still owns failure diagnostics, warnings and totals.
// The runner writes an unfiltered spec report alongside this summary.
export default async function* summaryReporter(source) {
  const timings = [];
  async function* events() {
    for await (const event of source) {
      if ((event.type === 'test:pass' || event.type === 'test:fail') && event.data.nesting === 0) {
        timings.push({
          type: event.type,
          data: { nesting: 0, file: event.data.file, details: { duration_ms: event.data.details?.duration_ms } },
        });
      }
      // A start without its matching pass leaves a pending name in spec's
      // parent stack. Suppress both; fail events carry their own location.
      if (event.type !== 'test:start' &&
          (event.type !== 'test:pass' || event.data.skip || event.data.todo)) yield event;
    }
  }
  yield* Readable.from(events()).pipe(new spec());
  yield* timingReporter(timings);
}
