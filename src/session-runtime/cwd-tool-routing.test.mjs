import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMixdogSessionRuntime } from './runtime-core.mjs';
import { executeTool } from '../runtime/agent/orchestrator/session/loop/tool-exec.mjs';

test('cwd internal tool stays bound to its caller when another runtime owns the shared executor', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-cwd-routing-'));
  const cwdA = join(root, 'a');
  const cwdB = join(root, 'b');
  const cwdNext = join(root, 'next');
  mkdirSync(cwdA);
  mkdirSync(cwdB);
  mkdirSync(cwdNext);

  const runtimeA = await createMixdogSessionRuntime({ cwd: cwdA, toolMode: 'full' });
  const runtimeB = await createMixdogSessionRuntime({ cwd: cwdB, toolMode: 'full' });
  t.after(async () => {
    await Promise.allSettled([
      runtimeA.close('cwd-routing-test', { waitForExit: false }),
      runtimeB.close('cwd-routing-test', { waitForExit: false }),
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  // runtimeB registered the process-global internal-tool executor last. The
  // call still belongs to runtimeA and must neither report nor mutate B.
  const callerSession = {
    id: 'sess_cwd_caller_a',
    cwd: cwdA,
    _applyResolvedCwdForCaller: (nextCwd) => runtimeA.setCwd(nextCwd),
  };
  const getResult = JSON.parse(await executeTool(
    'cwd',
    {},
    cwdA,
    callerSession.id,
    callerSession,
  ));
  assert.equal(getResult.cwd, cwdA);
  assert.equal(getResult.sessionId, callerSession.id);

  const setResult = JSON.parse(await executeTool(
    'cwd',
    { path: cwdNext },
    cwdA,
    callerSession.id,
    callerSession,
  ));
  assert.equal(setResult.cwd, cwdNext);
  assert.equal(setResult.sessionId, callerSession.id);
  assert.equal(runtimeA.cwd, cwdNext);
  assert.equal(runtimeB.cwd, cwdB);
});
