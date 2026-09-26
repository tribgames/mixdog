import assert from 'node:assert/strict';
import test from 'node:test';
import { createProgressWatchdogRegistry, getProgressWatchdogState } from './agent-watchdog-registry.mjs';
import { buildAgentTaskProgressFields } from './agent-task-status.mjs';
import { createAgentTree } from './session-service/agent-tree.mjs';

const policy = { firstTransportMs: 120000, firstSemanticMs: 600000, idleStaleMs: 315000 };

test('configured thresholds are not reported as an armed watchdog without registration', () => {
  const mgr = {};
  const watchdog = createProgressWatchdogRegistry({ mgr });
  assert.equal(watchdog.start('worker', policy), null);
  const fields = buildAgentTaskProgressFields({ policy, watchdogState: getProgressWatchdogState(mgr, 'worker') });
  assert.equal(fields.watchdog, 'not armed (no registered progress watchdog)');
});

test('canonical agent manager exposes actual progress and an unlinkable abort bridge', () => {
  const snapshot = { stage: 'resource_wait', lastProgressAt: 123, modelRequestStartedAt: 100 };
  const aborts = [];
  const runtime = { getTurnLiveness: () => snapshot, abort: (options) => aborts.push(options) };
  const tree = createAgentTree({ sessionOwner: () => ({ runtime }) });
  assert.equal(tree.agentManager.getSessionProgressSnapshot('worker'), snapshot);
  const parent = new AbortController();
  const unlink = tree.agentManager.linkParentSignalToSession('worker', parent.signal);
  parent.abort();
  assert.deepEqual(aborts, [{ restorePrompt: false, reason: 'agent-watchdog' }]);
  unlink();
  const detached = new AbortController();
  tree.agentManager.linkParentSignalToSession('worker', detached.signal)();
  detached.abort();
  assert.equal(aborts.length, 1);
});

test('a session whose runtime loads after the turn starts is linked on a later sweep', async () => {
  let runtimeLoaded = false;
  let linked = 0;
  const mgr = {
    getSessionProgressSnapshot: () => null,
    linkParentSignalToSession: () => {
      if (!runtimeLoaded) throw new Error('agent runtime cannot abort session worker');
      linked += 1;
      return () => {};
    },
  };
  const registry = createProgressWatchdogRegistry({ mgr });
  const handle = registry.start('worker', policy);
  assert.notEqual(handle, null, 'an unloaded runtime still gets a watchdog');
  assert.equal(getProgressWatchdogState(mgr, 'worker').registered, false, 'not armed until linked');
  runtimeLoaded = true;
  for (const deadline = Date.now() + 5000; linked === 0 && Date.now() < deadline; ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(linked, 1);
  assert.equal(getProgressWatchdogState(mgr, 'worker').registered, true);
  handle.stop();
  assert.equal(getProgressWatchdogState(mgr, 'worker').registered, false);
});

test('stopping a registered watchdog clears its state and abort listener', () => {
  let unlinked = 0;
  const mgr = {
    getSessionProgressSnapshot: () => null,
    linkParentSignalToSession: () => () => {
      unlinked += 1;
    },
  };
  const registry = createProgressWatchdogRegistry({ mgr });
  const handle = registry.start('worker', policy);
  assert.equal(getProgressWatchdogState(mgr, 'worker').registered, true);
  assert.match(
    buildAgentTaskProgressFields({
      policy,
      watchdogState: getProgressWatchdogState(mgr, 'worker'),
    }).watchdog,
    /^armed /
  );
  handle.stop();
  assert.equal(getProgressWatchdogState(mgr, 'worker').registered, false);
  assert.equal(unlinked, 1);
});
