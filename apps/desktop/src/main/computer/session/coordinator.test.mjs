import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ComputerUseCoordinator,
  computerResultHasCode,
  queuedForegroundRequiresRecapture,
} from './coordinator';
import {
  computerUseCursorPresentations,
  computerUseOverlayPresentation,
} from '../overlay/model';

function begin(
  coordinator,
  sessionId,
  mode = 'background',
  action = 'click',
) {
  coordinator.beginCommand({
    sessionId,
    action,
    target: 'Target app',
    mode,
  });
}

test('different target windows can be leased concurrently by different sessions', async () => {
  const coordinator = new ComputerUseCoordinator();
  try {
    begin(coordinator, 'session-a');
    begin(coordinator, 'session-b');
    const [left, right] = await Promise.all([
      coordinator.acquireTargets('session-a', ['window-a']),
      coordinator.acquireTargets('session-b', ['window-b']),
    ]);
    assert.equal(left.status, 'acquired');
    assert.equal(right.status, 'acquired');
    assert.deepEqual(
      coordinator.snapshot().targetLeases.map((lease) => lease.windowId).sort(),
      ['window-a', 'window-b'],
    );
  } finally {
    coordinator.reset();
  }
});

test('same-target contention queues the lease and requires a fresh action after grant', async () => {
  const coordinator = new ComputerUseCoordinator({ targetLeaseWaitMs: 1_000 });
  try {
    begin(coordinator, 'session-owner');
    assert.deepEqual(
      await coordinator.acquireTargets('session-owner', ['window-shared']),
      {
        status: 'acquired',
        queued: false,
        waitedMs: 0,
        windowIds: ['window-shared'],
      },
    );
    coordinator.finishCommand('session-owner');

    begin(coordinator, 'session-waiter');
    const waiting = coordinator.acquireTargets('session-waiter', ['window-shared']);
    await Promise.resolve();
    const queued = coordinator.snapshot().activities.find(
      (activity) => activity.sessionId === 'session-waiter',
    );
    assert.equal(queued?.phase, 'queued_target');
    assert.equal(queued?.queuePosition, 1);

    coordinator.releaseTargets('session-owner');
    const granted = await waiting;
    assert.equal(granted.status, 'acquired');
    assert.equal(granted.queued, true);
    assert.equal(
      coordinator.snapshot().activities.find(
        (activity) => activity.sessionId === 'session-waiter',
      )?.phase,
      'awaiting_recapture',
    );
  } finally {
    coordinator.reset();
  }
});

test('expired continuation leases cannot pin a target for the worker idle lifetime', async () => {
  let now = 1_000;
  const coordinator = new ComputerUseCoordinator({
    now: () => now,
    targetLeaseGraceMs: 10,
  });
  try {
    begin(coordinator, 'session-old');
    await coordinator.acquireTargets('session-old', ['window-shared']);
    coordinator.finishCommand('session-old');
    now += 11;

    begin(coordinator, 'session-new');
    const acquired = await coordinator.acquireTargets('session-new', ['window-shared']);
    assert.equal(acquired.status, 'acquired');
    assert.equal(acquired.queued, false);
    assert.equal(coordinator.snapshot().targetLeases[0]?.sessionId, 'session-new');
  } finally {
    coordinator.reset();
  }
});

test('user takeover cancels target waiters, clears leases, and blocks automation until resume', async () => {
  const coordinator = new ComputerUseCoordinator({ targetLeaseWaitMs: 1_000 });
  try {
    begin(coordinator, 'session-owner', 'foreground');
    await coordinator.acquireTargets('session-owner', ['window-shared']);
    begin(coordinator, 'session-waiter');
    const waiting = coordinator.acquireTargets('session-waiter', ['window-shared']);
    await Promise.resolve();

    const pausedSessions = coordinator.pauseForUser('emergency_shortcut');
    assert.deepEqual(pausedSessions.sort(), ['session-owner', 'session-waiter']);
    assert.equal((await waiting).status, 'user_takeover');
    assert.equal(coordinator.snapshot().targetLeases.length, 0);
    assert.ok(
      coordinator.snapshot().activities.every(
        (activity) => activity.phase === 'paused_user_takeover',
      ),
    );
    assert.throws(
      () => begin(coordinator, 'session-blocked'),
      /computer_user_control_active/,
    );

    coordinator.resumeAfterUserTakeover();
    begin(coordinator, 'session-resumed');
    assert.ok(
      coordinator.snapshot().activities.some(
        (activity) => activity.sessionId === 'session-resumed',
      ),
    );
  } finally {
    coordinator.reset();
  }
});

test('overlay model keeps one simple global state and becomes interactive after takeover', () => {
  const coordinator = new ComputerUseCoordinator();
  try {
    begin(coordinator, 'session-foreground', 'foreground', 'type');
    const active = computerUseOverlayPresentation(coordinator.snapshot(), 'en');
    assert.equal(active.visible, true);
    assert.equal(active.state, 'in_use');
    assert.equal(active.interactive, false);
    assert.equal(active.title, 'Mixdog in use');
    assert.equal(active.showTakeover, false);
    assert.equal(active.showStopSession, false);

    coordinator.finishCommand('session-foreground');
    const thinking = computerUseOverlayPresentation(coordinator.snapshot(), 'en');
    assert.equal(thinking.interactive, true);
    assert.deepEqual(thinking.chips, ['Target app', 'Foreground']);

    coordinator.requestAttention({
      sessionId: 'session-foreground',
      detail: 'Approve the requested action',
    });
    const attention = computerUseOverlayPresentation(coordinator.snapshot(), 'en');
    assert.equal(attention.state, 'attention_required');
    assert.equal(attention.title, 'Action required');
    assert.deepEqual(attention.chips, ['Approve the requested action']);
    coordinator.clearAttention('session-foreground');

    coordinator.pauseForUser('emergency_shortcut');
    const paused = computerUseOverlayPresentation(coordinator.snapshot(), 'ko-KR');
    assert.equal(paused.interactive, true);
    assert.equal(paused.state, 'user_control');
    assert.equal(paused.showResume, true);
    assert.match(paused.title, /사용자가 제어 중/);
  } finally {
    coordinator.reset();
  }
});

test('execution stays visible between commands and disappears only on explicit end', () => {
  const coordinator = new ComputerUseCoordinator();
  try {
    begin(coordinator, 'session-lifecycle', 'background', 'capture');
    coordinator.finishCommand('session-lifecycle');
    const thinking = coordinator.snapshot();
    assert.equal(thinking.activities[0]?.phase, 'thinking');
    assert.equal(computerUseOverlayPresentation(thinking, 'ko-KR').visible, true);

    coordinator.endExecution('session-lifecycle');
    const ended = coordinator.snapshot();
    assert.equal(ended.activities.length, 0);
    assert.equal(ended.cursors.length, 0);
    assert.equal(computerUseOverlayPresentation(ended, 'ko-KR').visible, false);
  } finally {
    coordinator.reset();
  }
});

test('session cursor state carries exact points and is removed by takeover cleanup', () => {
  const coordinator = new ComputerUseCoordinator();
  try {
    begin(coordinator, 'session-cursor', 'background', 'drag');
    coordinator.showCursor({
      sessionId: 'session-cursor',
      x: 120,
      y: 240,
      toX: 420,
      toY: 440,
      action: 'drag',
      effect: 'drag',
      mode: 'background',
    });
    const cursor = coordinator.snapshot().cursors[0];
    assert.deepEqual(
      {
        x: cursor?.x,
        y: cursor?.y,
        toX: cursor?.toX,
        toY: cursor?.toY,
        effect: cursor?.effect,
      },
      { x: 120, y: 240, toX: 420, toY: 440, effect: 'drag' },
    );
    assert.deepEqual(
      computerUseCursorPresentations(coordinator.snapshot()).map((entry) => ({
        badge: entry.badge,
        context: entry.context,
      })),
      [{ badge: 'Target app', context: 'Background' }],
    );

    coordinator.pauseForUser('emergency_shortcut');
    assert.equal(coordinator.snapshot().cursors.length, 0);
  } finally {
    coordinator.reset();
  }
});

test('only an explicit nested result code triggers foreground intervention', () => {
  assert.equal(
    computerResultHasCode(
      JSON.stringify({ actions: [{ code: 'foreground_changed' }] }),
      'foreground_changed',
    ),
    true,
  );
  assert.equal(
    computerResultHasCode(
      JSON.stringify({ text: 'the words foreground_changed are user content' }),
      'foreground_changed',
    ),
    false,
  );
  assert.equal(queuedForegroundRequiresRecapture(0), false);
  assert.equal(queuedForegroundRequiresRecapture(1), true);
});

test('the emergency shortcut is inert when no Computer Use session exists', () => {
  const coordinator = new ComputerUseCoordinator();
  try {
    assert.deepEqual(coordinator.pauseForUser('emergency_shortcut'), []);
    assert.equal(coordinator.snapshot().userControlActive, false);
    begin(coordinator, 'session-after-idle-shortcut');
    assert.equal(coordinator.snapshot().activities.length, 1);
  } finally {
    coordinator.reset();
  }
});

test('takeover can cancel a host-queued session before its activity begins', () => {
  const coordinator = new ComputerUseCoordinator();
  try {
    assert.deepEqual(
      coordinator.pauseForUser('emergency_shortcut', ['session-host-queued']),
      ['session-host-queued'],
    );
    assert.equal(coordinator.snapshot().userControlActive, true);
    assert.equal(
      coordinator.snapshot().activities[0]?.phase,
      'paused_user_takeover',
    );
  } finally {
    coordinator.reset();
  }
});
