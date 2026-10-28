import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mock, test } from 'node:test';

import { makeTempDirSync } from '../../../../../../scripts/lib/scoped-temp.mjs';
// A turn's workspace reader is released through an asynchronous call. The ask
// finishes only after that release was attempted, and a release that fails
// never replaces the turn's own result or error.
// Run through scripts/test-direct.mjs (module mocks).

const root = makeTempDirSync('ask-workspace-release');
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });

const gate = { release: async () => {}, releases: 0 };
mock.module('../../../../shared/worktrees/activity-gate.mjs', {
  namedExports: {
    ...(await import('../../../../shared/worktrees/activity-gate.mjs')),
    admitWorkspaceActivity: async () => async () => {
      gate.releases += 1;
      await gate.release();
    },
  },
});

const { createSession } = await import('./session-lifecycle.mjs');
const { askSession } = await import('./ask-session.mjs');
const { deleteSession } = await import('../store.mjs');
const { _withRegisteredProviderForTestAsync } = await import('../../providers/registry.mjs');
const { modelToolSchemaAllowlist } = await import('../../runtime-core/tool-profile.mjs');
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

async function withSession(t, send, run) {
  const providerName = 'ask-session-release-test';
  const provider = { name: providerName, contextWindow: 128000, send };
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const session = createSession({
      provider: providerName,
      model: 'fake-model',
      cwd: root,
      skipSkills: true,
      schemaAllowedTools: modelToolSchemaAllowlist('headless'),
      workflow: { id: 'headless', delegatesAgents: false },
    });
    t.after(() => deleteSession(session.id, { deferSummaryUpdate: true }));
    await run(session);
  });
}

const ok = async () => ({ content: 'ok', usage: { inputTokens: 1, outputTokens: 1 } });

test('the ask returns only after the turn’s workspace release finished', async (t) => {
  await withSession(t, ok, async (session) => {
    let released = false;
    gate.releases = 0;
    gate.release = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      released = true;
    };
    await askSession(session.id, 'hello');
    assert.equal(gate.releases, 1);
    assert.equal(released, true, 'the release was awaited, not left running behind the result');
  });
});

test('a failing workspace release neither rejects the ask nor hides the turn’s own error', async (t) => {
  gate.release = async () => {
    throw new Error('admission thread stopped');
  };
  await withSession(t, ok, async (session) => {
    await askSession(session.id, 'hello');
  });
  const failing = async () => {
    throw new Error('provider exploded');
  };
  await withSession(t, failing, async (session) => {
    await assert.rejects(() => askSession(session.id, 'hello'), /provider exploded/);
  });
});
