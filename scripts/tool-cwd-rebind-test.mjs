import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeTool,
  resolveLiveToolCwd,
} from '../src/runtime/agent/orchestrator/session/loop/tool-exec.mjs';

test('live session cwd supersedes the stale turn-start cwd', () => {
  const sessionRef = { cwd: 'C:\\Project\\live' };
  assert.equal(
    resolveLiveToolCwd('C:\\workspace\\unclassified', sessionRef),
    'C:\\Project\\live',
  );
});

test('tool dispatch re-reads session cwd after an in-turn cwd change', async () => {
  const sessionRef = { cwd: 'C:\\workspace\\unclassified' };
  sessionRef.cwd = 'C:\\Project\\mixdog';

  let hookCwd = null;
  await executeTool(
    'missing_tool_for_cwd_rebind_test',
    {},
    'C:\\workspace\\unclassified',
    'cwd-rebind-test-session',
    sessionRef,
    {
      toolCallId: 'cwd-rebind-test-call',
      beforeToolHook: ({ cwd }) => {
        hookCwd = cwd;
      },
    },
  );

  assert.equal(hookCwd, 'C:\\Project\\mixdog');
});
