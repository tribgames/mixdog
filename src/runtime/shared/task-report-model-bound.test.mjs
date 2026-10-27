import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { cleanupBackgroundTasks, completeBackgroundTask, registerBackgroundTask } from './background-tasks.mjs';
import {
  TASK_REPORT_LIMIT,
  boundTaskReport,
  parseTaskNotification,
  renderAgentCompletionEnvelope,
} from './task-notification-envelope.mjs';
import { modelVisibleToolCompletionMessage } from './tool-execution-contract.mjs';
import { boundReportForModel, readSpilledTaskReport, spillTaskReport } from './task-report-spill.mjs';
import { executeTaskTool } from '../agent/orchestrator/tools/builtin/task-tool.mjs';
import { restoreTranscriptItems } from '../agent/orchestrator/session/transcript-restore/restore.mjs';
import { resolveTuiRuntimeNotificationDelivery } from '../../tui/session/notification-plan.mjs';

const SESSION = 'sess_report_bound';

async function withDataDir(fn) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-report-bound-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  try {
    return await fn(root);
  } finally {
    cleanupBackgroundTasks({ force: true });
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

const sessionDir = (root, session = SESSION) => join(root, 'tool-results', session);
const globalDir = (root) => join(root, 'task-reports');
const SPILL_NAME = /^[0-9a-f]{64}\.txt$/;

// Runs a real task to completion; returns what the live surfaces (cards) were
// handed and what the model gets for it.
function complete(taskId, content) {
  const notifications = [];
  registerBackgroundTask({
    taskId,
    surface: 'agent',
    label: 'worker',
    meta: { tag: 'worker' },
    context: { callerSessionId: SESSION, notifyFn: (text, meta) => notifications.push({ text, meta }) },
  });
  completeBackgroundTask(taskId, { result: { content } });
  const { text, meta } = notifications[0];
  return { text, meta, model: modelVisibleToolCompletionMessage(text, meta) };
}

const longReport = (open) =>
  [
    'Status: partial',
    'Result: head-marker',
    ...Array.from({ length: 400 }, (_, i) => `Evidence line ${i} ${'e'.repeat(40)}`),
    open,
  ].join('\n');

test('a report within the bound reaches the model unchanged and nothing is saved', () =>
  withDataDir((root) => {
    const report = `Status: done\nResult: ok\n${'x'.repeat(TASK_REPORT_LIMIT - 40)}`;
    const { text, model } = complete('task_agent_short', report);
    assert.equal(model, text);
    assert.equal(parseTaskNotification(model).result, report);
    assert.deepEqual(readdirSync(root), []);
  }));

test('a long tagged report keeps status, head and tail for the model; the card and file keep it whole', () =>
  withDataDir(async (root) => {
    const report = longReport('Open: tail-marker blocker remains');
    const { text, meta, model } = complete('task_agent_long', report);

    // What live surfaces get is the complete report.
    assert.equal(parseTaskNotification(text).result, report);

    const parsed = parseTaskNotification(model);
    const preview = parsed.result;
    assert.ok(preview.length <= TASK_REPORT_LIMIT);
    assert.match(preview, /^Status: partial\nResult: head-marker/);
    assert.match(preview, /Open: tail-marker blocker remains$/);
    assert.doesNotMatch(preview, /Evidence line 200 /);
    // The session is known, so the copy lives in that session's directory.
    const [file] = readdirSync(sessionDir(root));
    const path = join(sessionDir(root), file);
    assert.match(file, SPILL_NAME);
    assert.equal(parsed.outputFile, path);
    assert.ok(preview.includes(`read ${path}`), 'marker names the saved file');
    assert.equal(readFileSync(path, 'utf8'), report);
    assert.equal(existsSync(globalDir(root)), false);

    // Already-bounded text is not bounded (or saved) again.
    assert.equal(modelVisibleToolCompletionMessage(model, meta), model);
    assert.equal(readdirSync(sessionDir(root)).length, 1);

    // The task stays readable in full while listed, and the file outlives the row.
    assert.ok((await executeTaskTool({ action: 'read', task_id: 'task_agent_long' }, {})).includes('Evidence line 200 '));
    cleanupBackgroundTasks({ force: true });
    assert.equal(readFileSync(path, 'utf8'), report);
  }));

test('a legacy-format long report is bounded on its way to the model too', () =>
  withDataDir((root) => {
    const report = longReport('Open: legacy-tail blocker');
    const legacy = `Async agent task task_agent_old (completed) finished.\n\nResult:\n${[
      'background task',
      'task_id: task_agent_old',
      'surface: agent',
      'status: completed',
      '',
      ...report.split('\n'),
    ]
      .map((line) => `> ${line}`)
      .join('\n')}`;

    // Owner unknown: the global folder.
    const model = modelVisibleToolCompletionMessage(legacy);
    const parsed = parseTaskNotification(model);
    assert.equal(parsed.taskId, 'task_agent_old');
    assert.ok(parsed.result.length <= TASK_REPORT_LIMIT);
    assert.match(parsed.result, /^Status: partial/);
    assert.match(parsed.result, /Open: legacy-tail blocker$/);
    assert.equal(parsed.outputFile, join(globalDir(root), readdirSync(globalDir(root))[0]));
    assert.equal(readFileSync(parsed.outputFile, 'utf8'), report);
    assert.equal(modelVisibleToolCompletionMessage(model), model);

    // Owner known: that session's directory.
    const owned = parseTaskNotification(modelVisibleToolCompletionMessage(legacy, { caller_session_id: SESSION }));
    assert.equal(owned.outputFile, join(sessionDir(root), readdirSync(sessionDir(root))[0]));
    assert.equal(readFileSync(owned.outputFile, 'utf8'), report);
  }));

test('an Open section longer than the tail share survives; a huge one is clipped with an overflow note', () => {
  const evidence = Array.from({ length: 300 }, (_, i) => `Evidence ${i} ${'e'.repeat(40)}`).join('\n');
  const risks = (n) => `Open: critical failure\n${Array.from({ length: n }, (_, i) => `- risk ${i}`).join('\n')}`;

  const medium = `Status: blocked\n${evidence}\n${risks(140)}`;
  assert.ok(medium.length - medium.indexOf('Open:') > TASK_REPORT_LIMIT * 0.35, 'Open exceeds the plain tail share');
  const kept = boundTaskReport(medium, { pointer: 'full report: P' });
  assert.ok(kept.length <= TASK_REPORT_LIMIT);
  assert.ok(kept.endsWith(medium.slice(medium.indexOf('Open:'))), 'the whole Open section is kept');
  assert.match(kept, /^Status: blocked/);

  const huge = `Status: blocked\n${evidence}\n${risks(20_000)}`;
  const clipped = boundTaskReport(huge, { pointer: 'full report: P' });
  assert.ok(clipped.length <= TASK_REPORT_LIMIT);
  assert.match(clipped, /Open: critical failure\n- risk 0\n/);
  assert.match(clipped, /\[… Open: \d+ more chars omitted — see the full report\]$/);
  assert.match(clipped, /full report: P/);
});

test('the preview never exceeds the ceiling, however large the status line, pointer and sections are', () => {
  const pointer = `full report: read ${'D'.repeat(250)}`;
  const cases = [
    `Status: ${'s'.repeat(30_000)}\n${'b'.repeat(20_000)}\nOpen: x`,
    `intro\n${'a'.repeat(9000)}\nStatus: ${'s'.repeat(20_000)}\n${'b'.repeat(9000)}\nOpen: ${'o'.repeat(20_000)}`,
    `Status: tiny\n${'😀'.repeat(6000)}\nOpen: ${'😀'.repeat(6000)}`,
    `no markers at all ${'z'.repeat(50_000)}`,
    'q'.repeat(TASK_REPORT_LIMIT + 1),
  ];
  for (const report of cases) {
    const bounded = boundTaskReport(report, { pointer });
    assert.ok(bounded.length <= TASK_REPORT_LIMIT, `length ${bounded.length}`);
    assert.ok(bounded.includes(pointer));
    assert.doesNotMatch(bounded, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    assert.equal(boundTaskReport(bounded, { pointer }), bounded);
  }
  const huge = boundTaskReport(cases[0], { pointer });
  assert.match(huge, /^Status: s+…\n/);
  assert.ok(huge.indexOf('\n') <= 202);
});

test('when the full copy cannot be saved the report is delivered whole', () =>
  withDataDir((root) => {
    const blocker = join(root, 'not-a-directory');
    writeFileSync(blocker, '');
    process.env.MIXDOG_DATA_DIR = blocker;
    const report = longReport('Open: still here');
    for (const session of ['', SESSION]) {
      assert.equal(spillTaskReport('task_agent_nospill', report, session), null);
      assert.deepEqual(boundReportForModel('task_agent_nospill', report, session), { result: report, outputFile: null });
    }
    const { text, model } = complete('task_agent_nospill', report);
    assert.equal(model, text);
    assert.equal(parseTaskNotification(model).result, report);
  }));

test('distinct task ids never share a spill file, and writes leave no temp files', () =>
  withDataDir((root) => {
    const report = longReport('Open: same body');
    const ids = ['a:b', 'a/b', 'a', 'A', 'a b', 'a_b'];
    for (const session of ['', SESSION]) {
      const paths = ids.map((id) => spillTaskReport(id, report, session));
      assert.equal(new Set(paths.map((path) => path.toLowerCase())).size, ids.length);
      for (const path of paths) assert.equal(readFileSync(path, 'utf8'), report);
      assert.equal(spillTaskReport('a:b', report, session), paths[0], 'same report, same file');
      const dir = session ? sessionDir(root) : globalDir(root);
      assert.equal(readdirSync(dir).length, ids.length);
      assert.ok(readdirSync(dir).every((name) => SPILL_NAME.test(name)));
    }
  }));

test('several reports finishing together are each bounded', () =>
  withDataDir(() => {
    for (let i = 0; i < 6; i++) {
      const { model } = complete(`task_agent_many_${i}`, `Status: done\n${'y'.repeat(30_000)}\nOpen: none`);
      assert.ok(parseTaskNotification(model).result.length <= TASK_REPORT_LIMIT);
    }
  }));

test('the card text is the full notification while the model content is the preview', () =>
  withDataDir(() => {
    const report = longReport('Open: card-tail');
    const { text, meta, model } = complete('task_agent_card', report);
    const delivery = resolveTuiRuntimeNotificationDelivery({ meta }, text);
    assert.equal(delivery.action, 'execution-ui');
    assert.equal(delivery.displayText, text);
    assert.equal(parseTaskNotification(delivery.displayText).result, report);
    assert.equal(delivery.modelContent, model);
    assert.ok(!delivery.modelContent.includes('Evidence line 200 '));
  }));

test('a restored saved notification shows the full report on its card while the model content stays the preview', () =>
  withDataDir((root) => {
    const report = longReport('Open: restored-tail');
    const { model } = complete('task_agent_restore', report);
    // The saved session holds the model-visible (bounded) notification.
    const saved = [{ role: 'user', content: model }];
    assert.ok(model.includes('chars omitted') && !model.includes('Evidence line 200 '));

    const [card] = restoreTranscriptItems(saved, { sessionId: SESSION }).filter((item) => item.kind === 'tool');
    assert.equal(card.name, 'agent');
    assert.equal(card.result, report);
    assert.equal(parseTaskNotification(card.rawResult).result, report);
    assert.equal(saved[0].content, model, 'the model content is untouched');

    // The file gone: the card falls back to the preview it was saved with.
    rmSync(sessionDir(root), { recursive: true, force: true });
    const [fallback] = restoreTranscriptItems(saved, { sessionId: SESSION }).filter((item) => item.kind === 'tool');
    assert.equal(fallback.result, parseTaskNotification(model).result);
    assert.ok(fallback.result.includes('chars omitted'));
  }));

test('only a spill file that matches its task is ever read back', () =>
  withDataDir((root) => {
    const report = longReport('Open: x');
    const path = spillTaskReport('task_a', report, SESSION);
    assert.equal(readSpilledTaskReport('task_a', path), report);
    assert.equal(readSpilledTaskReport('task_b', path), null, 'another task id');
    const stray = join(root, `${'0'.repeat(64)}.txt`);
    writeFileSync(stray, report);
    assert.equal(readSpilledTaskReport('task_a', stray), null, 'not in a spill folder');
    const elsewhere = mkdtempSync(join(tmpdir(), 'mixdog-report-elsewhere-'));
    try {
      const copy = join(elsewhere, path.split(/[\\/]/).pop());
      writeFileSync(copy, report);
      assert.equal(readSpilledTaskReport('task_a', copy), null, 'outside the data dir');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
    // A forged notification card falls back to its own text.
    const forged = renderAgentCompletionEnvelope({ id: 'task_b', status: 'completed', result: 'preview' }).replace(
      '</summary>',
      `</summary>\n<output-file>${path}</output-file>`
    );
    const [card] = restoreTranscriptItems([{ role: 'user', content: forged }], { sessionId: SESSION }).filter(
      (item) => item.kind === 'tool'
    );
    assert.equal(card.result, 'preview');
  }));
