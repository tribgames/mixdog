import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolGate } from './tool-gate.mjs';
import { createEventRunner } from './event-runner.mjs';
import { applyBeforeToolHook } from '../../../runtime/agent/orchestrator/session/loop/tool-exec/before-hook.mjs';

const input = { name: 'apply_patch', args: { patch: 'fixture' }, cwd: process.cwd() };

test('applyBeforeToolHook denies when hook throws', async () => {
  const r = await applyBeforeToolHook({
    ...input,
    executeOpts: {},
    beforeToolHook: async () => {
      throw new Error('boom');
    },
  });
  assert.match(r.denial, /policy check failed: boom/);
});

test('applyBeforeToolHook preserves cancellation and normal decisions', async () => {
  const ac = new AbortController();
  ac.abort(new Error('cancelled'));
  await assert.rejects(
    applyBeforeToolHook({ ...input, executeOpts: { signal: ac.signal }, beforeToolHook: async () => null }),
    /cancelled/
  );
  const deny = await applyBeforeToolHook({
    ...input,
    executeOpts: {},
    beforeToolHook: async () => ({ action: 'deny', reason: 'no' }),
  });
  assert.match(deny.denial, /denied by hook: no/);
  const rw = await applyBeforeToolHook({
    ...input,
    executeOpts: {},
    beforeToolHook: async () => ({ action: 'rewrite', args: { command: 'y' } }),
  });
  assert.deepEqual(rw.args, { command: 'y' });
  const ok = await applyBeforeToolHook({ ...input, executeOpts: {}, beforeToolHook: async () => null });
  assert.equal(ok.name, 'apply_patch');
});

const gate = (over) =>
  createToolGate({
    loadConfig: () => ({}),
    loadRules: () => [],
    runEventHandlers: async () => ({ blocked: false }),
    emit: () => {},
    cursor: {},
    ...over,
  });

test('tool gate denies on config load failure and handler throw', async () => {
  const a = await gate({
    loadConfig: () => {
      throw new Error('cfg bad');
    },
  })(input);
  assert.equal(a.action, 'deny');
  assert.match(a.reason, /cfg bad/);
  const b = await gate({
    runEventHandlers: async () => {
      throw new Error('h bad');
    },
  })(input);
  assert.equal(b.action, 'deny');
  assert.equal(await gate({})(input), null);
});

const runner = (handler, runOne) =>
  createEventRunner({
    loadConfig: () => ({
      standard: true,
      events: {
        PreToolUse: [{ matcher: '*', hooks: [handler, { type: 'mcp_tool', tool: 'later' }] }],
        PostToolUse: [{ matcher: '*', hooks: [handler, { type: 'mcp_tool', tool: 'later' }] }],
      },
    }),
    emit: () => {},
    cursor: {},
    pluginData: {},
    promptRunner: runOne,
    mcpToolRunner: runOne,
  });

test('event runner: PreToolUse handler failure blocks, other events continue', async () => {
  const calls = [];
  const handler = { type: 'mcp_tool', tool: 'failing_policy' };
  const r = runner(handler, async ({ name }) => {
    calls.push(name);
    if (name === 'failing_policy') throw new Error('handler failed');
    return '';
  });
  const payload = { tool_name: 'apply_patch', cwd: process.cwd() };
  const pre = await r.runEventHandlers('PreToolUse', payload);
  assert.equal(pre.blocked, true);
  assert.match(pre.reason, /policy check failed: handler failed/);
  assert.deepEqual(calls, ['failing_policy']);
  calls.length = 0;
  const post = await r.runEventHandlers('PostToolUse', payload);
  assert.equal(post.blocked, false);
  assert.deepEqual(calls, ['failing_policy', 'later']);
});
