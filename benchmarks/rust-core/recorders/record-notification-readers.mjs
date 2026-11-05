#!/usr/bin/env node
// Golden twin of the two readers push delivery uses (`PushPreferences.device` and `.overrides`
// of `createNotificationPreferencesStore`): a stored device entry, else
// DEFAULT_NOTIFICATION_PREFERENCES for a client with no pairing record, and the overrides with
// the expired mutes dropped at `now`.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-notification-readers.mjs --tree <dir>
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, refreshSetManifest, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { createNotificationPreferencesStore } = await importFrom(
  tree,
  'apps/desktop/src/main/notification-preferences.ts'
);

const NOW = 1000;
const dir = mkdtempSync(join(tmpdir(), 'notif-readers-'));
const file = join(dir, 'notification-preferences.json');

const devices = {
  pc: { scope: 'bots', taskbarFlash: false },
  'phone-a': { scope: 'off', events: { error: true }, quietHours: { enabled: true, start: '22:15' } },
  'phone.b:2': { automaticRuns: false, holdWhileDesktopActive: false },
};
const overrideLists = [
  [],
  [{ target: { kind: 'agent', id: 'a:1' }, setting: { mode: 'muted', until: null } }],
  [
    { target: { kind: 'agent', id: 'old' }, setting: { mode: 'muted', until: 500 } },
    { target: { kind: 'room', id: 'edge' }, setting: { mode: 'muted', until: NOW } },
    { target: { kind: 'room', id: 'live' }, setting: { mode: 'muted', until: NOW + 1 } },
    { target: { kind: 'session', id: 's' }, setting: { mode: 'always' } },
  ],
];

const entries = [];
for (const overrides of overrideLists) {
  const input = { migratedAt: 5, devices, overrides };
  writeFileSync(file, JSON.stringify({ version: 1, ...input }));
  const store = createNotificationPreferencesStore({
    filePath: file,
    readLegacy: async () => ({ turnNotifications: true, mutedAgents: [] }),
    now: () => NOW,
  });
  await store.ready();
  const read = {};
  for (const id of ['pc', 'phone-a', 'phone.b:2', 'unknown-client']) read[id] = await store.device(id);
  entries.push({ input, now: NOW, devices: read, overrides: await store.overrides() });
}

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'notification-readers-twin.json'), {
  domain: 'notification-readers-twin',
  recorder: 'benchmarks/rust-core/recorders/record-notification-readers.mjs',
  entries,
});
refreshSetManifest(join(FIXTURES_ROOT, 'desktop'), tree);
console.log(`recorded ${entries.length} notification reader cases`);
