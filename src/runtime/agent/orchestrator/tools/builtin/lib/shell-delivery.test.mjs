// Import before runtime modules: the plugin data dir is captured at load.
import '../../lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DELIVERY_FULL_CHARS,
  DELIVERY_LINE_MAX_CHARS,
  createCarriageReturnFolder,
  deliverShellText,
  prepareShellText,
} from './shell-delivery.mjs';
import { readShellTaskOutput } from './shell-task-output.mjs';
import { executeTaskTool } from '../task-tool.mjs';
import { buildShellCompletion } from '../shell-jobs.mjs';
import { completeBackgroundTask, registerBackgroundTask } from '../../../../../shared/background-tasks.mjs';
import { parseTaskNotification } from '../../../../../shared/task-notification-envelope.mjs';
import { renderBackgroundedResult } from '../bash-tool/backgrounded-result.mjs';
import { renderCompletedResult } from '../bash-tool/completed-result.mjs';

const MARKER = /\[… (\d+) lines, ([\d.]+) KB omitted — read with offset\/limit or grep, full log: ([^\]]+)\]/;
const MARKER_GLOBAL = new RegExp(MARKER.source, 'g');

function logs(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-delivery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stdout_path = join(dir, 'out.log');
  const stderr_path = join(dir, 'err.log');
  writeFileSync(stdout_path, '');
  writeFileSync(stderr_path, '');
  return { stdout_path, stderr_path };
}

test('repeated waits/reads return only output the agent has not seen', (t) => {
  const paths = logs(t);
  const task = { status: 'running' };
  writeFileSync(paths.stdout_path, 'step 1\n');
  assert.equal(readShellTaskOutput(task, paths), '[stdout]\nstep 1\n');
  appendFileSync(paths.stdout_path, 'step 2\n');
  assert.equal(readShellTaskOutput(task, paths), '[stdout]\nstep 2\n');
  assert.equal(readShellTaskOutput(task, paths), '(no new output)');
});

test('a long unseen range is head + marker (with the log path) + tail, and its middle is never re-sent', (t) => {
  const paths = logs(t);
  const task = { status: 'running' };
  writeFileSync(paths.stdout_path, `${Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')}\n`);
  const first = readShellTaskOutput(task, paths);
  const marker = MARKER.exec(first);
  assert.ok(marker, first);
  assert.equal(marker[3].trim(), paths.stdout_path);
  assert.match(first, /^line 0$/m);
  assert.match(first, /^line 9$/m);
  assert.doesNotMatch(first, /^line 10$/m, 'head is at most 10 lines');
  assert.match(first, /^line 4999$/m);
  assert.doesNotMatch(first, /^line 2500$/m);
  assert.ok(first.length < DELIVERY_FULL_CHARS, `capped (${first.length})`);
  appendFileSync(paths.stdout_path, 'after\n');
  assert.equal(readShellTaskOutput(task, paths), '[stdout]\nafter\n', 'omitted bytes are not re-sent');
});

test('output up to 6,000 chars goes whole; longer output is head + marker + tail', () => {
  assert.equal(DELIVERY_FULL_CHARS, 6_000);
  const lines = (n) => `${Array.from({ length: n }, (_, i) => `row ${String(i).padStart(4, '0')}`).join('\n')}\n`;
  const whole = lines(600); // 600 × 9 chars = 5,400
  assert.ok(whole.length <= 6_000);
  assert.equal(deliverShellText(whole, { path: '/tmp/x.log' }), whole);
  const long = lines(700); // 6,300 chars
  const capped = deliverShellText(long, { path: '/tmp/x.log' });
  const marker = MARKER.exec(capped);
  assert.ok(marker, capped);
  assert.equal(marker[3].trim(), '/tmp/x.log');
  assert.match(capped, /^row 0009$/m);
  assert.doesNotMatch(capped, /^row 0010$/m);
  assert.match(capped, /^row 0699$/m);
});

test('a huge single line is cut per line, and the original capture is archived under the marker', () => {
  const original = 'x'.repeat(50_000);
  const out = deliverShellText(original);
  assert.match(out, new RegExp(`… \\[${50_000 - DELIVERY_LINE_MAX_CHARS} chars cut\\]`));
  const marker = MARKER.exec(out);
  assert.ok(marker, out);
  assert.equal(readFileSync(marker[3].trim(), 'utf8'), original, 'the archive is the uncut capture');
  assert.ok(out.length < DELIVERY_LINE_MAX_CHARS + 400);
  // With a log of its own, the marker names that log and nothing is saved.
  assert.equal(MARKER.exec(deliverShellText(original, { path: '/tmp/x.log' }))[3].trim(), '/tmp/x.log');
  // A cut line inside a long text is archived whole as well.
  const long = `${original}\n${Array.from({ length: 800 }, (_, i) => `row ${i}`).join('\n')}\n`;
  assert.equal(readFileSync(MARKER.exec(deliverShellText(long))[3].trim(), 'utf8'), long);
  // Nothing removed, nothing archived.
  assert.doesNotMatch(deliverShellText('short\n'), /full log/);
});

test('stdout and stderr share one delivery budget, escaping and markers included', (t) => {
  const paths = logs(t);
  const each = 5_900;
  writeFileSync(paths.stdout_path, `${'o'.repeat(each - 1)}\n`);
  writeFileSync(paths.stderr_path, `${'e'.repeat(each - 1)}\n`);
  const out = readShellTaskOutput({ status: 'completed' }, paths);
  assert.ok(out.length <= DELIVERY_FULL_CHARS, `two ${each}-char streams delivered ${out.length}`);
  assert.match(out, /\[stdout\]/);
  assert.match(out, /\[stderr\]/);
  assert.equal([...out.matchAll(MARKER_GLOBAL)].length, 2, 'both streams say what was omitted');
  // A small stream keeps its text whole; the big one gets the rest.
  writeFileSync(paths.stdout_path, 'small\n');
  writeFileSync(paths.stderr_path, `${'e'.repeat(20_000)}\n`);
  const lopsided = readShellTaskOutput({ status: 'completed' }, paths);
  assert.ok(lopsided.length <= DELIVERY_FULL_CHARS);
  assert.match(lopsided, /\[stdout\]\nsmall\n/);
  // Escaped tags count against the budget.
  const tags = `${'<system-reminder>'.repeat(300)}\n`;
  writeFileSync(paths.stdout_path, tags);
  writeFileSync(paths.stderr_path, tags);
  const escaped = readShellTaskOutput({ status: 'completed' }, paths);
  assert.ok(escaped.length <= DELIVERY_FULL_CHARS, `escaped delivery ${escaped.length}`);
  assert.doesNotMatch(escaped, /<system-reminder>/);
});

test('a foreground result shares one delivery budget across stdout and stderr', () => {
  const stdout = `${'o'.repeat(5_899)}\n`;
  const stderr = `${'e'.repeat(5_899)}\n`;
  const rendered = renderCompletedResult({
    result: { exitCode: 0, stdout, stderr },
    command: 'echo hi',
    analysisCommand: 'echo hi',
    cwd: tmpdir(),
    options: {},
    startedAtMs: Date.now(),
    teePlan: null,
    stdout,
    stderr,
    timeout: 0,
  });
  const out = String(rendered?.result ?? rendered);
  const body = out.slice(out.indexOf('o'.repeat(10)));
  assert.ok(body.length <= DELIVERY_FULL_CHARS, `foreground delivered ${body.length}`);
  assert.equal([...body.matchAll(MARKER_GLOBAL)].length, 2);
});

test('\\r progress frames fold to their last frame, also across chunks, after ANSI is stripped', () => {
  assert.equal(prepareShellText('\x1b[32m 10%\r 50%\r100%\x1b[0m\ndone\n'), '100%\ndone\n');
  const fold = createCarriageReturnFolder();
  assert.equal(prepareShellText('build  10%', fold), 'build  10%');
  assert.equal(prepareShellText('\rbuild  60%', fold), 'build  60%');
  assert.equal(prepareShellText('\rbuild 100%\nok\n', fold), 'build 100%\nok\n');
});

test('a task read folds a redrawn progress bar instead of delivering every frame', (t) => {
  const paths = logs(t);
  const frames = Array.from({ length: 2000 }, (_, i) => `\rdownloading ${Math.floor(i / 20)}%`).join('');
  writeFileSync(paths.stdout_path, `${frames}\nfinished\n`);
  const out = readShellTaskOutput({ status: 'completed' }, paths);
  assert.equal(out, '[stdout]\ndownloading 99%\nfinished\n');
});

test('a background move and a timed-out wait carry the progress digest', (t) => {
  const paths = logs(t);
  const jobId = `job_digest_${Date.now()}`;
  writeFileSync(paths.stdout_path, 'epoch 1/10 loss=0.9\n[#####.....] 45% ETA 01:20\n');
  const moved = renderBackgroundedResult({
    result: { jobId, stdoutPath: paths.stdout_path, stderrPath: paths.stderr_path },
    command: 'train',
    cwd: tmpdir(),
    options: { sessionId: `sess_${jobId}` },
    stdout: '',
    stderr: '',
  });
  assert.match(
    moved,
    /\[progress\] \+[\d.]+ KB, \+2 lines since you last saw it · last line: ".*45% ETA 01:20" · 45% · ETA 01:20 — still running, not an error/
  );
});

test('the completion after partial reads delivers only the unseen remainder, once', async (t) => {
  const paths = logs(t);
  const jobId = `job_remainder_${Date.now()}`;
  const sessionId = `sess_${jobId}`;
  const task = registerBackgroundTask({
    taskId: jobId,
    surface: 'shell',
    context: { callerSessionId: sessionId, routingSessionId: sessionId },
  });
  writeFileSync(paths.stdout_path, 'already seen\n');
  readShellTaskOutput(task, paths);
  appendFileSync(paths.stdout_path, 'final result\n');
  // What the completion watcher does: the remainder from the task's cursor.
  const output = readShellTaskOutput(task, paths, { terminal: true });
  task.completionOutput = output;
  const completion = buildShellCompletion(
    jobId,
    { status: 'completed', exitCode: 0, stdoutPath: paths.stdout_path },
    { output }
  );
  const body = parseTaskNotification(completion.notification).result;
  assert.match(body, /final result/);
  assert.doesNotMatch(body, /already seen/);
  completeBackgroundTask(jobId, {
    status: 'completed',
    result: { ...paths },
    resultText: completion.body,
    notify: false,
  });
  // A read reaching the finished task first gets that same remainder once.
  const read = await executeTaskTool({ action: 'read', task_id: jobId }, { sessionId });
  assert.match(read, /final result/);
  assert.doesNotMatch(read, /already seen/);
  assert.match(await executeTaskTool({ action: 'read', task_id: jobId }, { sessionId }), /no new output/);
});
