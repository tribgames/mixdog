
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  approvalGranted,
  formatMissingToolApprovalUiDenial,
  resolvePreToolAskApproval,
} from '../src/runtime/agent/orchestrator/session/loop.mjs';

test('PreToolUse ask without approval callback returns explicit denial', async () => {
  const outcome = await resolvePreToolAskApproval({
    toolName: 'shell',
    args: { command: 'echo hi' },
    cwd: '/tmp',
    sessionId: 'sess_test',
    toolCallId: 'call_1',
    askReason: 'needs human approval',
    toolApprovalHook: undefined,
  });
  assert.equal(outcome.approval, undefined);
  assert.match(outcome.denial, /approval required but no approval UI is available/);
  assert.match(outcome.denial, /needs human approval/);
  assert.equal(
    outcome.denial,
    formatMissingToolApprovalUiDenial('shell', 'needs human approval'),
  );
});

test('PreToolUse ask with rejected approval returns structured denial', async () => {
  const outcome = await resolvePreToolAskApproval({
    toolName: 'read',
    args: { path: 'README.md' },
    cwd: '/tmp',
    sessionId: 'sess_test',
    toolCallId: 'call_2',
    askReason: 'confirm read',
    toolApprovalHook: async () => ({ approved: false, reason: 'user declined' }),
  });
  assert.match(outcome.denial, /denied by hook: user declined/);
});

test('PreToolUse ask with granted approval allows tool execution', async () => {
  const outcome = await resolvePreToolAskApproval({
    toolName: 'grep',
    args: { pattern: 'foo' },
    cwd: '/tmp',
    sessionId: 'sess_test',
    toolCallId: 'call_3',
    askReason: 'confirm grep',
    toolApprovalHook: async () => ({ approved: true }),
  });
  assert.equal(outcome.denial, undefined);
  assert.equal(approvalGranted(outcome.approval), true);
});

test('Discord channel runtime contains no disconnected approval protocol', () => {
  const files = [
    '../src/runtime/channels/lib/interaction-handlers.mjs',
    '../src/runtime/channels/lib/worker-ipc.mjs',
    '../src/runtime/channels/lib/worker-main.mjs',
    '../src/runtime/channels/lib/runtime-paths.mjs',
  ];
  const source = files
    .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
    .join('\n');
  for (const deadPattern of [
    /permission_request_inbound/,
    /notifications\/claude\/channel\/permission/,
    /perm-ch-/,
    /pendingPermRequests/,
    /getPermissionResultPath/,
    /\.tool-exec-consumer/,
    /tool-exec-.*\.signal/,
  ]) {
    assert.doesNotMatch(source, deadPattern);
  }
});
