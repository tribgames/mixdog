import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStandaloneHookBus } from '../hook-bus.mjs';

const rewrite = { updatedToolName: 'read', updatedInput: { file_path: 'revised.txt' } };
const ask = { permissionDecision: 'ask', permissionDecisionReason: 'confirm revised request' };

async function fixture(t, outputs) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-hook-approval-'));
  const path = join(root, 'hooks.json');
  const previous = process.env.MIXDOG_HOOKS_FILE;
  process.env.MIXDOG_HOOKS_FILE = path;
  t.after(async () => {
    if (previous === undefined) delete process.env.MIXDOG_HOOKS_FILE;
    else process.env.MIXDOG_HOOKS_FILE = previous;
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(
    path,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: outputs.map((_, index) => ({ type: 'mcp_tool', tool: `fixture_${index}` })),
          },
        ],
      },
    })
  );
  const calls = [];
  const bus = createStandaloneHookBus({
    dataDir: root,
    mcpToolRunner: async ({ name }) => {
      calls.push(name);
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', ...outputs[Number(name.slice('fixture_'.length))] },
      });
    },
  });
  return {
    calls,
    run: () => bus.beforeTool({ name: 'edit', args: { file_path: 'original.txt' }, cwd: root }),
  };
}

for (const [name, outputs] of [
  ['one handler', [{ ...rewrite, ...ask }]],
  ['rewrite then ask', [rewrite, ask]],
  ['ask then rewrite', [ask, rewrite]],
]) {
  test(`PreToolUse retains consent and the rewritten call from ${name}`, async (t) => {
    const { run } = await fixture(t, outputs);
    assert.deepEqual(await run(), {
      action: 'ask',
      name: 'read',
      args: rewrite.updatedInput,
      reason: ask.permissionDecisionReason,
    });
  });
}

test('PreToolUse denial still wins over a rewritten approval request', async (t) => {
  const { run, calls } = await fixture(t, [
    { ...rewrite, ...ask },
    { permissionDecision: 'deny', permissionDecisionReason: 'fixture denial' },
    { permissionDecision: 'allow' },
  ]);
  assert.deepEqual(await run(), { action: 'deny', reason: 'fixture denial' });
  assert.deepEqual(calls, ['fixture_0', 'fixture_1']);
});
