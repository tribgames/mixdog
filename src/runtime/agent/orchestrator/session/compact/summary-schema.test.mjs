import assert from 'node:assert/strict';
import test from 'node:test';
import { repairCompactSummary, summaryIsSchemaValid } from './summary-schema.mjs';

test('relevant-file backfill deduplicates case, continues across messages, and stops at eight files', () => {
  const head = [
    { role: 'assistant', content: 'src/one.mjs SRC/ONE.MJS src/two.ts' },
    { role: 'assistant', content: 'no file references here' },
    { role: 'assistant', content: 'three.py four.rs five.go six.md seven.json eight.css nine.html' },
    { role: 'assistant', content: 'ten.java' },
  ];
  const summary = repairCompactSummary('Keep this context.', { head });
  assert.equal(summaryIsSchemaValid(summary), true);
  assert.equal(
    summary.slice(summary.indexOf('## Relevant Files')),
    '## Relevant Files\n- src/one.mjs\n- src/two.ts\n- three.py\n- four.rs\n- five.go\n- six.md\n- seven.json\n- eight.css'
  );
  assert.match(summary, /## Critical Context\n- Keep this context\./);
});

test('relevant-file backfill handles absent matches without retaining regex state', () => {
  assert.match(repairCompactSummary('', { head: [{ content: 'no files' }] }), /## Relevant Files\n- \(none\)$/);
  assert.match(
    repairCompactSummary('', { head: [{ content: 'first.mjs' }, { content: 'second.ts' }] }),
    /## Relevant Files\n- first\.mjs\n- second\.ts$/
  );
});
