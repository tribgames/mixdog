import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const root = await mkdtemp(join(tmpdir(), 'mixdog-tool-cancellation-'));
const environment = {
  MIXDOG_DATA_DIR: join(root, 'data'),
  MIXDOG_HOME: join(root, 'home'),
  MIXDOG_USER_DATA_BACKUP_ROOT: join(root, 'backups'),
};
const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
Object.assign(process.env, environment);
after(async () => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
  // The tools flush read snapshots into the data dir from their own exit
  // hooks and recreate it; registered after those modules loaded, this
  // removal runs after every one of them.
  process.once('exit', () => rmSync(root, { recursive: true, force: true }));
});
const { executeTool } = await import('./tool-exec.mjs');
const { _touchRuntime, getSessionProgressSnapshot, getSessionRuntime, updateSessionStage } = await import(
  '../manager/runtime-liveness.mjs'
);
const { createJobViews } = await import('../../../../../session-runtime/services/agent-tool/job-views.mjs');
const { createStandaloneHookBus } = await import('../../../../../session-runtime/services/hook-bus.mjs');
const { attachSessionHooks } = await import('../../../../../session-runtime/session-hooks.mjs');

for (const phase of ['before execution', 'during policy hook']) {
  test(`a native mutation cannot begin after cancellation ${phase}`, async () => {
    const controller = new AbortController();
    const reason = new Error(`cancelled ${phase}`);
    if (phase === 'before execution') controller.abort(reason);
    const fileName = phase === 'before execution' ? 'early.txt' : 'hook.txt';
    const session = { id: 'fixture-cancelled-tool', cwd: root };
    let failure;
    await executeTool(
      'apply_patch',
      {
        patch: `*** Begin Patch\n*** Add File: ${fileName}\n+must not be written\n*** End Patch\n`,
      },
      root,
      session.id,
      session,
      {
        signal: controller.signal,
        beforeToolHook: async () => {
          if (phase === 'during policy hook') controller.abort(reason);
          return null;
        },
      }
    ).catch((error) => {
      failure = error;
    });
    await assert.rejects(readFile(join(root, fileName)), { code: 'ENOENT' });
    assert.equal(failure, reason);
  });
}

for (const phase of ['policy', 'approval']) {
  test(`cancellation interrupts a pending ${phase} hook without accepting its late decision`, {
    timeout: 2_000,
  }, async (t) => {
    const controller = new AbortController();
    const reason = new Error(`cancel pending ${phase}`);
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const session = { id: `fixture-pending-${phase}`, cwd: root };
    const fileName = `${phase}-late.txt`;
    const result = executeTool(
      'apply_patch',
      {
        patch: `*** Begin Patch\n*** Add File: ${fileName}\n+must not be written\n*** End Patch\n`,
      },
      root,
      session.id,
      session,
      {
        signal: controller.signal,
        beforeToolHook: async () => {
          if (phase === 'approval') return { action: 'ask' };
          started.resolve();
          await release.promise;
          return null;
        },
        toolApprovalHook: async () => {
          started.resolve();
          await release.promise;
          return { approved: true };
        },
      }
    );
    result.catch(() => {});
    t.after(async () => {
      release.resolve();
      await result.catch(() => {});
    });
    await started.promise;
    controller.abort(reason);
    await assert.rejects(result, (error) => error === reason);
    release.resolve();
    await new Promise(setImmediate);
    await assert.rejects(readFile(join(root, fileName)), { code: 'ENOENT' });
  });
}

for (const settle of ['answer', 'cancel']) {
  test(`a pending approval marks the agent status rows as awaiting the user until the ${settle}`, async (t) => {
    const session = { id: `fixture-awaiting-${settle}`, cwd: root, agent: 'reviewer', status: 'running' };
    _touchRuntime(session.id);
    updateSessionStage(session.id, 'tool_running');
    // The agent tool's status producer over the live runtime liveness map.
    const views = createJobViews({
      mgr: {
        getSession: (id) => (id === session.id ? session : null),
        getSessionRuntime,
        getSessionProgressSnapshot,
      },
      getLiveSession: () => null,
      reg: { getProvider: () => null },
      DEFAULT_SPAWN_PREP_TIMEOUT_MS: 1000,
      refreshTagsFromSessions: () => {},
      agentSessionEntries: () => [{ tag: 'review', session }],
      tags: new Map(),
      cfgMod: { loadConfig: () => ({}) },
    });
    const controller = new AbortController();
    const asked = Promise.withResolvers();
    const answer = Promise.withResolvers();
    const result = executeTool(
      'apply_patch',
      { patch: `*** Begin Patch\n*** Add File: awaiting-${settle}.txt\n+must not be written\n*** End Patch\n` },
      root,
      session.id,
      session,
      {
        signal: controller.signal,
        beforeToolHook: async () => ({ action: 'ask' }),
        toolApprovalHook: async () => {
          asked.resolve();
          return answer.promise;
        },
      }
    );
    result.catch(() => {});
    t.after(() => answer.resolve({ approved: false }));
    await asked.promise;
    const [waiting] = views.list();
    assert.equal(waiting.stage, 'tool_running');
    assert.equal(waiting.awaitingUser, 'approval');
    assert.equal(getSessionProgressSnapshot(session.id).awaitingUser, 'approval');
    if (settle === 'answer') {
      answer.resolve({ approved: false, reason: 'fixture decision' });
      assert.match(await result, /was not approved: fixture decision\. Do not retry it/);
    } else {
      const reason = new Error('cancel while awaiting approval');
      controller.abort(reason);
      await assert.rejects(result, (error) => error === reason);
    }
    const [settled] = views.list();
    assert.equal('awaitingUser' in settled, false);
    assert.equal('awaitingUser' in getSessionProgressSnapshot(session.id), false);
  });
}

for (const approved of [true, false]) {
  test(`a rewritten call is the request actually ${approved ? 'approved' : 'denied'} by the user`, async () => {
    const original = `original-${approved}.txt`;
    const revised = `revised-${approved}.txt`;
    const args = {
      patch: `*** Begin Patch\n*** Add File: ${revised}\n+approved target\n*** End Patch\n`,
    };
    const session = { id: `fixture-rewritten-${approved}`, cwd: root };
    let requested;
    const result = await executeTool(
      'edit',
      {
        file_path: original,
        old_string: '',
        new_string: 'must not be written',
      },
      root,
      session.id,
      session,
      {
        beforeToolHook: async () => ({ action: 'ask', name: 'apply_patch', args }),
        toolApprovalHook: async (request) => {
          requested = request;
          return { approved, reason: 'fixture decision' };
        },
      }
    );
    assert.equal(requested.name, 'apply_patch');
    assert.deepEqual(requested.args, args);
    await assert.rejects(readFile(join(root, original)), { code: 'ENOENT' });
    if (approved) {
      assert.equal(await readFile(join(root, revised), 'utf8'), 'approved target\n');
    } else {
      assert.match(result, /was not approved: fixture decision\. Do not retry it/);
      await assert.rejects(readFile(join(root, revised)), { code: 'ENOENT' });
    }
  });
}

for (const boundary of ['active request', 'queued successor']) {
  test(`turn cancellation reaches the policy hook ${boundary}`, async (t) => {
    const path = join(root, `cancel-${boundary.replace(' ', '-')}.json`);
    await writeFile(
      path,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'apply_patch',
              hooks: [
                { type: 'mcp_tool', tool: 'fixture_first' },
                { type: 'mcp_tool', tool: 'fixture_second' },
              ],
            },
          ],
        },
      })
    );
    const previous = process.env.MIXDOG_HOOKS_FILE;
    process.env.MIXDOG_HOOKS_FILE = path;
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const calls = [];
    let runningSignal;
    let policy;
    const hooks = createStandaloneHookBus({
      dataDir: join(root, 'data'),
      mcpToolRunner: ({ name, signal }) => {
        calls.push(name);
        if (name === 'fixture_first') {
          runningSignal = signal;
          started.resolve();
          return release.promise;
        }
        return '{}';
      },
    });
    const original = hooks.beforeTool;
    hooks.beforeTool = (...args) => {
      policy = original(...args);
      policy.catch(() => {});
      return policy;
    };
    t.after(async () => {
      release.resolve('{}');
      await policy?.catch(() => {});
      if (previous === undefined) delete process.env.MIXDOG_HOOKS_FILE;
      else process.env.MIXDOG_HOOKS_FILE = previous;
    });
    const session = { id: 'fixture-hook-cancel', cwd: root };
    attachSessionHooks(session, {
      hooks,
      hookCommonPayload: (input) => input,
      getCwd: () => root,
    });
    const controller = new AbortController();
    const reason = new Error('cancel the policy request');
    const result = executeTool(
      'apply_patch',
      {
        patch: '*** Begin Patch\n*** Add File: cancelled-policy.txt\n+must not be written\n*** End Patch\n',
      },
      root,
      session.id,
      session,
      { signal: controller.signal }
    );
    result.catch(() => {});
    await started.promise;
    controller.abort(reason);
    await assert.rejects(result, (error) => error === reason);
    if (boundary === 'active request') assert.equal(runningSignal.aborted, true);
    release.resolve('{}');
    await policy.catch(() => {});
    assert.deepEqual(calls, ['fixture_first']);
    await assert.rejects(readFile(join(root, 'cancelled-policy.txt')), { code: 'ENOENT' });
  });
}
