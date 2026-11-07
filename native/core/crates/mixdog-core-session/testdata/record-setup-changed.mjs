// Records what Node publishes as `setupChanged` when its runtime announces two settings changes before the session reads its state, and
// writes that into the `twoDeliveries` entry of `node-setup-changed.json` (the fixture the Rust `setupChanged` tests compare with).
//
// It drives Node's own modules, end to end, with nothing standing in for the counting:
//   - the stored-settings diff and its effect step (`session-runtime/config-change-effects.mjs`: `configChangeSnapshot`,
//     `diffConfigSnapshots`, `createConfigChangeEffects`), whose `settings` effect is the announcement;
//   - the announcement exactly as `session-runtime/boot/providers.mjs` wires it (`emitRuntimeNotification('Settings changed',
//     { kind: 'setup-changed', action: SETTINGS_CHANGED_SETUP_ACTION })`) through the runtime notification bus
//     (`session-runtime/notification-bus.mjs`), which hands it to every listener the session bound;
//   - the session's listener: `createAgentJobFeed` (`tui/session/agent-job-feed.mjs`) routes it with `notification-router.mjs`,
//     whose `set` publishes `setupChanged` into the session state.
// Both changes are applied back to back, so the second is announced before anything reads the state the first one published.
//
// From the repository root (it needs the repository's `node_modules`):
//   node native/core/crates/mixdog-core-session/testdata/record-setup-changed.mjs

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const node = (path) => import(new URL(`../../../../../src/${path}`, import.meta.url).href);
const { configChangeSnapshot, createConfigChangeEffects, diffConfigSnapshots, SETTINGS_CHANGED_SETUP_ACTION } = await node(
  'session-runtime/config-change-effects.mjs'
);
const { createNotificationBus } = await node('session-runtime/notification-bus.mjs');
const { createAgentJobFeed } = await node('tui/session/agent-job-feed.mjs');

const SESSION_ID = 'recorded-session';

const bus = createNotificationBus({ listeners: new Set(), mgr: {}, onCompletionQueued: () => {}, getOwnerLifecycle: () => null });

// The session: its state and the patches `set` published into it, in order.
const state = {};
const published = [];
const feed = createAgentJobFeed({
  runtime: { onNotification: (listener) => bus.subscribeRuntimeNotification(SESSION_ID, listener) },
  getState: () => state,
  set: (patch) => {
    published.push(JSON.parse(JSON.stringify(patch)));
    Object.assign(state, patch);
  },
  nextId: () => 'id',
  getDisposed: () => false,
  patchItem: () => {},
  enqueue: () => true,
  drain: () => {},
  pushUserOrSyntheticItem: () => {},
  makeQueueEntry: (body, options) => ({ body, ...options }),
  getPending: () => [],
  agentStatusState: () => ({}),
  displayedExecutionNotificationKeys: new Set(),
  itemIndexById: new Map(),
  pushNotice: () => {},
});
feed.subscribeRuntimeNotifications();

// The runtime's effect step; only the settings announcement is observed, so the other effects do nothing.
const applyConfigChangeEffects = createConfigChangeEffects({
  invalidateContextStatusCache: () => {},
  reinitProviders: async () => {},
  releaseAdmissionCooldowns: () => {},
  reconcileMcp: async () => {},
  announceSettingsChange: () =>
    bus.emitRuntimeNotification('Settings changed', { kind: 'setup-changed', action: SETTINGS_CHANGED_SETUP_ACTION }),
});

// Three stored states of the settings: the boot baseline, then two route saves (the harness's `route/set` writes the `agent` default
// and its preset) that each differ from the one before.
const snapshot = (agent) => configChangeSnapshot({ config: {}, root: { agent }, secretTokens: {} });
const preset = (effort) => ({ id: 'workflow-lead', provider: 'custom-harness', model: 'harness-model', effort });
const boot = snapshot({ default: 'main' });
const firstSave = snapshot({ default: 'workflow-lead', presets: [preset(null)] });
const secondSave = snapshot({ default: 'workflow-lead', presets: [preset('high')] });
const firstChange = diffConfigSnapshots(boot, firstSave);
const secondChange = diffConfigSnapshots(firstSave, secondSave);
assert.equal(firstChange.settings && secondChange.settings, true, 'both saves change the stored settings');

await Promise.all([applyConfigChangeEffects(firstChange, {}), applyConfigChangeEffects(secondChange, {})]);

for (const patch of published) {
  assert.deepEqual(Object.keys(patch), ['setupChanged'], 'a settings announcement publishes setupChanged and nothing else');
  assert.equal(typeof patch.setupChanged.at, 'number');
}
const seen = ({ action, seq }) => ({ action, seq });
const entry = {
  recorder: 'record-setup-changed.mjs',
  source:
    'Node src/: config-change-effects.mjs (two settings changes) -> notification-bus.mjs -> agent-job-feed.mjs -> notification-router.mjs; ' +
    'the setupChanged each delivery published into the session state, in order, and the state after both (`at` is a time, not recorded)',
  published: published.map((patch) => seen(patch.setupChanged)),
  final: seen(state.setupChanged),
};
assert.equal(entry.published.length, 2, 'each of the two announcements is its own delivery');

const fixture = new URL('./node-setup-changed.json', import.meta.url);
const { router: _router, ...recorded } = JSON.parse(readFileSync(fixture, 'utf8'));
writeFileSync(fixture, `${JSON.stringify({ ...recorded, twoDeliveries: entry }, null, 2)}\n`);
console.log(JSON.stringify(entry, null, 2));
