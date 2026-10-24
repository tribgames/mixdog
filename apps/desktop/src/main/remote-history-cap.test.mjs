import assert from 'node:assert/strict';
import test from 'node:test';

import { REMOTE_HISTORY_OUTPUT_CHARS, remoteTranscriptSnapshot } from './remote-transcript.ts';
import { encodePhoneSessionState, requestPhoneTranscriptPage } from './remote-transcript-window.ts';
import { createSnapshotDeltaDecoder, createSnapshotDeltaEncoder } from './state-delta.ts';

const { desktopToolActivityItemPresentation } = await import('../renderer/transcript-tool-model.ts');
const { desktopToolActivitySummary } = await import('../renderer/transcript-tool-core.ts');
const { initUiLanguage } = await import('../renderer/i18n.ts');

// Everything a row presents but the output text itself (its cut copy shows the
// cut text there, by design), and the group summary above it.
const BODY = new Set([
  'outputText',
  'outputNotice',
  'sections',
  'entries',
  'entryNotes',
  'sectionCopyText',
  'diffPatch',
]);
const header = (item) => {
  const presentation = desktopToolActivityItemPresentation(item, 1e13);
  return {
    ...Object.fromEntries(Object.entries(presentation).filter(([key]) => !BODY.has(key))),
    summary: desktopToolActivitySummary([item], true),
  };
};

const numbered = (count) =>
  Array.from({ length: count }, (_, n) => `${n + 1}\tconst value${n} = load({ name: "item-${n}", index: ${n} });`).join(
    '\n'
  );
const matches = (count) =>
  Array.from(
    { length: count },
    (_, n) => `src/file-${n % 7}.ts:${n + 3}:  const match${n} = find("pattern", ${n});`
  ).join('\n');
const paths = (count) => Array.from({ length: count }, (_, n) => `src/dir-${n % 5}/file-${n}.ts`).join('\n');
const log = (count) =>
  Array.from({ length: count }, (_, n) => `step ${n}: compiled module-${n} in ${n * 3}ms`).join('\n');
const tool = (id, name, args, result, extra = {}) => ({
  id,
  kind: 'tool',
  name,
  args,
  result,
  rawResult: result,
  completedAt: 1,
  ...extra,
});

const ROWS = [
  tool('read-120', 'read', { path: 'src/app.ts' }, numbered(120)),
  tool('grep-90', 'grep', { pattern: 'match', path: 'src' }, matches(90)),
  tool('glob-60', 'glob', { pattern: '**/*.ts' }, paths(60)),
  tool('list-25', 'list', { path: 'src' }, paths(25)),
  tool('shell-ok', 'shell', { command: 'npm run build' }, log(120)),
  tool('shell-fail', 'shell', { command: 'npm test' }, `[exit code: 2]\n\n${log(80)}\nError: 3 tests failed`, {
    isError: true,
    exitErrorCount: 1,
  }),
  tool('edit-1', 'edit', { path: 'src/a.ts', old_string: 'a', new_string: 'b' }, `Edited src/a.ts\n${log(40)}`),
  tool(
    'shell-bg',
    'shell',
    { command: 'npm run dev', background: true },
    `background task\ntask_id: job_1790959235138_971b88\nstatus: completed\nexit_code: 2\n\n${log(60)}`
  ),
  tool(
    'notice',
    'shell',
    { type: 'result', task_id: 'job_1791730080304_f2e11f' },
    'Retrieve output with task read (task_id: job_1791730080304_f2e11f) only if it has not already been received.',
    {
      rawResult: `<task-notification>\n<task-id>job_1791730080304_f2e11f</task-id>\n<status>completed</status>\n<exit-code>0</exit-code>\n<summary>Shell task completed (exit 0): ping</summary>\n</task-notification>`,
    }
  ),
  // Labels with two counts, grouped matches, a file list, several files read.
  tool(
    'grep-count',
    'grep',
    { pattern: 'x', output_mode: 'count' },
    Array.from({ length: 10 }, (_, n) => `src/f${n}.ts:9`).join('\n')
  ),
  tool(
    'grep-grouped',
    'grep',
    { pattern: 'hit', path: 'src', output_mode: 'content' },
    Array.from({ length: 4 }, (_, f) =>
      [`# src/g${f}.ts`, ...Array.from({ length: 13 }, (_, n) => `${n + 1}: hit ${n}`)].join('\n')
    ).join('\n\n')
  ),
  tool('grep-files', 'grep', { pattern: 'x', output_mode: 'files_with_matches' }, paths(40)),
  tool(
    'read-multi',
    'read',
    { reads: [{ path: 'a.ts' }, { path: 'b.ts' }] },
    `# a.ts\n${numbered(40)}\n\n# b.ts\n${numbered(33)}`
  ),
];
// Newer rows a phone opened on: its tail. Which rows are history is the
// phone window's to say (remote-transcript-window.ts), not a row count.
const TAIL = Array.from({ length: 20 }, (_, n) => ({ id: `u${n}`, kind: 'user', text: `prompt ${n}` }));
const asHistory = (rows) => remoteTranscriptSnapshot({ items: [...rows, ...TAIL] }, process.cwd(), rows.length).items;

test('an older row is cut to its first lines and keeps the header the whole output gives it', () => {
  const items = asHistory(ROWS);
  for (const [index, row] of ROWS.entries()) {
    const sent = items[index];
    assert.deepEqual(header(sent), header(row), `${row.id}: the collapsed header reads the same`);
    if (row.id === 'shell-bg' || row.id === 'notice') {
      assert.equal(sent.result, row.result, `${row.id}: a status envelope or short notice stays whole`);
      continue;
    }
    assert.equal(sent.rawResult, undefined, `${row.id}: a verbatim rawResult copy is not sent`);
    assert.ok(
      sent.result.length <= REMOTE_HISTORY_OUTPUT_CHARS,
      `${row.id}: at most ${REMOTE_HISTORY_OUTPUT_CHARS} characters`
    );
    assert.ok(row.result.startsWith(sent.result), `${row.id}: the head of the output, unchanged`);
    assert.equal(sent.remoteOutputTruncated, row.result.length, `${row.id}: the row says its output was cut`);
    assert.deepEqual(sent.remoteOutputNotes.result, {
      kind: 'omitted',
      at: sent.result.length,
      omitted: row.result.length - sent.result.length,
    });
  }
  assert.equal(items[0].result.split('\n').length, 5, 'a read keeps five lines');
  assert.equal(header(items[0]).resultLabel, '120 lines');
  assert.equal(header(items[9]).resultLabel, '90 matches in 10 files', 'each count of a two-count label stays its own');
  assert.equal(header(items[12]).resultLabel, '76 lines', 'a multi-file read counts every file');
  assert.equal(items[8].rawResult, ROWS[8].rawResult, 'a rawResult that differs from result stays');
  // The whole output's facts ride along only where the cut text reads otherwise; plain data, no words.
  assert.deepEqual(items[0].remoteOutputFacts.summaryDisplay, {
    text: '\uE0000\uE001',
    parts: [['{{count}} lines', '120 lines', { count: 120 }]],
  });
  assert.equal(items[4].remoteOutputFacts, undefined, 'a log whose header is on its first lines carries none');
});

const plus = (count) => Array.from({ length: count }, (_, n) => `+export const v${n} = ${n}; // pppppppp`).join('\n');
// Long rows whose header reads past their first lines (the review's repros among them).
const LATE = [
  tool(
    'stdout-then-error',
    'shell',
    { command: 'npm run serve' },
    `[stdout]\n\n\n\n\n\n\n[stderr]\nError: connection refused\n${log(40)}\n[exit code: 1]`,
    { isError: true, exitErrorCount: 1 }
  ),
  tool(
    'running-then-completed',
    'shell',
    { command: 'npm run e2e' },
    `${log(30)}\n[status: running]\n${log(20)}\n[status: completed]`
  ),
  tool('stopped', 'shell', { command: 'sleep 100' }, `${log(30)}\n[status: cancelled]`),
  tool('long-failed-log', 'shell', { command: 'npm test' }, `${log(400)}\nError: expected 1 to be 2\n[exit code: 1]`, {
    isError: true,
    exitErrorCount: 1,
  }),
  tool(
    'patch-1000',
    'apply_patch',
    { patch: '*** Begin Patch\n*** Add File: src/big.ts\n+x\n*** End Patch' },
    plus(1000)
  ),
  tool(
    'patch-20kb',
    'apply_patch',
    { patch: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n+x\n*** End Patch' },
    `${plus(420)}\n-gone`
  ),
  tool(
    'git-diff',
    'git',
    { command: 'git diff' },
    `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,30 +1,30 @@\n${Array.from({ length: 30 }, (_, n) => `-old ${n}\n+new ${n}`).join('\n')}`
  ),
  tool('shell-exit2', 'shell', { command: 'npm test' }, `${log(60)}\n[exit code: 2]`),
  tool('shell-exit2-failed', 'shell', { command: 'npm test' }, `${log(60)}\n[exit code: 2]`, { isError: true }),
  tool('shell-exit0', 'shell', { command: 'npm run build' }, `${log(60)}\n[exit code: 0]`),
  tool('shell-status', 'shell', { command: 'npm run e2e' }, `${log(60)}\n[status: failed]\n[exit code: 3]`),
  tool('shell-fail-80', 'shell', { command: 'npm test' }, `${log(80)}\nError: 3 tests failed\n[exit code: 1]`, {
    isError: true,
  }),
  tool('shell-exit1-raw', 'shell', { command: 'make' }, log(60), {
    rawResult: `${log(60)}\n[exit code: 1]\n`,
    isError: true,
  }),
  tool(
    'patch-15',
    'apply_patch',
    {
      patch: `*** Begin Patch\n${Array.from({ length: 15 }, (_, n) => `*** Add File: src/n${n}.ts\n+export const n${n} = ${n};`).join('\n')}\n*** End Patch`,
    },
    `apply_patch: applied 15 section(s)\n${Array.from({ length: 15 }, (_, n) => `OK Add src/n${n}.ts — +1 -0`).join('\n')}`
  ),
  tool(
    'patch-18',
    'apply_patch',
    {
      patch: `*** Begin Patch\n*** Update File: src/a.ts\n@@\n${Array.from({ length: 18 }, (_, n) => `+line ${n}`).join('\n')}\n-old\n*** End Patch`,
    },
    `apply_patch: applied 1 section(s)\nOK Modify src/a.ts — +18 -1\n${log(30)}`
  ),
  tool(
    'edit-17',
    'edit',
    { path: 'src/a.ts', old_string: 'a\nb', new_string: 'c\nd' },
    `Edited: src/a.ts (+17 -16)\n${log(40)}`
  ),
  tool(
    'write-300',
    'write',
    { path: 'src/big.ts', content: numbered(300) },
    `Wrote: src/big.ts (+300)\n${numbered(40)}`
  ),
  tool(
    'background-90',
    'shell',
    { command: 'npm run e2e', background: true },
    `background task\ntask_id: job_1790959235138_971b88\nstatus: completed\nexit_code: 1\n\n${log(90)}`
  ),
];

test('a cut row is its plain head plus the whole output facts, and its header reads as the whole one', () => {
  const items = asHistory(LATE);
  const sent = Object.fromEntries(LATE.map((row, index) => [row.id, items[index]]));
  for (const [index, row] of LATE.entries()) {
    assert.deepEqual(header(items[index]), header(row), `${row.id}: the row reads the same but for its text`);
    if (row.id === 'background-90') continue;
    const whole = typeof row.result === 'string' ? row.result : '';
    const lines = /^(?:shell)$/.test(row.name) ? 6 : 5;
    const head = whole.split('\n').slice(0, lines).join('\n').slice(0, REMOTE_HISTORY_OUTPUT_CHARS);
    assert.equal(items[index].result, head, `${row.id}: the plain head, nothing appended`);
    assert.ok(items[index].remoteOutputTruncated > 0, `${row.id}: cut`);
  }
  const label = (id) => header(sent[id]).resultLabel;
  assert.equal(label('stdout-then-error'), 'Failed · Error: connection refused');
  assert.equal(header(sent['stdout-then-error']).outcomeReason, 'Error: connection refused');
  assert.equal(label('running-then-completed'), 'Running');
  assert.equal(label('stopped'), 'Stopped');
  assert.equal(label('long-failed-log'), 'Failed · step 0: compiled module-0 in 0ms');
  assert.equal(label('patch-1000'), '+1000 -0');
  assert.equal(label('patch-20kb'), '+420 -1');
  assert.deepEqual(header(sent['git-diff']).diffCounts, { additions: 30, deletions: 30 });
  assert.equal(label('shell-exit2'), 'Exit 2');
  assert.equal(label('patch-15'), '+15 lines');
  assert.equal(sent['patch-15'].result.split('\n').length, 5, 'a patch summary is cut like any output');
  assert.equal(sent['background-90'].result, LATE.at(-1).result, 'a background envelope stays whole');
  // Facts are the same plain data whoever reads them: they survive the wire as they are.
  for (const item of items) {
    if (item.remoteOutputFacts)
      assert.deepEqual(JSON.parse(JSON.stringify(item.remoteOutputFacts)), item.remoteOutputFacts);
  }
  // Opening a row reads the whole text; the merged row drops the facts (tool-full-output.tsx).
  const { remoteOutputFacts: _facts, ...merged } = { ...sent['patch-1000'], result: LATE[4].result };
  assert.equal(header(merged).resultLabel, '+1000 -0');
});

test('a command row keeps the six lines its inline preview reads', () => {
  const items = asHistory(ROWS);
  for (const index of [4, 5]) {
    const kept = ROWS[index].result.split('\n').slice(0, 6).join('\n');
    assert.equal(items[index].result, kept);
  }
});

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

test('projection, wire and presentation:a cut row reads as the whole one in English and Korean', async () => {
  const questions = [
    { id: 'a', question: 'Q1' },
    { id: 'b', question: 'Q2' },
  ];
  const answer = `User has answered your questions: "Q1"="${'z'.repeat(9_000)}"; "Q2"="b".`;
  // The review's repros: a one-line read in history (cut at 600 characters)
  // and a structured answer over the tail cap (cut in the middle).
  const read = tool('read-1', 'read', { path: 'a.ts' }, `1\t${'x'.repeat(1_500)}`);
  const asked = tool('ask', 'request_user_input', { questions }, answer);
  const host = { items: [read, ...TAIL.slice(0, 7), asked] };
  const encoder = createSnapshotDeltaEncoder({ prepend: true });
  const decoder = createSnapshotDeltaDecoder();
  const deliver = (snapshot) => {
    const decoded = decoder.decode(JSON.parse(JSON.stringify(encodePhoneSessionState(encoder, snapshot, process.cwd(), true))));
    assert.equal(decoded.ok, true);
    return decoded.snapshot;
  };
  // The phone opens on the newest eight rows, then pages the read in as history.
  const opened = deliver({ ...host, items: host.items.slice(1), transcriptHasOlder: true });
  assert.equal(opened.items.length, 8);
  requestPhoneTranscriptPage(encoder, 8 + 64);
  const shown = deliver({ ...host, transcriptHasOlder: false }).items;
  const sentRead = shown[0];
  const sentAsk = shown.at(-1);
  assert.ok(sentRead.result.length <= REMOTE_HISTORY_OUTPUT_CHARS, 'the read came as history');
  assert.ok(sentAsk.remoteOutputTruncated > 0, 'the answer is cut');
  for (const language of ['en', 'ko']) {
    await inLanguage(language, () => {
      for (const [whole, sent] of [
        [read, sentRead],
        [asked, sentAsk],
      ]) {
        // An answer's own text is body (the cut copy shows its cut text); its status is header.
        const closed = (row) => {
          const value = header(row);
          return { ...value, structuredRows: value.structuredRows.map(({ answer: _answer, ...rest }) => rest) };
        };
        assert.deepEqual(closed(sent), closed(whole), `${whole.id} (${language}): the header reads as the whole one`);
      }
      const notice = desktopToolActivityItemPresentation(sentRead, 1e13).outputNotice;
      assert.match(notice, language === 'ko' ? /자/u : /characters omitted/u, 'the note is its own line');
      assert.ok(!desktopToolActivityItemPresentation(sentRead, 1e13).outputText.includes(notice));
    });
  }
  assert.equal(header(sentRead).resultLabel, '1 line');
  await inLanguage('ko', () => assert.equal(header(sentRead).resultLabel, '1줄'));
  assert.equal(header(sentAsk).resultLabel, '2/2');
  assert.deepEqual(
    header(sentAsk).structuredRows.map((row) => row.status),
    ['completed', 'completed']
  );
});

test('tail rows and the desktop copy are untouched', () => {
  const tailRows = ROWS.map((row) => ({ ...row, id: `${row.id}-tail` }));
  const snapshot = { items: [...TAIL.slice(0, 11), ...tailRows] };
  const before = JSON.stringify(snapshot);
  const items = remoteTranscriptSnapshot(snapshot, process.cwd()).items;
  for (const [n, row] of tailRows.entries()) {
    const sent = items[11 + n];
    assert.equal(sent.result, row.result, `${row.id}: a tail row keeps its whole output`);
    assert.equal(sent.rawResult, row.rawResult);
    assert.equal(sent.remoteOutputTruncated, undefined);
    assert.equal(sent.remoteOutputFacts, undefined);
  }
  assert.equal(JSON.stringify(snapshot), before, 'the desktop snapshot itself is never changed');
});
