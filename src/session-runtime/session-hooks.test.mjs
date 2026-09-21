import assert from 'node:assert/strict';
import test from 'node:test';
import { attachSessionHooks } from './session-hooks.mjs';

function attach() {
  const dispatched = [];
  const beforeCalls = [];
  const session = { id: 'sess-1' };
  attachSessionHooks(session, {
    hooks: {
      dispatch: (event, payload) => {
        dispatched.push([event, payload]);
        return 'dispatched';
      },
      beforeTool: (payload, options) => {
        beforeCalls.push([payload, options]);
        return 'before';
      },
    },
    hookCommonPayload: (extra) => ({ common: true, ...extra }),
    getCwd: () => '/cwd',
  });
  return { session, dispatched, beforeCalls };
}

test('session hook bridges stay non-enumerable and carry the standard payload', () => {
  const { session, dispatched, beforeCalls } = attach();
  assert.deepEqual(Object.keys(session), ['id']);

  assert.equal(
    session.beforeToolHook({ name: 'read', args: { a: 1 }, toolCallId: 'call-1' }, { blocking: true }),
    'before'
  );
  assert.deepEqual(beforeCalls, [
    [
      {
        common: true,
        name: 'read',
        args: { a: 1 },
        toolCallId: 'call-1',
        session_id: 'sess-1',
        tool_name: 'read',
        tool_input: { a: 1 },
        tool_use_id: 'call-1',
        cwd: '/cwd',
      },
      { blocking: true },
    ],
  ]);

  assert.equal(
    session.afterToolHook({ name: 'read', args: { a: 1 }, toolCallId: 'call-1', result: 'ok' }),
    'dispatched'
  );
  session.afterToolFailureHook({ name: 'read', args: { a: 1 }, toolCallId: 'call-1', result: 'boom' });
  session.afterToolBatchHook({});
  session.preCompactHook({});
  session.postCompactHook({ trigger: 'manual', sessionId: 'sess-2', cwd: '/other' });

  assert.deepEqual(
    dispatched.map(([event]) => event),
    ['PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'PreCompact', 'PostCompact']
  );
  const toolPayload = {
    common: true,
    session_id: 'sess-1',
    cwd: '/cwd',
    tool_name: 'read',
    tool_input: { a: 1 },
    tool_use_id: 'call-1',
  };
  assert.deepEqual(dispatched[0][1], { ...toolPayload, tool_response: 'ok' });
  assert.deepEqual(dispatched[1][1], { ...toolPayload, tool_response: 'boom' });
  assert.deepEqual(dispatched[2][1], { common: true, session_id: 'sess-1', cwd: '/cwd' });
  assert.deepEqual(dispatched[3][1], { common: true, session_id: 'sess-1', cwd: '/cwd', trigger: 'auto' });
  assert.deepEqual(dispatched[4][1], { common: true, session_id: 'sess-2', cwd: '/other', trigger: 'manual' });
});
