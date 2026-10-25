import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NEW_PHONE_NOTIFICATION_PREFERENCES,
} from '../shared/contract-notifications.ts';
import {
  activeOverrides,
  allowsDeviceNotice,
  allowsTaskbarFlash,
  conversationOverride,
  decideNotification,
  inQuietHours,
  notificationConversationOf,
} from './notification-decision.ts';

// Local-clock instants: 2026-10-23 is a Friday, 10-24 a Saturday, 10-26 a Monday.
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const FRIDAY_NOON = at(23, 12);

const coding = notificationConversationOf({ id: 'sess_desktop_a' });
const bot = notificationConversationOf({ id: 'sess_desktop_home', agentHome: 'secretary' });
const room = notificationConversationOf({ id: 'sess_desktop_room', agentRoom: { id: 'r1', name: 'Plan' } });
const task = notificationConversationOf({ id: 'sess_desktop_task', taskAgent: 'secretary', taskFrom: 'home' });
const run = notificationConversationOf({ id: 'sess_desktop_run', sessionMode: 'agent', sourceType: 'schedule' });

const prefs = (patch = {}) => ({
  ...DEFAULT_NOTIFICATION_PREFERENCES,
  ...patch,
  events: { ...DEFAULT_NOTIFICATION_PREFERENCES.events, ...patch.events },
  quietHours: { ...DEFAULT_NOTIFICATION_PREFERENCES.quietHours, ...patch.quietHours },
});
const decide = (input = {}) =>
  decideNotification({
    event: 'finished',
    conversation: coding,
    preferences: prefs(),
    overrides: [],
    now: FRIDAY_NOON,
    foreground: false,
    ...input,
  });
const quiet = (patch = {}) => prefs({ quietHours: { enabled: true, start: '23:00', end: '08:00', ...patch } });
const override = (kind, id, setting) => ({ target: { kind, id }, setting });

test('a session summary is classified as bot, room, task or coding, with its origin', () => {
  assert.deepEqual(bot, {
    sessionId: 'sess_desktop_home',
    kind: 'bot',
    origin: 'user',
    agentId: 'secretary',
    roomId: '',
  });
  assert.equal(room.kind, 'room');
  assert.equal(room.roomId, 'r1');
  assert.equal(task.kind, 'task', 'a bot-created task session is not a bot chat');
  assert.equal(task.agentId, '', 'a task is not one of the bot’s conversations');
  assert.equal(run.kind, 'task');
  assert.equal(run.origin, 'schedule');
  assert.equal(coding.kind, 'coding');
  assert.equal(notificationConversationOf({ id: 'x', sourceType: 'webhook' }).origin, 'webhook');
});

test('quiet hours: inside skips, outside notifies, an end before the start spans midnight', () => {
  const night = quiet();
  assert.equal(inQuietHours(night.quietHours, at(23, 23, 30)), true);
  assert.equal(inQuietHours(night.quietHours, at(24, 7, 59)), true);
  assert.equal(inQuietHours(night.quietHours, at(24, 8, 0)), false);
  assert.equal(inQuietHours(night.quietHours, FRIDAY_NOON), false);
  const day = quiet({ start: '09:00', end: '17:00' });
  assert.equal(inQuietHours(day.quietHours, FRIDAY_NOON), true);
  assert.equal(inQuietHours(day.quietHours, at(23, 17, 0)), false);
  assert.equal(inQuietHours({ ...night.quietHours, enabled: false }, at(23, 23, 30)), false);
  assert.deepEqual(decide({ preferences: night, now: at(23, 23, 30) }), { notify: false, reason: 'quiet-hours' });
  assert.deepEqual(decide({ preferences: night }), { notify: true });
});

test('quiet days follow the day the quiet period starts on', () => {
  const weekdays = quiet({ days: 'weekdays' });
  // Friday night into Saturday morning started on a weekday.
  assert.equal(inQuietHours(weekdays.quietHours, at(24, 2)), true);
  // Sunday night into Monday morning started on a weekend day.
  assert.equal(inQuietHours(weekdays.quietHours, at(26, 2)), false);
  assert.equal(inQuietHours(weekdays.quietHours, at(24, 23, 30)), false, 'Saturday night');
  const weekends = quiet({ days: 'weekends', start: '10:00', end: '14:00' });
  assert.equal(inQuietHours(weekends.quietHours, at(24, 12)), true);
  assert.equal(inQuietHours(weekends.quietHours, FRIDAY_NOON), false);
});

test('allowWaiting lets questions and approvals through quiet hours, not results', () => {
  const preferences = quiet({ allowWaiting: true });
  const now = at(23, 23, 30);
  for (const event of ['question', 'approval']) assert.deepEqual(decide({ preferences, now, event }), { notify: true });
  for (const event of ['finished', 'error']) {
    assert.deepEqual(decide({ preferences, now, event }), { notify: false, reason: 'quiet-hours' });
  }
  // An "always" conversation is still quiet at night.
  assert.deepEqual(
    decide({ preferences: quiet(), now, overrides: [override('session', coding.sessionId, { mode: 'always' })] }),
    { notify: false, reason: 'quiet-hours' }
  );
});

test('the most specific override wins: session, then room, then the bot', () => {
  const member = notificationConversationOf({ id: 'sess_room_r1_gh' });
  const conversation = { ...member, sessionId: 's1', roomId: 'r1', agentId: 'gh' };
  const muteBot = override('agent', 'gh', { mode: 'muted', until: null });
  const alwaysRoom = override('room', 'r1', { mode: 'always' });
  const muteSession = override('session', 's1', { mode: 'muted', until: null });
  assert.equal(conversationOverride(conversation, [muteBot], FRIDAY_NOON)?.target.kind, 'agent');
  assert.equal(conversationOverride(conversation, [muteBot, alwaysRoom], FRIDAY_NOON)?.target.kind, 'room');
  assert.equal(
    conversationOverride(conversation, [alwaysRoom, muteSession, muteBot], FRIDAY_NOON)?.target.kind,
    'session'
  );
  assert.deepEqual(decide({ conversation, overrides: [muteBot] }), { notify: false, reason: 'muted' });
  assert.deepEqual(decide({ conversation, overrides: [muteBot, alwaysRoom] }), { notify: true });
});

test('a bot mute reaches its home chat; an expired mute is gone', () => {
  const mute = (until) => override('agent', 'secretary', { mode: 'muted', until });
  assert.deepEqual(decide({ conversation: bot, overrides: [mute(null)] }), { notify: false, reason: 'muted' });
  assert.deepEqual(decide({ conversation: bot, overrides: [mute(FRIDAY_NOON + 1)] }).notify, false);
  assert.deepEqual(decide({ conversation: bot, overrides: [mute(FRIDAY_NOON)] }), { notify: true });
  assert.deepEqual(activeOverrides([mute(FRIDAY_NOON - 1), mute(null)], FRIDAY_NOON), [mute(null)]);
});

test('scope: off skips everything, bots keeps bot chats and rooms only', () => {
  assert.deepEqual(decide({ preferences: prefs({ scope: 'off' }), conversation: bot }), {
    notify: false,
    reason: 'scope',
  });
  const bots = NEW_PHONE_NOTIFICATION_PREFERENCES;
  assert.equal(decide({ preferences: bots, conversation: bot }).notify, true);
  assert.equal(decide({ preferences: bots, conversation: room }).notify, true);
  for (const conversation of [coding, task, run]) {
    assert.deepEqual(decide({ preferences: bots, conversation }), { notify: false, reason: 'scope' });
  }
});

test('"always" skips the scope and event checks, not automatic runs or presence', () => {
  const always = [override('session', coding.sessionId, { mode: 'always' })];
  assert.equal(decide({ preferences: prefs({ scope: 'off' }), overrides: always }).notify, true);
  assert.equal(decide({ preferences: prefs({ scope: 'bots' }), overrides: always }).notify, true);
  assert.equal(decide({ event: 'error', overrides: always }).notify, true, 'error is off by default');
  assert.deepEqual(decide({ overrides: always, foreground: true }), { notify: false, reason: 'foreground' });
});

test('each event follows its own switch; error is off by default', () => {
  assert.deepEqual(decide({ event: 'error' }), { notify: false, reason: 'event' });
  for (const event of ['finished', 'question', 'approval']) {
    assert.equal(decide({ event }).notify, true);
    assert.deepEqual(decide({ event, preferences: prefs({ events: { [event]: false } }) }), {
      notify: false,
      reason: 'event',
    });
  }
  assert.equal(decide({ event: 'error', preferences: prefs({ events: { error: true } }) }).notify, true);
});

test('automatic runs: results of schedules and webhooks follow the switch, their waits do not', () => {
  const off = prefs({ automaticRuns: false, events: { error: true } });
  for (const sourceType of ['schedule', 'webhook']) {
    const conversation = notificationConversationOf({ id: 'auto', sourceType });
    for (const event of ['finished', 'error']) {
      assert.deepEqual(decide({ preferences: off, conversation, event }), { notify: false, reason: 'automatic-runs' });
    }
    for (const event of ['question', 'approval'])
      assert.equal(decide({ preferences: off, conversation, event }).notify, true);
  }
  assert.equal(decide({ preferences: off }).notify, true, 'the user’s own turn');
});

test('presence: on screen skips, except the result of a schedule or a webhook', () => {
  assert.deepEqual(decide({ foreground: true }), { notify: false, reason: 'foreground' });
  for (const sourceType of ['schedule', 'webhook']) {
    const conversation = notificationConversationOf({ id: 'auto', sourceType });
    assert.equal(decide({ conversation, foreground: true }).notify, true);
    assert.deepEqual(decide({ conversation, foreground: true, event: 'approval' }), {
      notify: false,
      reason: 'foreground',
    });
  }
});

test('a paired device holding pushes skips while this PC is in use', () => {
  const hold = prefs({ holdWhileDesktopActive: true });
  assert.deepEqual(decide({ preferences: hold, desktopActive: true }), { notify: false, reason: 'desktop-active' });
  assert.equal(decide({ preferences: hold, desktopActive: false }).notify, true);
  assert.equal(decide({ desktopActive: true }).notify, true, 'not held by default');
});

test('the steps run in order: quiet hours before a mute, a mute before the scope', () => {
  const muted = [override('session', coding.sessionId, { mode: 'muted', until: null })];
  assert.equal(decide({ preferences: quiet(), now: at(23, 23, 30), overrides: muted }).reason, 'quiet-hours');
  assert.equal(decide({ preferences: prefs({ scope: 'off' }), overrides: muted }).reason, 'muted');
  assert.equal(decide({ preferences: prefs({ scope: 'off', events: { finished: false } }) }).reason, 'scope');
  assert.equal(
    decide({ preferences: prefs({ events: { finished: false }, automaticRuns: false }), conversation: run }).reason,
    'event'
  );
  const auto = notificationConversationOf({ id: 'auto', sourceType: 'schedule' });
  assert.equal(
    decide({
      preferences: prefs({ automaticRuns: false, holdWhileDesktopActive: true }),
      conversation: auto,
      desktopActive: true,
    }).reason,
    'automatic-runs'
  );
});

test('taskbar flash: its own switch, quiet hours and a conversation mute', () => {
  const view = (preferences, overrides = []) => ({ preferences, overrides });
  assert.equal(allowsTaskbarFlash(view(prefs()), coding, FRIDAY_NOON), true);
  assert.equal(allowsTaskbarFlash(view(prefs({ taskbarFlash: false })), coding, FRIDAY_NOON), false);
  assert.equal(allowsTaskbarFlash(view(quiet()), coding, at(23, 23, 30)), false);
  const mute = override('session', coding.sessionId, { mode: 'muted', until: null });
  assert.equal(allowsTaskbarFlash(view(prefs(), [mute]), coding, FRIDAY_NOON), false);
  assert.equal(
    allowsTaskbarFlash(view(prefs({ scope: 'off' })), coding, FRIDAY_NOON),
    true,
    'the scope is not its switch'
  );
});

test('a notice of no conversation follows the scope and quiet hours', () => {
  assert.equal(allowsDeviceNotice(prefs(), FRIDAY_NOON), true);
  assert.equal(allowsDeviceNotice(prefs({ scope: 'off' }), FRIDAY_NOON), false);
  assert.equal(allowsDeviceNotice(quiet(), at(23, 23, 30)), false);
});
