#!/usr/bin/env node
// Golden twin of what Node stores for a `notifications` input: each case is written as a
// version-1 preferences file and read back through `readPcNotificationView`
// (`storedPreferences` and `storedOverride` normalise it). Inputs are valid but partial or with
// unknown fields; the Rust `Config` write must store the same value.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-notification-store.mjs --tree <dir>
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, refreshSetManifest, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { readPcNotificationView } = await importFrom(tree, 'apps/desktop/src/main/notification-preferences.ts');

const dir = mkdtempSync(join(tmpdir(), 'notif-'));
const file = join(dir, 'notification-preferences.json');

const devices = [
  {},
  { scope: 'off' },
  { scope: 'bots', extra: 1 },
  { events: { error: true } },
  { events: { finished: false, bogus: true } },
  { automaticRuns: false, taskbarFlash: false },
  { quietHours: { enabled: true } },
  { quietHours: { enabled: true, start: '00:00', end: '23:59', days: 'weekends', allowWaiting: true, more: 0 } },
  { quietHours: { start: '07:30' } },
  { holdWhileDesktopActive: false, unknown: { nested: true } },
  { scope: 'all', events: { finished: true, question: false, approval: true, error: true }, automaticRuns: true,
    quietHours: { enabled: false, start: '23:00', end: '08:00', days: 'every', allowWaiting: false },
    holdWhileDesktopActive: true, taskbarFlash: true },
];
const overrideLists = [
  [],
  [{ target: { kind: 'agent', id: 'a:1' }, setting: { mode: 'muted', until: null } }],
  [{ target: { kind: 'room', id: 'r.1-x_y' }, setting: { mode: 'muted', until: 1750000000000 }, extra: 1 }],
  [{ target: { kind: 'session', id: 's' , extra: 1 }, setting: { mode: 'always', extra: 2 } }],
  [
    { target: { kind: 'session', id: 's1' }, setting: { mode: 'always' } },
    { target: { kind: 'agent', id: 'a'.repeat(200) }, setting: { mode: 'muted', until: 1 } },
  ],
];

const entries = [];
for (const [i, prefs] of devices.entries()) {
  const overrides = overrideLists[i % overrideLists.length];
  const input = { migratedAt: 5, devices: { pc: prefs }, overrides };
  writeFileSync(file, JSON.stringify({ version: 1, ...input }));
  const view = readPcNotificationView(file, 0);
  entries.push({ input, stored: { devices: { pc: view.preferences }, overrides: view.overrides } });
}

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'notification-store-twin.json'), {
  domain: 'notification-store-twin',
  recorder: 'benchmarks/rust-core/recorders/record-notification-store.mjs',
  entries,
});
refreshSetManifest(join(FIXTURES_ROOT, 'desktop'), tree);
console.log(`recorded ${entries.length} notification inputs`);
