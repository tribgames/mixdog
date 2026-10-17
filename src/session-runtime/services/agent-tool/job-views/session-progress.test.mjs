import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionProgress } from './session-progress.mjs';
import { createProgressWatchdogRegistry } from '../../agent-watchdog-registry.mjs';
import { resolveAgentWatchdogPolicy } from '../../../../runtime/agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';

test('the agent status names the model-thinking wait while the sent request has no headers', () => {
  const now = Date.now();
  const snapshot = {
    stage: 'requesting',
    modelRequestStartedAt: now - 1000,
    requestSentAt: now - 900,
    awaitingModelResponse: true,
    waitingForTransport: true,
    waitingForFirstSemantic: true,
  };
  const mgr = { getSession: () => ({ status: 'running' }), getSessionProgressSnapshot: () => snapshot };
  const fields = createSessionProgress({ mgr }).sessionProgressExtras('child', 'worker', now);
  assert.equal(fields.worker_stage, 'requesting');
  assert.equal(fields.last_progress, 'model thinking (request sent; awaiting response headers)');
  assert.equal(fields.diagnostic, 'model thinking; request sent, response headers pending');
});

test('the status view shows the armed first-transport deadline, not the role default', () => {
  const now = Date.now();
  const snapshot = {
    stage: 'requesting',
    modelRequestStartedAt: now - 1000,
    waitingForTransport: true,
    waitingForFirstSemantic: true,
  };
  const mgr = {
    getSession: () => ({ status: 'running', agent: 'art-director' }),
    getSessionProgressSnapshot: () => snapshot,
    linkParentSignalToSession: () => () => {},
  };
  const views = createSessionProgress({ mgr });
  // No armed watchdog: the role default.
  const unarmed = views.sessionProgressExtras('child', 'art-director', now);
  assert.doesNotMatch(String(unarmed.watchdog), /transport=481s/);

  const policy = resolveAgentWatchdogPolicy('art-director', { providerFirstByteTimeoutMs: 466_000 });
  const handle = createProgressWatchdogRegistry({ mgr }).start('child', policy, 'art-director');
  try {
    assert.equal(views.sessionProgressExtras('child', 'art-director', now).watchdog, 'armed transport=481s');
  } finally {
    handle.stop();
  }
});
