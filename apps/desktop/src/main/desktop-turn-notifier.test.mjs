import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createDesktopTurnNotifier } from './desktop-turn-notifier.ts';
import { agentHomeName } from './browser/approval-requester.ts';
import { sessionFinalAnswer } from './session-final-answer.ts';
import { restoreTranscriptItems } from '../../../../src/runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import { notificationPreview } from './notification-preview.ts';
import { openDesktopNotificationSession } from './notification-window.ts';
import { DESKTOP_IPC } from '../shared/contract-ipc.ts';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../shared/contract-notifications.ts';

function harness(t, extraOptions = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  // `onScreen`: the sessions the focused window actually shows. `preferences`
  // and `overrides`: this PC's, as the window reads them per notification.
  const state = {
    onScreen: new Set(),
    preferences: DEFAULT_NOTIFICATION_PREFERENCES,
    overrides: [],
    supported: true,
    failure: '',
    pending: false,
    failed: false,
    // A read error of the preferences file, thrown while set.
    unreadable: '',
  };
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
    preferences: () => {
      if (state.unreadable) throw new Error(state.unreadable);
      return { preferences: state.preferences, overrides: state.overrides };
    },
    isSupported: () => state.supported,
    isSessionOnScreen: (sessionId) => state.onScreen.has(sessionId),
    readFinalAnswer: async (_id, since) => {
      if (state.pending) return null;
      if (state.failed) return { id: 'turn', at: Date.now(), status: 'failed', text: '' };
      return sessionFinalAnswer({ items, busy: false }, since);
    },
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
  const finish = (extra = {}, id = 'a') => {
    notifier.onSessions([{ id, title: 'Task', working: true, ...extra }]);
    notifier.onSessions([{ id, title: 'Task', ...extra }]);
  };
  // One roster holding every session, as the real roster does.
  const finishAll = (ids) => {
    notifier.onSessions(ids.map((id) => ({ id, title: 'Task', working: true })));
    notifier.onSessions(ids.map((id) => ({ id, title: 'Task' })));
  };
  const tick = async (ms = 2_500) => {
    t.mock.timers.tick(ms);
    // Reads are serialized, so several sessions need more than two hops.
    for (let hop = 0; hop < 20; hop++) await Promise.resolve();
  };
  return { notifier, state, notifications, events, opened, finish, finishAll, tick };
}

test('a session titled by attachments alone is notified with its kind in this PC’s language', async (t) => {
  const h = harness(t, { titleLabels: () => ({ image: '이미지', video: '영상', file: '파일' }) });
  h.finish({ title: '[Image]' });
  await h.tick(300);
  assert.equal(h.notifications[0].content.title, '이미지');
});

test('without labels an attachment-only title is notified in English', async (t) => {
  const h = harness(t);
  h.finish({ title: '[Video]' });
  await h.tick(300);
  assert.equal(h.notifications[0].content.title, 'Video');
});

test('a bot’s home chat is notified under the bot’s name, a rename included; a room under its room name', async (t) => {
  const catalog = [
    { id: 'secretary', custom: true, kind: 'bot', label: '비서' },
    { id: 'pm', custom: true, kind: 'bot', label: '개발 PM', definition: { name: '새 이름' } },
  ];
  const h = harness(t, { agentName: async (id) => agentHomeName(catalog, id) });
  const roster = [
    { id: 'bot-a', title: '', agentHome: 'secretary' },
    { id: 'bot-b', title: '', agentHome: 'pm' },
    { id: 'room-a', title: '', agentRoom: { name: '기획 회의' } },
    { id: 'code-a', title: 'Fix the bug' },
  ];
  h.notifier.onSessions(roster.map((row) => ({ ...row, working: true })));
  h.notifier.onSessions(roster);
  await h.tick(300);
  const titles = h.notifications.map((n) => n.content.title).sort();
  assert.deepEqual(titles, ['Fix the bug', '기획 회의', '비서', '새 이름'].sort());
});

for (const [leadName, expected] of [
  ['', 'Mixy'],
  ['미식이', '미식이'],
]) {
  test(`Mixy’s home chat is notified as “${expected}” (identity name “${leadName}”)`, async (t) => {
    const h = harness(t, { agentName: async (id) => agentHomeName([], id, leadName) });
    h.finish({ title: '', agentHome: 'lead' });
    await h.tick(300);
    assert.equal(h.notifications[0].content.title, expected);
  });
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

for (const mode of ['foreground-visible', 'scope', 'unsupported']) {
  test(`${mode} produces an explicit suppression, not a claimed native delivery`, async (t) => {
    const h = harness(t);
    if (mode === 'foreground-visible') h.state.onScreen.add('a');
    if (mode === 'scope') h.state.preferences = { ...DEFAULT_NOTIFICATION_PREFERENCES, scope: 'off' };
    if (mode === 'unsupported') h.state.supported = false;
    h.finish();
    await h.tick();
    assert.equal(h.notifications.length, 0);
    assert.ok(h.events.some((event) => event.event === 'suppressed' && event.reason === mode));
  });
}

test('this PC’s preferences decide at delivery: bot chats only, a muted bot, quiet hours', async (t) => {
  const h = harness(t);
  h.state.preferences = { ...DEFAULT_NOTIFICATION_PREFERENCES, scope: 'bots' };
  const roster = [
    { id: 'code', title: 'Task' },
    { id: 'home', title: 'Home', agentHome: 'gh' },
    { id: 'muted-home', title: 'Rel', agentHome: 'rel' },
  ];
  h.notifier.onSessions(roster.map((row) => ({ ...row, working: true })));
  h.notifier.onSessions(roster);
  h.state.overrides = [{ target: { kind: 'agent', id: 'rel' }, setting: { mode: 'muted', until: null } }];
  await h.tick();
  assert.deepEqual(
    h.notifications.map((n) => n.content.title),
    ['Home']
  );
  assert.deepEqual(
    h.events.filter((row) => row.event === 'suppressed').map((row) => [row.sessionId, row.reason]),
    [
      ['code', 'scope'],
      ['muted-home', 'muted'],
    ]
  );
});

test('an "always" conversation notifies even with this PC’s notifications off', async (t) => {
  const h = harness(t);
  h.state.preferences = { ...DEFAULT_NOTIFICATION_PREFERENCES, scope: 'off' };
  h.state.overrides = [{ target: { kind: 'session', id: 'a' }, setting: { mode: 'always' } }];
  h.finish();
  await h.tick();
  assert.equal(h.notifications.length, 1);
});

test('a failed turn notifies only with errors on, in this PC’s words', async (t) => {
  const h = harness(t, { turnFailedText: () => '오류로 멈췄습니다.' });
  h.state.failed = true;
  h.finish();
  await h.tick();
  assert.equal(h.notifications.length, 0, 'errors are off by default');
  assert.ok(h.events.some((row) => row.reason === 'event'));
  h.state.preferences = {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    events: { ...DEFAULT_NOTIFICATION_PREFERENCES.events, error: true },
  };
  h.finish();
  await h.tick();
  assert.deepEqual(h.notifications[0].content, { title: 'Task', body: '오류로 멈췄습니다.' });
});

test('a focused window showing session A does not suppress session B’s completion', async (t) => {
  const h = harness(t);
  h.state.onScreen.add('a');
  h.finishAll(['a', 'b']);
  await h.tick();
  assert.equal(h.notifications.length, 1, 'only B notifies; A, on screen, stays suppressed');
  h.notifications[0].emit('click');
  assert.deepEqual(h.opened, ['b']);
  const suppressed = h.events.filter((event) => event.event === 'suppressed');
  assert.deepEqual(
    suppressed.map((event) => [event.sessionId, event.reason]),
    [['a', 'foreground-visible']]
  );
});

test('every split pane session stays suppressed while a background session notifies', async (t) => {
  const h = harness(t);
  h.state.onScreen.add('left').add('right');
  h.finishAll(['left', 'right', 'tab']);
  await h.tick();
  assert.equal(h.notifications.length, 1);
  assert.equal(h.events.filter((event) => event.reason === 'foreground-visible').length, 2);
});

test('a window that is focused but minimized or hidden shows nothing, so the completion notifies', async (t) => {
  const h = harness(t);
  // The wiring reports an empty on-screen set for such a window.
  h.finish();
  await h.tick();
  assert.equal(h.notifications.length, 1);
});

for (const sourceType of ['schedule', 'webhook']) {
  test(`a ${sourceType} run still notifies on screen`, async (t) => {
    const h = harness(t);
    h.state.onScreen.add('a');
    h.finish({ sourceType });
    await h.tick();
    assert.equal(h.notifications.length, 1);
  });
}

test('on-screen state is rechecked at native delivery, including return during the quiet period', async (t) => {
  const h = harness(t);
  h.finish();
  h.state.onScreen.add('a');
  await h.tick();
  assert.equal(h.notifications.length, 0);
  assert.equal(h.events.at(-1).reason, 'foreground-visible');
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
  assert.equal(notificationPreview(`**${'a'.repeat(161)}**`), `${'a'.repeat(159)}…`);
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
    if (mode === 'foreground') h.state.onScreen.add('a');
    if (mode === 'disabled') h.state.preferences = { ...DEFAULT_NOTIFICATION_PREFERENCES, scope: 'off' };
    if (mode === 'show') h.state.failure = 'show';
    h.finish();
    await h.tick();
    assert.equal(sounds, 0);
  });
}

// Waits: a session that starts waiting on a tool approval or a question.
const waiting = (sessionId, toolApproval, frameSource = 'live') => ({
  sessionId,
  frameSource,
  snapshot: { toolApproval },
});
const WAITING_KO = { approval: '승인을 기다리고 있습니다.', question: '답변을 기다리고 있습니다.' };
const shell = { id: 'a1', kind: 'approval', name: 'shell', args: { command: 'npm test' } };
function waitHarness(t, extra = {}) {
  const h = harness(t, { waitingText: (wait) => WAITING_KO[wait], agentName: async () => '비서', ...extra });
  h.notifier.onSessions([
    { id: 'code', title: 'Fix the bug' },
    { id: 'home', title: '', agentHome: 'secretary' },
    { id: 'task', title: 'Release notes' },
  ]);
  return h;
}

test('an unfocused session’s approval and question notify in this PC’s words, and a click opens that session', async (t) => {
  const h = waitHarness(t);
  h.notifier.onSessionState(waiting('code', shell));
  h.notifier.onSessionState(waiting('home', { id: 'q1', kind: 'question' }));
  await h.tick(0);
  assert.deepEqual(
    h.notifications.map((n) => n.content).sort((a, b) => (a.title < b.title ? -1 : 1)),
    [
      { title: 'Fix the bug · 승인을 기다리고 있습니다.', body: '' },
      { title: '비서 · 답변을 기다리고 있습니다.', body: '' },
    ]
  );
  for (const notification of h.notifications) notification.emit('click');
  assert.deepEqual(h.opened.sort(), ['code', 'home']);
});

test('without words of its own a wait notification speaks English', async (t) => {
  const h = waitHarness(t, { waitingText: undefined });
  h.notifier.onSessionState(waiting('code', shell));
  h.notifier.onSessionState(waiting('task', { id: 'q1', kind: 'question' }));
  await h.tick(0);
  assert.deepEqual(h.notifications.map((n) => n.content.title).sort(), [
    'Fix the bug · Waiting for your approval.',
    'Release notes · Waiting for your answer.',
  ]);
});

for (const mode of ['muted', 'quiet-hours', 'foreground-visible', 'event']) {
  test(`a waiting approval is not notified when ${mode}`, async (t) => {
    const h = waitHarness(t);
    if (mode === 'muted') {
      h.state.overrides = [{ target: { kind: 'session', id: 'code' }, setting: { mode: 'muted', until: null } }];
    }
    if (mode === 'quiet-hours') {
      h.state.preferences = {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        quietHours: { enabled: true, start: '00:00', end: '23:59', days: 'every', allowWaiting: false },
      };
    }
    if (mode === 'foreground-visible') h.state.onScreen.add('code');
    if (mode === 'event') {
      h.state.preferences = {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        events: { ...DEFAULT_NOTIFICATION_PREFERENCES.events, approval: false },
      };
    }
    h.notifier.onSessionState(waiting('code', shell));
    await h.tick(0);
    assert.equal(h.notifications.length, 0);
    assert.ok(h.events.some((row) => row.event === 'suppressed' && row.sessionId === 'code' && row.reason === mode));
  });
}

test('an approval docked in every chat a hand-off reaches is one notification, not one per copy', async (t) => {
  const h = waitHarness(t);
  const ask = { ...shell, sessionId: 'task' };
  const copy = (chat) => ({ ...ask, surfaceSessionId: chat, handoff: { title: 'Release notes' } });
  h.notifier.onSessionState(waiting('task', ask));
  h.notifier.onSessionState(waiting('home', copy('home')));
  h.notifier.onSessionState(waiting('code', copy('code')));
  h.notifier.onSessionState(waiting('task', ask));
  h.notifier.onSessionState(waiting('home', copy('home'), 'replay'));
  await h.tick(0);
  assert.equal(h.notifications.length, 1);
  // Settled everywhere: the next approval of that session is a new wait.
  for (const id of ['task', 'home', 'code']) h.notifier.onSessionState(waiting(id, null));
  h.notifier.onSessionState(waiting('task', { ...ask, id: 'a2' }));
  await h.tick(0);
  assert.equal(h.notifications.length, 2);
});

test('a sub-agent’s approval is told as, and opens, the chat it shows in', async (t) => {
  const h = waitHarness(t);
  h.notifier.onSessionState(
    waiting('sub', { ...shell, sessionId: 'sub', surfaceSessionId: 'code', chain: ['Lead', 'Worker'] })
  );
  await h.tick(0);
  assert.equal(h.notifications[0].content.title, 'Fix the bug · 승인을 기다리고 있습니다.');
  h.notifications[0].emit('click');
  assert.deepEqual(h.opened, ['code']);
});

test('a replayed wait is not a new one', async (t) => {
  const h = waitHarness(t);
  h.notifier.onSessionState(waiting('code', shell, 'replay'));
  h.notifier.onSessionState(waiting('code', shell));
  await h.tick(0);
  assert.equal(h.notifications.length, 0);
});

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

// Unreadable preferences (notification-preferences.ts throws any read error
// but a missing file): reported, nothing sent, nothing marked as told.
const UNREADABLE = 'EACCES: permission denied';
const readFailures = (h) => h.events.filter((row) => row.event === 'preferences-read-failed');

test('a completion whose preferences cannot be read is reported, held, and notified once when they can be', async (t) => {
  const h = harness(t);
  h.state.unreadable = UNREADABLE;
  h.finish();
  await h.tick();
  assert.equal(h.notifications.length, 0);
  assert.deepEqual(
    readFailures(h).map((row) => [row.sessionId, row.error]),
    [['a', UNREADABLE]]
  );
  assert.ok(!h.events.some((row) => row.event === 'requested'));
  // The next roster event decides again; still unreadable: reported, still held.
  h.notifier.onSessions([{ id: 'a', title: 'Task' }]);
  assert.equal(readFailures(h).length, 2);
  assert.equal(h.notifications.length, 0);
  h.state.unreadable = '';
  h.notifier.onSessions([{ id: 'a', title: 'Task' }]);
  assert.equal(h.notifications.length, 1);
  assert.deepEqual(h.notifications[0].content, { title: 'Task', body: '검사 완료: file.ts' });
  h.notifier.onSessions([{ id: 'a', title: 'Task' }]);
  await h.tick(5_000);
  assert.equal(h.notifications.length, 1);
  assert.equal(readFailures(h).length, 2);
});

test('a held completion is dropped when its session starts another turn', async (t) => {
  const h = harness(t);
  h.state.unreadable = UNREADABLE;
  h.finish();
  await h.tick();
  assert.equal(readFailures(h).length, 1);
  h.notifier.onSessions([{ id: 'a', title: 'Task', working: true }]);
  assert.ok(h.events.some((row) => row.event === 'cancelled' && row.reason === 'state-changed'));
  h.state.unreadable = '';
  h.notifier.onSessions([{ id: 'a', title: 'Task' }]);
  assert.equal(h.notifications.length, 0, 'the old turn is not offered again');
  assert.equal(readFailures(h).length, 1);
  await h.tick();
  assert.equal(h.events.filter((row) => row.event === 'detected').length, 2, 'the new turn is followed on its own');
  assert.equal(h.notifications.length, 0, 'the old turn’s answer is not told for it');
});

for (const [kind, ask, text] of [
  ['approval', shell, 'Fix the bug · 승인을 기다리고 있습니다.'],
  ['question', { id: 'q1', kind: 'question' }, 'Fix the bug · 답변을 기다리고 있습니다.'],
]) {
  test(`a ${kind} whose preferences cannot be read is reported, not told, and notified once on its next update after recovery`, async (t) => {
    const h = waitHarness(t);
    h.state.unreadable = UNREADABLE;
    h.notifier.onSessionState(waiting('code', ask));
    await h.tick(0);
    assert.equal(h.notifications.length, 0);
    assert.deepEqual(
      readFailures(h).map((row) => [row.sessionId, row.wait, row.error]),
      [['code', kind, UNREADABLE]]
    );
    // A replay is no new wait, and the next live update decides again.
    h.notifier.onSessionState(waiting('code', ask, 'replay'));
    h.notifier.onSessionState(waiting('code', ask));
    assert.equal(readFailures(h).length, 2, 'still unreadable: reported again, still not told');
    h.state.unreadable = '';
    h.notifier.onSessionState(waiting('code', ask));
    await h.tick(0);
    assert.equal(h.notifications.length, 1);
    assert.equal(h.notifications[0].content.title, text);
    h.notifier.onSessionState(waiting('code', ask));
    await h.tick(0);
    assert.equal(h.notifications.length, 1);
    assert.equal(readFailures(h).length, 2);
  });
}

test('an unreadable approval settled before preferences recover is forgotten, not told later', async (t) => {
  const h = waitHarness(t);
  h.state.unreadable = UNREADABLE;
  h.notifier.onSessionState(waiting('code', shell));
  h.notifier.onSessionState(waiting('code', null));
  h.state.unreadable = '';
  h.notifier.onSessionState(waiting('code', null));
  await h.tick(0);
  assert.equal(h.notifications.length, 0);
  // The same id asked again is a new wait, decided afresh.
  h.notifier.onSessionState(waiting('code', shell));
  await h.tick(0);
  assert.equal(h.notifications.length, 1);
});
