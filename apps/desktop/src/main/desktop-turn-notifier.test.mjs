import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createDesktopTurnNotifier } from './desktop-turn-notifier.ts';
import { sessionFinalAnswer } from './session-final-answer.ts';
import { restoreTranscriptItems } from '../../../../src/runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import { notificationPreview } from './notification-preview.ts';
import { openDesktopNotificationSession } from './notification-window.ts';
import { DESKTOP_IPC } from '../shared/contract-ipc.ts';

function harness(t, extraOptions = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  const state = { foreground: false, enabled: true, supported: true, failure: '', pending: false };
  const notifications = [];
  const events = [];
  const opened = [];
  const items = restoreTranscriptItems([
    {
      role: 'assistant',
      content: '**검사 완료**: `file.ts`',
      meta: { transcript: { at: 2_000, completion: { status: 'done', elapsedMs: 1_000 } } },
    },
  ]);
  const notifier = createDesktopTurnNotifier({
    isEnabled: () => state.enabled,
    isSupported: () => state.supported,
    isForeground: () => state.foreground,
    readFinalAnswer: async (_id, since) => (state.pending ? null : sessionFinalAnswer({ items, busy: false }, since)),
    createNotification: (content) => {
      if (state.failure === 'construct') throw new Error('constructor failed');
      const notification = new EventEmitter();
      Object.assign(notification, {
        content,
        showCount: 0,
        closeCount: 0,
        show() {
          this.showCount++;
          if (state.failure === 'show') throw new Error('show failed');
          this.emit('show');
        },
        close() {
          this.closeCount++;
          this.emit('close');
        },
      });
      notifications.push(notification);
      return notification;
    },
    openSession: (id) => opened.push(id),
    diagnostic: (event, detail) => events.push({ event, ...detail }),
    ...extraOptions,
  });
  t.after(() => notifier.dispose());
  const finish = (extra = {}) => {
    notifier.onSessions([{ id: 'a', title: 'Task', working: true, ...extra }]);
    notifier.onSessions([{ id: 'a', title: 'Task', ...extra }]);
  };
  const tick = async (ms = 2_500) => {
    t.mock.timers.tick(ms);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { notifier, state, notifications, events, opened, finish, tick };
}

test('a restored background completion produces one native notification with plain text and opens its session', async (t) => {
  const h = harness(t);
  h.finish();
  await h.tick(299);
  assert.equal(h.notifications.length, 0);
  await h.tick(1);
  assert.deepEqual(h.notifications[0].content, { title: 'Task', body: '검사 완료: file.ts' });
  assert.equal(h.notifications[0].showCount, 1);
  h.notifier.onSessions([{ id: 'a', title: 'Task' }]);
  await h.tick(5_000);
  assert.equal(h.notifications.length, 1);
  h.notifications[0].emit('click');
  assert.deepEqual(h.opened, ['a']);
  assert.deepEqual(
    h.events.map((row) => row.event),
    ['detected', 'requested', 'os-show', 'clicked']
  );
});

for (const mode of ['foreground', 'disabled', 'unsupported']) {
  test(`${mode} produces an explicit suppression, not a claimed native delivery`, async (t) => {
    const h = harness(t);
    if (mode === 'foreground') h.state.foreground = true;
    if (mode === 'disabled') h.state.enabled = false;
    if (mode === 'unsupported') h.state.supported = false;
    h.finish();
    await h.tick();
    assert.equal(h.notifications.length, 0);
    assert.ok(h.events.some((event) => event.event === 'suppressed' && event.reason === mode));
  });
}

test('a schedule still notifies in the foreground', async (t) => {
  const h = harness(t);
  h.state.foreground = true;
  h.finish({ sourceType: 'schedule' });
  await h.tick();
  assert.equal(h.notifications.length, 1);
});

test('foreground is rechecked at native delivery, including return during the quiet period', async (t) => {
  const h = harness(t);
  h.finish();
  h.state.foreground = true;
  await h.tick();
  assert.equal(h.notifications.length, 0);
  assert.equal(h.events.at(-1).reason, 'foreground');
});

for (const failure of ['construct', 'show', 'native']) {
  test(`${failure} failure is reported without an unhandled exception or duplicate retry`, async (t) => {
    const h = harness(t);
    h.state.failure = failure;
    h.finish();
    await h.tick();
    if (failure === 'native') h.notifications[0].emit('failed', {}, 'native failed');
    assert.equal(h.events.at(-1).event, 'failed');
    assert.match(h.events.at(-1).error, /failed/);
    await h.tick(10_000);
    assert.ok(h.notifications.length <= 1);
  });
}

test('a late answer is retried, but its pending diagnostic is not spammed', async (t) => {
  const h = harness(t);
  h.state.pending = true;
  h.finish();
  await h.tick();
  await h.tick();
  assert.equal(h.events.filter((event) => event.event === 'waiting-answer').length, 1);
  h.state.pending = false;
  await h.tick();
  assert.equal(h.notifications.length, 1);
});

test('disposal cancels pending completions and closes retained native notifications', async (t) => {
  const h = harness(t);
  h.finish();
  await h.tick();
  h.notifier.dispose();
  assert.equal(h.notifications[0].closeCount, 1);
  await h.tick(10_000);
  assert.equal(h.notifications.length, 1);
});

test('notification text removes Markdown syntax without damaging paths, links or Unicode', () => {
  assert.equal(
    notificationPreview('# 완료\n\n**굵게**와 *강조*, `src/a_b.ts`\n- [결과](https://example.com)\n> 확인'),
    '완료 굵게와 강조, src/a_b.ts 결과 확인'
  );
  // Code and tables are not prose a banner can summarize.
  assert.equal(notificationPreview('![설명](image.png)\n\n```ts\nconst x = 1;\n```'), '설명');
  assert.equal(notificationPreview('결과입니다.\n\n| 이름 | 값 |\n|---|---|\n| a | 1 |'), '결과입니다.');
  // Hangul strong that CommonMark leaves unpaired still reads as plain text.
  assert.equal(
    notificationPreview('**VPS(폰에서 여는 웹앱):**는 바로 바뀝니다. **`v1.0.6`**로 올라갔습니다.'),
    'VPS(폰에서 여는 웹앱):는 바로 바뀝니다. v1.0.6로 올라갔습니다.'
  );
  // A long answer ends on its last whole sentence instead of mid-word.
  const sentence =
    '작업을 마쳤고 변경 사항을 모두 확인했습니다. 테스트도 통과했고 커밋 준비가 끝났습니다. 배포는 요청하실 때 바로 진행하겠습니다.';
  assert.equal(notificationPreview(`${sentence} ${'추가 설명이 계속 이어집니다 '.repeat(10)}`), sentence);
  assert.equal(notificationPreview('a_b_c & <https://example.com>'), 'a_b_c & https://example.com');
  assert.equal(notificationPreview('😀'.repeat(161)), `${'😀'.repeat(159)}…`);
  assert.equal(notificationPreview('**' + 'a'.repeat(161) + '**'), `${'a'.repeat(159)}…`);
});

for (const mode of ['hidden', 'minimized', 'visible']) {
  test(`a notification click restores/focuses the ${mode} window before sending the exact session`, () => {
    const calls = [];
    const window = {
      isDestroyed: () => false,
      isMinimized: () => mode === 'minimized',
      isVisible: () => mode !== 'hidden',
      restore: () => calls.push('restore'),
      show: () => calls.push('show'),
      focus: () => calls.push('focus'),
      webContents: {
        isDestroyed: () => false,
        send: (...args) => calls.push(args),
      },
    };
    assert.equal(openDesktopNotificationSession(window, 'exact-background-session'), true);
    assert.deepEqual(calls, [
      ...(mode === 'minimized' ? ['restore'] : []),
      ...(mode === 'hidden' ? ['show'] : []),
      'focus',
      [DESKTOP_IPC.notificationOpenSession, 'exact-background-session'],
    ]);
  });
}

test('closing a banner does not open or focus a session', async (t) => {
  const h = harness(t);
  h.finish();
  await h.tick();
  h.notifications[0].emit('close');
  assert.deepEqual(h.opened, []);
});

test('missing or destroyed windows reject notification navigation', () => {
  assert.equal(openDesktopNotificationSession(null, 'a'), false);
  assert.equal(openDesktopNotificationSession({ isDestroyed: () => true }, 'a'), false);
});

test('custom sound plays once on native show, never on foreground suppression or a failed show', async (t) => {
  let sounds = 0;
  const h = harness(t, {
    playSound: async () => {
      sounds++;
      return 'played';
    },
  });
  h.finish();
  await h.tick();
  h.notifications[0].emit('show');
  h.notifications[0].emit('click');
  h.notifications[0].emit('close');
  assert.equal(sounds, 1);
});

for (const mode of ['foreground', 'disabled', 'show']) {
  test(`${mode} does not play a completion sound`, async (t) => {
    let sounds = 0;
    const h = harness(t, {
      playSound: async () => {
        sounds++;
        return 'played';
      },
    });
    if (mode === 'foreground') h.state.foreground = true;
    if (mode === 'disabled') h.state.enabled = false;
    if (mode === 'show') h.state.failure = 'show';
    h.finish();
    await h.tick();
    assert.equal(sounds, 0);
  });
}

test('a sound failure leaves the native banner and click navigation intact', async (t) => {
  const h = harness(t, {
    playSound: async () => {
      throw new Error('audio unavailable');
    },
  });
  h.finish();
  await h.tick();
  await Promise.resolve();
  assert.ok(h.events.some((row) => row.event === 'sound-failed' && row.error === 'audio unavailable'));
  h.notifications[0].emit('click');
  assert.deepEqual(h.opened, ['a']);
});
