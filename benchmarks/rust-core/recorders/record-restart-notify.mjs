#!/usr/bin/env node
// Golden twin of the restart-failure notification (`agent-tool/restart-notify.mjs` `createRestartFailureNotifier`):
// for each row the previous process left failed with `process-restart`, the notification handed to the owner
// (execution id, meta, envelope text), the row stamp call, and the background-task record `registerFailedTask`
// leaves so `agent status <id>` resolves after the restart. The real notifier and the real background-task
// table run; the session manager's queue is scripted.
//
//   node benchmarks/rust-core/recorders/record-restart-notify.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree } from './lib/common.mjs';

const NOW = Date.parse('2026-03-01T10:00:00.000Z');
Date.now = () => NOW;
const sandbox = mkdtempSync(join(tmpdir(), 'restart-notify-'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'MIXDOG_USER_DATA_BACKUP_ROOT']) {
  const directory = join(sandbox, key);
  mkdirSync(directory);
  process.env[key] = directory;
}
const tree = resolveTree(parseArgs());
const { createRestartFailureNotifier, restartNotificationId } = await importFrom(tree, 'src/session-runtime/services/agent-tool/restart-notify.mjs');
const bg = await importFrom(tree, 'src/runtime/shared/background-tasks.mjs');

const ROWS = [
  { sessionId: 'sess_a', tag: 'rev', task_id: 'task_1', ownerSessionId: 'lead-a', agent: 'reviewer', provider: 'anthropic', model: 'claude-x', preset: 'p', effort: 'high', clientHostPid: 4001, status: 'failed', failureReason: 'process-restart', finishedAt: '2026-03-01T09:59:00.000Z' },
  { sessionId: 'sess_b', tag: 'wk', ownerSessionId: 'lead-a', agent: 'worker', status: 'failed', failureReason: 'process-restart', finishedAt: '2026-03-01T09:58:00.000Z' },
  { sessionId: 'sess_c', tag: '', task_id: 'task_3', ownerSessionId: 'lead-b', status: 'failed', failureReason: 'process-restart', finishedAt: '2026-03-01T09:57:00.000Z' },
  { sessionId: 'sess_d', tag: 'x<y&z', task_id: 'task_4', ownerSessionId: 'lead-b', agent: null, provider: null, model: null, clientHostPid: 0, status: 'failed', failureReason: 'process-restart', finishedAt: '2026-03-01T09:56:00.000Z' },
];

const cases = [];
for (const row of ROWS) {
  const queued = [];
  const stamped = [];
  const live = [];
  const notify = createRestartFailureNotifier({
    pendingRestartFailures: () => [row],
    markRestartNotified: (rows) => stamped.push(...rows.map((r) => r.sessionId)),
    mgr: {
      markCompletionEntry: (message, { executionId, meta }) => ({ message, executionId, meta }),
      enqueuePendingMessage: (owner, entry) => {
        queued.push({ owner, entry });
        return 1;
      },
      settlePendingMessageWrites: async () => true,
    },
    notifySessionCompletion: (owner, text, meta) => live.push({ owner, text, meta }),
  });
  await notify();
  const taskId = row.task_id || null;
  const task = taskId ? bg.getBackgroundTask(taskId) : null;
  cases.push({ row, executionId: restartNotificationId(row), queued: JSON.parse(JSON.stringify(queued)), live: JSON.parse(JSON.stringify(live)), stamped, task: task ? JSON.parse(JSON.stringify(task)) : null });
}
writeFileSync(join(FIXTURES_ROOT, 'restart-notify', 'golden.json'), `${JSON.stringify({ domain: 'restart-notify', recorder: 'benchmarks/rust-core/recorders/record-restart-notify.mjs', now: NOW, cases }, null, 1)}\n`);
console.log(`recorded ${cases.length} rows`);
rmSync(sandbox, { recursive: true, force: true });
process.exit(0);
