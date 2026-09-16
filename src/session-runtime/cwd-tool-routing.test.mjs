import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('cwd internal tool stays bound to its caller when another runtime owns the shared executor', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-cwd-routing-'));
  const cwdA = join(root, 'a');
  const cwdB = join(root, 'b');
  const cwdNext = join(root, 'next');
  mkdirSync(cwdA);
  mkdirSync(cwdB);
  mkdirSync(cwdNext);
  const previousProcessCwd = process.env.MIXDOG_SESSION_CWD;
  const previousHome = process.env.MIXDOG_HOME;
  const previousData = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_HOME = join(root, 'home');
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  process.env.MIXDOG_SESSION_CWD = 'process-global-must-not-change';

  const { createMixdogSessionRuntime } = await import('./runtime-core.mjs');
  const { executeTool } = await import('../runtime/agent/orchestrator/session/loop/tool-exec.mjs');
  const { drainSessionStore } = await import('../runtime/agent/orchestrator/session/store.mjs');
  const options = {
    provider: 'openai',
    model: 'gpt-4o-mini',
    toolMode: 'full',
    initialConfig: {
      providers: { openai: { enabled: true, apiKey: 'cwd-test-only', baseUrl: 'http://127.0.0.1:1/v1' } },
    },
  };
  const runtimeA = await createMixdogSessionRuntime({
    ...options,
    cwd: cwdA,
    desktopSession: { classification: 'project', projectPath: cwdA },
  });
  const runtimeB = await createMixdogSessionRuntime({ ...options, cwd: cwdB });
  let restored = null;
  t.after(async () => {
    await Promise.allSettled([
      runtimeA.close('cwd-routing-test', { waitForExit: false }),
      runtimeB.close('cwd-routing-test', { waitForExit: false }),
      restored?.close('cwd-routing-test', { waitForExit: false }),
    ]);
    drainSessionStore();
    if (previousProcessCwd === undefined) delete process.env.MIXDOG_SESSION_CWD;
    else process.env.MIXDOG_SESSION_CWD = previousProcessCwd;
    if (previousHome === undefined) delete process.env.MIXDOG_HOME;
    else process.env.MIXDOG_HOME = previousHome;
    if (previousData === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousData;
    rmSync(root, { recursive: true, force: true });
  });
  await runtimeA.newSession();

  // runtimeB registered the process-global internal-tool executor last. The
  // call still belongs to runtimeA and must neither report nor mutate B.
  const callerSession = runtimeA.session;
  callerSession.messages.push({ role: 'user', content: 'Keep this conversation across reentry.' });
  const getResult = JSON.parse(await executeTool('cwd', {}, cwdA, callerSession.id, callerSession));
  assert.equal(getResult.cwd, cwdA);
  assert.equal(getResult.sessionId, callerSession.id);

  const setResult = JSON.parse(await executeTool('cwd', { path: cwdNext }, cwdA, callerSession.id, callerSession));
  assert.equal(setResult.cwd, cwdNext);
  assert.equal(setResult.sessionId, callerSession.id);
  assert.equal(runtimeA.cwd, cwdNext);
  assert.equal(callerSession.cwd, cwdNext);
  assert.deepEqual(callerSession.desktopSession, { classification: 'project', projectPath: cwdNext });
  assert.equal(runtimeB.cwd, cwdB);
  assert.equal(process.env.MIXDOG_SESSION_CWD, 'process-global-must-not-change');

  drainSessionStore();
  const persisted = JSON.parse(
    readFileSync(join(process.env.MIXDOG_DATA_DIR, 'sessions', `${callerSession.id}.json`), 'utf8')
  );
  assert.equal(persisted.cwd, cwdNext);
  assert.deepEqual(persisted.desktopSession, callerSession.desktopSession);
  assert.ok(persisted.messages.some((message) => message.content === 'Keep this conversation across reentry.'));
  await runtimeA.close('cwd-routing-reentry', { waitForExit: false });
  restored = await createMixdogSessionRuntime({
    ...options,
    cwd: cwdA,
    desktopSession: { classification: 'project', projectPath: cwdA },
  });
  await restored.resume(callerSession.id);
  assert.equal(restored.cwd, cwdNext);
  assert.deepEqual(restored.session.desktopSession, { classification: 'project', projectPath: cwdNext });
  const returned = JSON.parse(await executeTool('cwd', { path: cwdA }, cwdNext, restored.id, restored.session));
  assert.equal(returned.cwd, cwdA);
  assert.equal(restored.cwd, cwdA);
  assert.deepEqual(restored.session.desktopSession, { classification: 'project', projectPath: cwdA });
  assert.equal(runtimeB.cwd, cwdB);
});
