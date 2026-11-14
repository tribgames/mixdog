// Pins the TypeScript decider to the case table the Rust decider (mixdog-core-domains notify::decision) also runs:
// native/core/crates/mixdog-testkit/parity/notification-decision.json. Case input:
//   fn: decide | conversation | quietHours | override | activeOverrides | taskbarFlash | deviceNotice
//   prefs: { base: 'default' | 'newPhone', ...fields to replace; events and quietHours merge }
//   clock: { weekday (0 = Sunday), hour, minute } on this PC's local clock; an override's `untilOffsetMs` is relative to it
//   session: { id, agentHome?, agentRoomId?, taskAgent?, agentMode?, origin?, runOwner? }, or conversation: the fields as given
//   (runOwner is recorded as the session's unattended-run owner before the conversation is read)
import test from 'node:test';

import { assertCase, loadCases } from '../../../../scripts/parity/cases.mjs';
import { recordRunOwner } from '../shared/core-src/runtime/shared/held-request-host.mjs';
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

// 2026-10-18 is a Sunday: that week stays clear of the daylight-saving changes.
const instant = (clock) => new Date(2026, 9, 18 + clock.weekday, clock.hour, clock.minute).getTime();

const preferencesOf = (spec = {}) => {
  const { base = 'default', events, quietHours, ...rest } = spec;
  const from = base === 'newPhone' ? NEW_PHONE_NOTIFICATION_PREFERENCES : DEFAULT_NOTIFICATION_PREFERENCES;
  return {
    ...from,
    ...rest,
    events: { ...from.events, ...events },
    quietHours: { ...from.quietHours, ...quietHours },
  };
};

const conversationOf = (input) => {
  if (input.conversation) return input.conversation;
  const s = input.session;
  if (s.runOwner) recordRunOwner(s.id, s.runOwner);
  return notificationConversationOf({
    id: s.id,
    ...(s.agentHome ? { agentHome: s.agentHome } : {}),
    ...(s.agentRoomId ? { agentRoom: { id: s.agentRoomId, name: '' } } : {}),
    ...(s.taskAgent ? { taskAgent: 'agent' } : {}),
    ...(s.agentMode ? { sessionMode: 'agent' } : {}),
    ...(s.origin && s.origin !== 'user' ? { sourceType: s.origin } : {}),
  });
};

const overridesOf = (list = [], now) =>
  list.map((entry) => ({
    target: { kind: entry.kind, id: entry.id },
    setting:
      entry.mode === 'always'
        ? { mode: 'always' }
        : { mode: 'muted', until: entry.untilOffsetMs === undefined ? null : now + entry.untilOffsetMs },
  }));

const targetOf = (entry) => (entry ? { kind: entry.target.kind, id: entry.target.id } : null);
const entryOf = (entry, now) => ({
  kind: entry.target.kind,
  id: entry.target.id,
  mode: entry.setting.mode,
  untilOffsetMs: entry.setting.mode === 'muted' && entry.setting.until !== null ? entry.setting.until - now : null,
});

function run(input) {
  const now = instant(input.clock ?? { weekday: 5, hour: 12, minute: 0 });
  const preferences = preferencesOf(input.prefs);
  const overrides = overridesOf(input.overrides, now);
  switch (input.fn) {
    case 'conversation':
      return conversationOf(input);
    case 'quietHours':
      return inQuietHours(preferences.quietHours, now);
    case 'override':
      return targetOf(conversationOverride(conversationOf(input), overrides, now));
    case 'activeOverrides':
      return activeOverrides(overrides, now).map((entry) => entryOf(entry, now));
    case 'taskbarFlash':
      return allowsTaskbarFlash({ preferences, overrides }, conversationOf(input), now);
    case 'deviceNotice':
      return allowsDeviceNotice(preferences, now);
    case 'decide': {
      const decision = decideNotification({
        event: input.event,
        conversation: conversationOf(input),
        preferences,
        overrides,
        now,
        foreground: input.foreground === true,
        desktopActive: input.desktopActive === true,
      });
      return decision.notify ? { notify: true } : { notify: false, reason: decision.reason };
    }
    default:
      throw new Error(`unknown parity fn ${input.fn}`);
  }
}

const cases = loadCases('notification-decision');

test('the shared notification-decision table has at least 40 cases', () => {
  if (cases.length < 40) throw new Error(`only ${cases.length} cases`);
});

for (const parityCase of cases) {
  test(`notification decision parity: ${parityCase.id}`, () => {
    assertCase(parityCase, run(parityCase.input), 'notification-decision');
  });
}
