import assert from 'node:assert/strict';
import test from 'node:test';
import { createComputerPresence } from './mirror.ts';
import { computerUseCursorPresentations, computerUseOverlayPresentation } from '../overlay/model.ts';
import { ComputerUseCoordinator } from '../session/coordinator.ts';

const session = (id, extra = {}) => ({
  sessionThreadId: id,
  observeOnly: false,
  windowIds: [],
  mode: 'background',
  phase: 'active_background',
  ...extra,
});
const section = (sessions, extra = {}) => ({
  active: sessions.length > 0,
  observeOnly: false,
  controller: null,
  sessionThreadId: sessions[0]?.sessionThreadId ?? null,
  sessions,
  ...extra,
});
const move = (x = 10, y = 20, extra = {}) => ({ x, y, held: false, mode: 'background', phase: 'move', ...extra });

function rig(options = {}) {
  const released = [];
  const presence = createComputerPresence({ now: () => 7, notifyPointerReleased: (id) => released.push(id), ...options });
  return { presence, released };
}

test('a section value becomes activities, present sessions, windows and a revision per change', () => {
  const { presence } = rig();
  const seen = [];
  presence.subscribe((snapshot) => seen.push(snapshot.revision));
  presence.applySection(
    section([
      session('a', { windowIds: ['hwnd:0x1'] }),
      session('b', { observeOnly: true, mode: 'foreground', phase: 'active_foreground' }),
    ])
  );
  const snapshot = presence.snapshot();
  assert.deepEqual(snapshot.presentSessionIds, ['a', 'b']);
  assert.deepEqual(
    snapshot.activities.map((a) => [a.sessionId, a.action, a.mode, a.phase]),
    [
      ['a', 'control', 'background', 'active_background'],
      ['b', 'observe', 'foreground', 'active_foreground'],
    ]
  );
  assert.deepEqual(snapshot.targetLeases, [{ sessionId: 'a', windowId: 'hwnd:0x1', expiresAt: null }]);
  assert.deepEqual(presence.windowIdsWithActiveCommand(), ['hwnd:0x1']);
  presence.applySection(section([]));
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(presence.snapshot().presentSessionIds, []);
  assert.equal(presence.backend(), 'helper');
});

test('a core-driven session paints the arrow, which takes the rounded point and the phase effect', () => {
  const { presence } = rig();
  presence.applySection(section([session('a')]));
  presence.pointerProgress('a', move(10.4, 20.6, { phase: 'release', windowId: 'hwnd:0x3' }));
  const [cursor] = presence.snapshot().cursors;
  assert.deepEqual(
    [cursor.sessionId, cursor.x, cursor.y, cursor.effect, cursor.windowId, cursor.tracking],
    ['a', 10, 21, 'click', 'hwnd:0x3', true]
  );
  assert.equal(computerUseCursorPresentations(presence.snapshot()).length, 1);
  presence.pointerProgress('a', move(1, 2, { phase: 'scroll' }));
  assert.equal(presence.snapshot().cursors[0].effect, 'scroll');
  presence.pointerProgress('a', move(1, 2, { held: true }));
  assert.equal(presence.snapshot().cursors[0].effect, 'drag');
  presence.pointerProgress('a', move(1, 2));
  assert.equal(presence.snapshot().cursors[0].effect, 'move');
});

test('pointer progress is dropped for a takeover, a pending cleanup and a session without activity', () => {
  const { presence } = rig();
  presence.pointerProgress('ghost', move());
  presence.applySection(section([session('a')]));
  presence.pointerProgress('ghost', move());
  presence.applySection(section([session('a')], { cleanupState: 'pending' }));
  presence.pointerProgress('a', move());
  presence.applySection(
    section([session('a')], { userControl: { active: true, reason: 'user_pause', resumeMode: 'manual' } })
  );
  presence.pointerProgress('a', move());
  assert.deepEqual(presence.snapshot().cursors, []);
});

test('a finished command leaves no live pointer, and a command in another mode starts without the old arrow', () => {
  const { presence } = rig();
  presence.applySection(section([session('shared'), session('other')]));
  presence.pointerProgress('shared', move());
  presence.pointerProgress('other', move());
  presence.applySection(section([session('shared', { mode: null, phase: null }), session('other')]));
  const finished = presence.snapshot();
  assert.deepEqual(
    finished.cursors.map((c) => c.sessionId),
    ['other']
  );
  const thinking = finished.activities.find((a) => a.sessionId === 'shared');
  assert.equal(thinking.phase, 'thinking');
  assert.equal(thinking.mode, 'background');
  presence.applySection(
    section([
      session('shared', { mode: null, phase: null }),
      session('other', { mode: 'foreground', phase: 'active_foreground' }),
    ])
  );
  assert.deepEqual(presence.snapshot().cursors, []);
});

test('a pointer event after the section said no command runs is an active command, kept by later values', () => {
  const { presence } = rig();
  presence.applySection(section([session('a', { mode: null, phase: null }), session('b')]));
  presence.pointerProgress('a', move(1, 2, { mode: 'foreground' }));
  presence.applySection(section([session('a', { mode: null, phase: null }), session('b', { windowIds: ['w'] })]));
  const snapshot = presence.snapshot();
  assert.deepEqual(snapshot.cursors.map((c) => c.sessionId), ['a']);
  const active = snapshot.activities.find((a) => a.sessionId === 'a');
  assert.deepEqual([active.mode, active.phase], ['foreground', 'active_foreground']);
});

test('a session that leaves the section loses its arrow and its release', () => {
  const { presence } = rig();
  presence.applySection(section([session('a'), session('b')]));
  presence.pointerProgress('a', move());
  presence.releasePointer('b');
  presence.applySection(section([session('b')]));
  assert.deepEqual(presence.snapshot().cursors, []);
  assert.deepEqual(presence.snapshot().releasedPointerSessionIds, ['b']);
  presence.applySection(section([]));
  assert.deepEqual(presence.snapshot().releasedPointerSessionIds, []);
});

test('releasing the pointer hides the arrow until the next pointer event and tells the core once', () => {
  const { presence, released } = rig();
  presence.applySection(section([session('a')]));
  presence.pointerProgress('a', move());
  presence.releasePointer('a');
  presence.releasePointer('a');
  presence.releasePointer('nobody');
  assert.deepEqual(released, ['a']);
  assert.deepEqual(presence.snapshot().cursors, []);
  assert.deepEqual(presence.snapshot().releasedPointerSessionIds, ['a']);
  presence.pointerProgress('a', move());
  assert.deepEqual(presence.snapshot().releasedPointerSessionIds, []);
  assert.equal(presence.snapshot().cursors.length, 1);
});

test('a notification that throws does not undo the release', () => {
  const { presence } = rig({
    notifyPointerReleased: () => {
      throw new Error('closed');
    },
  });
  presence.applySection(section([session('a')]));
  presence.pointerProgress('a', move());
  presence.releasePointer('a');
  assert.deepEqual(presence.snapshot().releasedPointerSessionIds, ['a']);
});

test('a takeover pauses the sessions, removes every arrow and lets none back with the resume', () => {
  const { presence } = rig();
  presence.applySection(section([session('a')]));
  presence.pointerProgress('a', move());
  presence.applySection(
    section([session('a')], { userControl: { active: true, reason: 'emergency_shortcut', resumeMode: 'manual' } })
  );
  const held = presence.snapshot();
  assert.equal(held.userControlActive, true);
  assert.deepEqual(held.pausedSessionIds, ['a']);
  assert.equal(held.activities[0].phase, 'paused_user_takeover');
  assert.equal(computerUseOverlayPresentation(held).paused, true);
  presence.applySection(section([session('a')], { userControl: null }));
  assert.deepEqual(presence.snapshot().cursors, []);
});

test('a yield offers Resume only for a manual one, and the section idle seconds decide an automatic one', () => {
  const { presence } = rig();
  const yielded = (resumeMode, idleResumeSeconds) =>
    presence.applySection(
      section([session('a')], { idleResumeSeconds, userControl: { active: false, reason: 'user_input_active', resumeMode } })
    );
  yielded('idle', 5);
  assert.deepEqual([presence.snapshot().yieldedSessionIds, presence.snapshot().idleResumeSeconds], [['a'], 5]);
  assert.equal(computerUseOverlayPresentation(presence.snapshot()).resumable, false);
  yielded('manual', 5);
  assert.equal(presence.snapshot().idleResumeSeconds, 0);
  assert.equal(computerUseOverlayPresentation(presence.snapshot()).resumable, true);
  yielded('idle', 0);
  assert.equal(presence.snapshot().idleResumeSeconds, 0);
});

test('a cleanup latch is carried, and an idle section is settled', () => {
  const { presence } = rig();
  assert.equal(presence.snapshot().cleanupState, 'ready');
  presence.applySection(section([], { cleanupState: 'failed' }));
  assert.equal(presence.snapshot().cleanupState, 'failed');
  assert.equal(computerUseOverlayPresentation(presence.snapshot()).visible, true);
  presence.applySection(section([]));
  assert.equal(presence.snapshot().cleanupState, 'ready');
});

test('while the desktop host is the backend the in-process coordinator is the source of everything', () => {
  const coordinator = new ComputerUseCoordinator();
  const { presence, released } = rig({ coordinator });
  const seen = [];
  const off = presence.subscribe((snapshot) => seen.push(snapshot.presentSessionIds));
  presence.applySection(section([session('a')], { backend: 'desktopHost' }));
  assert.equal(presence.backend(), 'desktopHost');
  assert.deepEqual(presence.snapshot().presentSessionIds, []);
  coordinator.beginCommand({ sessionId: 'a', action: 'click', mode: 'background' });
  assert.deepEqual(presence.snapshot().presentSessionIds, ['a']);
  assert.deepEqual(seen.at(-1), ['a']);
  presence.pointerProgress('a', move(5, 6));
  assert.deepEqual(
    coordinator.snapshot().cursors.map((c) => [c.x, c.y]),
    [[5, 6]]
  );
  presence.pointerProgress('ghost', move());
  assert.equal(coordinator.snapshot().cursors.length, 1);
  assert.deepEqual(presence.windowIdsWithActiveCommand(), []);
  presence.releasePointer('a');
  assert.deepEqual(coordinator.snapshot().releasedPointerSessionIds, ['a']);
  assert.deepEqual(released, []);
  off();
  presence.applySection(section([session('a')]));
  assert.equal(presence.backend(), 'helper');
  assert.deepEqual(presence.snapshot().cursors, []);
  coordinator.reset();
});

test('the in-process coordinator is not listened to once the last subscriber has left', () => {
  const coordinator = new ComputerUseCoordinator();
  const { presence } = rig({ coordinator });
  presence.applySection(section([], { backend: 'desktopHost' }));
  let calls = 0;
  const off = presence.subscribe(() => {
    calls += 1;
  });
  off();
  coordinator.beginCommand({ sessionId: 'x', action: 'click', mode: 'background' });
  assert.equal(calls, 0);
  coordinator.reset();
});
