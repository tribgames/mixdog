import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runHeadlessExec } from './headless-exec.mjs';

test('headless exec runs one implicit-approval session and waits for tracked tasks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-headless-exec-test-'));
  const usageLogPath = join(root, 'usage.json');
  const output = [];
  const errors = [];
  const runtimeOptions = [];
  const activeScopes = [];
  let activeChecks = 0;
  let boundaryCleaned = false;
  let runtimeClosed = false;
  try {
    const code = await runHeadlessExec({
      message: 'fix it',
      provider: 'openai-oauth',
      model: 'gpt-test',
      effort: 'high',
      fast: true,
      usageLogPath,
      idlePollMs: 1,
      write: (text) => output.push(text),
      writeErr: (text) => errors.push(text),
      boundaryFactory: () => ({
        loadConfig: () => ({ providers: { 'openai-oauth': { enabled: true } } }),
        cleanup: () => { boundaryCleaned = true; },
      }),
      runtimeFactory: async (options) => {
        runtimeOptions.push(options);
        return {
          id: 'sess_exec_test',
          model: 'gpt-test',
          clientHostPid: 123,
          ask: async (_prompt, optionsForAsk) => {
            optionsForAsk.onUsageDelta({
              deltaInput: 11,
              deltaCachedRead: 7,
              deltaCacheWrite: 3,
              deltaOutput: 5,
            });
            return { result: { content: 'done' } };
          },
          close: async () => { runtimeClosed = true; },
        };
      },
      hasActiveTasks: (scope) => {
        activeScopes.push(scope);
        activeChecks += 1;
        return activeChecks === 1;
      },
      installSignalCleanupFn: () => ({ uninstall() {} }),
    });

    assert.equal(code, 0);
    assert.deepEqual(output, ['done\n']);
    assert.deepEqual(errors, []);
    assert.equal(runtimeOptions[0].approvalMode, 'implicit');
    assert.equal(runtimeOptions[0].disallowDelegation, true);
    assert.equal(runtimeOptions[0].toolMode, 'full');
    assert.deepEqual(activeScopes[0], {
      callerSessionId: 'sess_exec_test',
      clientHostPid: 123,
    });
    assert.equal(boundaryCleaned, true);
    assert.equal(runtimeClosed, true);
    const usage = JSON.parse(readFileSync(usageLogPath, 'utf8'));
    assert.deepEqual(usage.totals, {
      inputTokens: 11,
      cacheTokens: 7,
      cacheWriteTokens: 3,
      outputTokens: 5,
      toolCallCountApprox: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
