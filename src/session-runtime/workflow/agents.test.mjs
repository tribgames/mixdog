// The agent list feeds every session's 2 s status pulse. It must be scanned
// once per revalidation interval for the whole process (not once per session
// per tick), the revalidation must not run on the caller's stack, and an
// agent file change must still reach the list.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkflowHelpers } from '../workflow.mjs';
import { AGENT_LIST_REVALIDATE_MS } from './agents.mjs';
import { isHiddenAgent } from '../../runtime/agent/orchestrator/internal-agents.mjs';

function writeAgent(root, id) {
  mkdirSync(join(root, 'agents', id), { recursive: true });
  writeFileSync(join(root, 'agents', id, 'AGENT.md'), `# ${id}\n\nDoes ${id} work.\n`);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-list-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  for (const id of ['worker', 'reviewer']) writeAgent(root, id);
  const helpers = () =>
    createWorkflowHelpers({
      rootDir: root,
      dataDir: data,
      readMarkdownDocument: (text) => ({ body: String(text || ''), frontmatter: {} }),
      normalizeAgentPermissionOrNone: () => null,
    });
  return { root, data, helpers };
}

// Count directory scans of this fixture only; named fs imports follow the
// mocked properties after syncBuiltinESMExports.
function spyScans(t, root) {
  const inRoot = (path) => String(path).startsWith(root);
  const sync = mock.method(fs, 'readdirSync');
  const async = mock.method(fsPromises, 'readdir');
  syncBuiltinESMExports();
  t.after(() => {
    sync.mock.restore();
    async.mock.restore();
    syncBuiltinESMExports();
  });
  return {
    sync: () => sync.mock.calls.filter((call) => inRoot(call.arguments[0])).length,
    async: () => async.mock.calls.filter((call) => inRoot(call.arguments[0])).length,
  };
}

async function settle(read, predicate) {
  for (let i = 0; i < 500; i += 1) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return read();
}

test('many sessions share one agent scan per interval and pick up an added agent', async (t) => {
  const { root, data, helpers } = fixture(t);
  const scans = spyScans(t, root);
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  t.after(() => mock.timers.reset());
  const config = {};
  const sessions = Array.from({ length: 32 }, helpers);

  for (let tick = 0; tick < 3; tick += 1) {
    for (const session of sessions) {
      assert.deepEqual(session.delegatableAgentIds(config, data), ['worker', 'reviewer']);
    }
  }
  assert.equal(scans.sync(), 2, 'one cold scan (user + shipped root) for all 32 sessions');
  assert.equal(scans.async(), 0);

  writeAgent(root, 'writer-two');
  for (const session of sessions) {
    assert.equal(session.delegatableAgentIds(config, data).includes('writer-two'), false, 'served from cache');
  }
  assert.equal(scans.sync(), 2);

  mock.timers.tick(AGENT_LIST_REVALIDATE_MS);
  for (const session of sessions) {
    // Stale-while-revalidate: the tick returns at once with the cached list.
    assert.equal(session.delegatableAgentIds(config, data).includes('writer-two'), false);
  }
  const updated = await settle(
    () => sessions[0].delegatableAgentIds(config, data),
    (ids) => ids.includes('writer-two')
  );
  assert.deepEqual(updated, ['worker', 'reviewer', 'writer-two']);
  for (const session of sessions) assert.deepEqual(session.delegatableAgentIds(config, data), updated);
  assert.equal(scans.async(), 2, 'one background scan (user + shipped root) for all 32 sessions');
  assert.equal(scans.sync(), 2, 'revalidation never scans on the caller stack');
});

test('removed agents drop out after the interval; explicit listings refresh the shared list at once', async (t) => {
  const { root, data, helpers } = fixture(t);
  mock.timers.enable({ apis: ['Date'], now: 2_000_000 });
  t.after(() => mock.timers.reset());
  const session = helpers();
  assert.deepEqual(session.delegatableAgentIds({}, data), ['worker', 'reviewer']);

  rmSync(join(root, 'agents', 'reviewer'), { recursive: true, force: true });
  mock.timers.tick(AGENT_LIST_REVALIDATE_MS);
  session.delegatableAgentIds({}, data);
  const afterRemoval = await settle(
    () => session.delegatableAgentIds({}, data),
    (ids) => !ids.includes('reviewer')
  );
  assert.deepEqual(afterRemoval, ['worker']);

  // Editor/onboarding listings scan fresh and republish for the pulse.
  writeAgent(data, 'mine');
  assert.deepEqual(session.listCustomAgentIds(data), ['worker', 'mine']);
  assert.deepEqual(session.delegatableAgentIds({}, data), ['worker', 'mine']);
  assert.deepEqual(session.delegatableAgentIds({ disabledAgents: ['mine'] }, data), ['worker']);
});

test('the hidden-agent registry revalidates with stats only, never re-reading agents.json', (t) => {
  assert.equal(isHiddenAgent('worker'), false);
  const read = mock.method(fs, 'readFileSync');
  syncBuiltinESMExports();
  t.after(() => {
    read.mock.restore();
    syncBuiltinESMExports();
  });
  for (let i = 0; i < 50; i += 1) isHiddenAgent('worker');
  assert.equal(read.mock.callCount(), 0);
});
