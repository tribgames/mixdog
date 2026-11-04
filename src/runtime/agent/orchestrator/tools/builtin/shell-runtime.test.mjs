import assert from 'node:assert/strict';
import test from 'node:test';
import { syncFsCalls } from '../../../../shared/sync-fs-calls.fixture.mjs';
import { getConfiguredShell, resolveShellFor, setConfiguredShell } from './shell-runtime.mjs';

test('a runtime start with an unchanged shell setting keeps the resolved shell', async () => {
  const previous = getConfiguredShell();
  try {
    setConfiguredShell('');
    const shell = resolveShellFor('default');
    const bash = resolveShellFor('bash');
    // Twenty session runtimes applying the same config.
    const calls = await syncFsCalls(() => {
      for (let i = 0; i < 20; i += 1) {
        setConfiguredShell('');
        assert.deepEqual(resolveShellFor('default'), shell);
        assert.deepEqual(resolveShellFor('bash'), bash);
      }
    });
    assert.deepEqual(calls, [], 'an unchanged shell setting re-walked PATH');
  } finally {
    setConfiguredShell(previous);
  }
});
