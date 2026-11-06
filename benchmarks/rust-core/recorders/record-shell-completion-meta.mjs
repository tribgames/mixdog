#!/usr/bin/env node
// Golden twin of the meta a finished background shell job hands the launching call's `notifyFn`
// (shell-jobs.mjs `watchBackgroundShellJob` → `notifyToolCompletion`): Node's real
// `normalizeShellJobDetail`, `buildShellCompletion` and `notifyToolCompletion` run over job
// details a task can end with; the capture is the text and meta the hook received.
//
//   node benchmarks/rust-core/recorders/record-shell-completion-meta.mjs --tree <dir with node_modules>
import { join } from 'node:path';
import { importFrom, parseArgs, REPO_ROOT, resolveTree, writeJson } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const jobs = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin/shell-jobs.mjs');
const contract = await importFrom(tree, 'src/runtime/shared/tool-execution-contract.mjs');

const base = {
  command: 'echo hi',
  startedAt: '2026-01-02T03:04:05.678Z',
  finishedAt: '2026-01-02T03:04:07.178Z',
  stdoutPath: '/tmp/l/task-c1.stdout.log',
  stderrPath: '/tmp/l/task-c1.stderr.log',
  stdoutPreview: 'hi\n',
  stderrPreview: '',
};
const DETAILS = {
  completed: { status: 'completed', exitCode: 0 },
  'non-zero exit': { status: 'failed', exitCode: 3 },
  cancelled: { status: 'cancelled', exitCode: 137, killed: true },
  'timed out': { status: 'failed', exitCode: 124, timedOut: true },
  'signal death': { status: 'failed', exitCode: null, signal: 'SIGSEGV' },
  'no exit status': { status: 'failed', exitCode: null },
};

const cases = [];
for (const [name, extra] of Object.entries(DETAILS)) {
  const detail = { ...base, ...extra };
  const completion = jobs.buildShellCompletion('task-c1', jobs.normalizeShellJobDetail(detail), { output: '' });
  const received = [];
  contract.notifyToolCompletion({
    surface: 'shell',
    id: 'task-c1',
    status: completion.taskStatus,
    text: completion.notification,
    resultType: 'shell_task_result',
    instruction: completion.instruction,
    context: { callerSessionId: 't', notifyFn: (text, meta) => (received.push({ text, meta }), true) },
  });
  cases.push({ name, detail, received: received[0] });
}
writeJson(join(REPO_ROOT, 'native', 'core', 'crates', 'mixdog-tools', 'src', 'exec', 'testdata', 'shell_completion_meta.json'), { cases });
console.log(`shell completion meta: ${cases.length} cases`);
