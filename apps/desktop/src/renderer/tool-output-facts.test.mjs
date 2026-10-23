import assert from 'node:assert/strict';
import test from 'node:test';

const { desktopToolActivityItemPresentation, outputFactsOf, toolOutputFacts } = await import(
  './transcript-tool-model.ts'
);
const { initUiLanguage } = await import('./i18n.ts');

const log = (count) =>
  Array.from({ length: count }, (_, n) => `step ${n}: compiled module-${n} in ${n * 3}ms`).join('\n');
const numbered = (count) => Array.from({ length: count }, (_, n) => `${n + 1}\tconst v${n} = ${n};`).join('\n');
const tool = (id, name, args, result, extra = {}) => ({
  id,
  kind: 'tool',
  name,
  args,
  result,
  rawResult: result,
  startedAt: 1_000,
  completedAt: 13_000,
  ...extra,
});
const ROWS = [
  tool('read', 'read', { path: 'a.ts' }, numbered(120)),
  tool(
    'grep',
    'grep',
    { pattern: 'x', output_mode: 'count' },
    Array.from({ length: 10 }, (_, n) => `f${n}.ts:9`).join('\n')
  ),
  tool('exit', 'shell', { command: 'npm test' }, `${log(60)}\n[exit code: 2]`),
  tool('failed', 'shell', { command: 'npm test' }, `[stdout]\n\n[stderr]\nError: connection refused\n[exit code: 1]`, {
    isError: true,
    exitErrorCount: 1,
  }),
  tool('stopped', 'shell', { command: 'sleep 9' }, `${log(3)}\n[status: cancelled]`),
  tool('patch', 'apply_patch', { patch: '*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch' }, '+a\n+b\n-c'),
];

async function inLanguage(language, run) {
  process.env.MIXDOG_UI_LANGUAGE = language;
  await initUiLanguage();
  try {
    return await run();
  } finally {
    process.env.MIXDOG_UI_LANGUAGE = 'en';
    await initUiLanguage();
  }
}

test('output facts are plain data, the same in every language', async () => {
  const english = ROWS.map((row) => outputFactsOf(row));
  const korean = await inLanguage('ko', () => {
    assert.equal(desktopToolActivityItemPresentation(ROWS[0], 1e13).resultLabel, '120줄', 'the language did switch');
    return ROWS.map((row) => outputFactsOf(row));
  });
  assert.deepEqual(korean, english);
  for (const facts of english) assert.deepEqual(JSON.parse(JSON.stringify(facts)), facts);
  assert.deepEqual(english[0].summaryDisplay, {
    text: '\uE0000\uE001',
    parts: [['{{count}} lines', '120 lines', { count: 120 }]],
  });
  assert.deepEqual(english[2].shellFailure, { exit: '2', reason: 'step 0: compiled module-0 in 0ms' });
  assert.deepEqual(english[3].shellFailure, { exit: '1', reason: 'Error: connection refused' });
  assert.equal(english[4].resultStatus, 'cancelled');
});

test('a row reads its own facts, and a cut copy the whole output ones it carries', async () => {
  for (const row of ROWS) {
    const own = desktopToolActivityItemPresentation(row, 1e13);
    const carried = desktopToolActivityItemPresentation({ ...row, remoteOutputFacts: outputFactsOf(row) }, 1e13);
    assert.deepEqual(carried, own, `${row.id}: one path, own facts or carried`);
  }
  const whole = ROWS[0];
  const cut = { ...whole, result: numbered(5), rawResult: undefined, remoteOutputTruncated: 1 };
  assert.equal(desktopToolActivityItemPresentation(cut, 1e13).resultLabel, '5 lines');
  const withFacts = {
    ...cut,
    remoteOutputFacts: { summary: '120 lines', summaryDisplay: outputFactsOf(whole).summaryDisplay },
  };
  assert.equal(toolOutputFacts(withFacts).summary, '120 lines');
  assert.equal(desktopToolActivityItemPresentation(withFacts, 1e13).resultLabel, '120 lines');
  await inLanguage('ko', () => {
    assert.equal(
      desktopToolActivityItemPresentation({ ...withFacts }, 1e13).resultLabel,
      '120줄',
      'translated where shown'
    );
  });
});
