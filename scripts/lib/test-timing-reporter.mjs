// Secondary node:test reporter: per-file wall time, slowest files first.
// Runs beside the spec reporter (scripts/test.mjs) so a slow default lane
// always names its cause instead of hiding it inside one total. A file over
// SLOW_HINT_MS belongs in the slow lane (rename to *.slow.test.mjs).
import { relative } from 'node:path';

const SLOW_HINT_MS = 10_000;
const TOP = 8;

// Each test file runs in its own process; its top-level tests arrive as
// nesting-0 events tagged with the file, so a file's time is the sum of its
// top-level test durations (module load excluded).
export default async function* timingReporter(source) {
  const byFile = new Map();
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    if (event.data.nesting !== 0 || !event.data.file) continue;
    const file = relative(process.cwd(), String(event.data.file)).replaceAll('\\', '/');
    const entry = byFile.get(file) ?? { file, ms: 0, failed: false };
    entry.ms += Number(event.data.details?.duration_ms) || 0;
    entry.failed ||= event.type === 'test:fail';
    byFile.set(file, entry);
  }
  const files = [...byFile.values()];
  if (files.length === 0) return;
  files.sort((a, b) => b.ms - a.ms);
  const total = files.reduce((sum, entry) => sum + entry.ms, 0);
  const lines = [
    '',
    `slowest files (${files.length} files, ${(total / 1000).toFixed(1)}s file-time):`,
    ...files.slice(0, TOP).map((entry) => `  ${String(Math.round(entry.ms)).padStart(7)}ms  ${entry.file}${entry.failed ? '  (failed)' : ''}`),
  ];
  const slow = files.filter((entry) => entry.ms >= SLOW_HINT_MS && !/\.(?:slow|live)\.test\.mjs$/.test(entry.file));
  if (slow.length) {
    lines.push(`  ${slow.length} file(s) over ${SLOW_HINT_MS / 1000}s in the default lane; rename to *.slow.test.mjs to move them out.`);
  }
  yield `${lines.join('\n')}\n`;
}
