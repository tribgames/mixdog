// A session installed by any path (resume, route swap, clear, a turn re-reading
// the manager's copy) must carry the PreToolUse bridge, and hook rules saved
// while it is open must reach its very next tool call.
import '../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStandaloneHookBus } from '../services/hook-bus.mjs';
import { beginBoot } from './begin.mjs';
import { resolveConfig } from './config.mjs';
import { sessionAdopter } from './infrastructure.mjs';

async function bootedRuntime(dataDir, initialConfig = { providers: {}, modelSettings: {} }) {
  const boot = beginBoot({
    provider: 'openai',
    model: 'gpt-5.4',
    toolMode: 'full',
    cwd: dataDir,
    ...(initialConfig ? { initialConfig } : {}),
  });
  boot.cfgMod = { loadConfig: () => ({}) };
  boot.sharedCfgMod = { pendingConfigWrites: async () => {}, invalidateConfigReadCache() {} };
  await resolveConfig(boot);
  boot.bindRuntimeNotificationSession = () => {};
  boot.workspaceApi = {};
  boot.hooks = createStandaloneHookBus({ dataDir });
  boot.adoptSession = sessionAdopter(boot);
  return boot;
}

test('an adopted (resumed) session sees hook rules saved while it is open, and stops when they are removed', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-adopt-hooks-'));
  const previous = process.env.MIXDOG_HOOKS_FILE;
  delete process.env.MIXDOG_HOOKS_FILE;
  const settings = createStandaloneHookBus({ dataDir });
  t.after(async () => {
    if (previous !== undefined) process.env.MIXDOG_HOOKS_FILE = previous;
    await rm(dataDir, { recursive: true, force: true });
  });
  const boot = await bootedRuntime(dataDir);
  const resumed = { id: 'sess_resumed' };
  boot.adoptSession(resumed);
  assert.equal(typeof resumed.beforeToolHook, 'function', 'the adopted session carries the PreToolUse bridge');

  const call = (name) => resumed.beforeToolHook({ name, args: {}, cwd: dataDir });
  assert.equal(await call('setup'), null);
  settings.addRule({ tool: 'setup', action: 'ask' });
  settings.addRule({ tool: 'mcp__cal__*', action: 'ask' });
  assert.equal((await call('setup'))?.action, 'ask');
  assert.equal((await call('mcp__cal__create'))?.action, 'ask');
  settings.deleteRule(0);
  assert.equal(await call('setup'), null);
  assert.equal((await call('mcp__cal__create'))?.action, 'ask');
});

// Issue #161: a session reopened by resume / on-demand load must still run the
// configured PreToolUse command hook, exactly once per call, like a fresh one.
test('a resumed and a fresh session both run the PreToolUse deny hook for shell exactly once', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-adopt-hooks-'));
  const previous = process.env.MIXDOG_HOOKS_FILE;
  t.after(async () => {
    if (previous === undefined) delete process.env.MIXDOG_HOOKS_FILE;
    else process.env.MIXDOG_HOOKS_FILE = previous;
    await rm(dataDir, { recursive: true, force: true });
  });
  const log = join(dataDir, 'hook-calls.log');
  const script = join(dataDir, 'deny.mjs');
  await writeFile(
    script,
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, 'x');\nprocess.stderr.write('blocked by policy');\nprocess.exit(2);\n`
  );
  const hooksFile = join(dataDir, 'hooks.json');
  await writeFile(
    hooksFile,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'shell', hooks: [{ type: 'command', command: process.execPath, args: [script], timeout: 10 }] },
        ],
      },
    })
  );
  process.env.MIXDOG_HOOKS_FILE = hooksFile;
  const boot = await bootedRuntime(dataDir);
  const { executeTool } = await import('../../runtime/agent/orchestrator/session/loop/tool-exec.mjs');

  for (const id of ['sess_resumed', 'sess_fresh']) {
    await writeFile(log, '');
    const session = { id };
    boot.adoptSession(session);
    // Adopting the same session again (route swap, manager copy) must not re-attach.
    const bridge = session.beforeToolHook;
    boot.adoptSession(session);
    assert.equal(session.beforeToolHook, bridge);
    const result = await executeTool('shell', { command: 'echo hi' }, dataDir, id, session, {});
    assert.match(String(result), /denied by hook.*blocked by policy/s, id);
    assert.equal(await readFile(log, 'utf8'), 'x', `${id}: the hook ran exactly once`);
  }
});

// Issue #237: a conversation saved under older compaction settings follows the
// current global ones when it is resumed or re-adopted.
test('an adopted session follows the current global compaction settings, keeping its own fields', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-adopt-compaction-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const boot = await bootedRuntime(dataDir, null);
  boot.rt.config = { ...boot.rt.config, compaction: { auto: true, mainBufferPercent: 20 } };
  const resumed = {
    id: 'sess_old_compaction',
    compaction: { auto: false, mainBufferTokens: 8000, conversationThresholdTokens: 5, archive: { nextSeq: 3 } },
  };
  boot.adoptSession(resumed);
  assert.equal(resumed.compaction.auto, true);
  assert.equal(resumed.compaction.mainBufferPercent, 20);
  assert.equal(Object.hasOwn(resumed.compaction, 'mainBufferTokens'), false, 'the replaced token budget is dropped');
  assert.equal(resumed.compaction.conversationThresholdTokens, 5, 'a per-session field survives');
  assert.deepEqual(resumed.compaction.archive, { nextSeq: 3 });
  // A runtime whose config carries no compaction section leaves the session alone.
  const bare = await bootedRuntime(dataDir, null);
  const untouched = { id: 'sess_bare', compaction: { auto: false } };
  bare.adoptSession(untouched);
  assert.deepEqual(untouched.compaction, { auto: false });
});

test('a headless runtime on an injected config keeps its session compaction fixed on adoption', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-adopt-compaction-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const boot = await bootedRuntime(dataDir, { providers: {}, modelSettings: {}, compaction: { auto: true } });
  boot.rt.config = { ...boot.rt.config, compaction: { auto: true, mainBufferPercent: 20 } };
  const session = { id: 'sess_headless', compaction: { auto: false, mainBufferTokens: 8000 } };
  boot.adoptSession(session);
  assert.deepEqual(session.compaction, { auto: false, mainBufferTokens: 8000 });
});

test('adopting a session that already carries its bridge leaves it in place', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-adopt-hooks-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const boot = await bootedRuntime(dataDir);
  const own = async () => 'own';
  const session = { id: 'sess_own', beforeToolHook: own };
  boot.adoptSession(session);
  assert.equal(session.beforeToolHook, own);
});
