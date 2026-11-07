#!/usr/bin/env node
// Golden of the setup tool's `status` action for the `schedules` and `webhooks` domains as the
// whole Node setup tool answers it: the real `createSetupToolExecutor(...).execute(args, ...)` of
// src/session-runtime/setup-tool/executor.mjs, so the recorded reply is the text the model gets
// (the dispatcher's `domain` + the reader's `entries` / `listener`, or the error text). The
// runtime facade is a fake `getChannelSetup`. Runs on temp data/home dirs.
//
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

//   --tree <Node product tree> [--out <golden.json>]   (the default output is the fixture set
//   `automation-status` of the checkout this file is in)
const flag = (name) => process.argv[process.argv.indexOf(`--${name}`) + 1];
if (!process.argv.includes('--tree')) throw new Error('pass --tree <Node product tree>');
const TREE = resolve(flag('tree')).replaceAll('\\', '/');
const OUT = process.argv.includes('--out')
  ? resolve(flag('out'))
  : join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'native', 'core', 'fixtures', 'automation-status', 'golden.json');
const sandbox = mkdtempSync(join(tmpdir(), 'automation-status-'));
Object.assign(process.env, {
  MIXDOG_DATA_DIR: join(sandbox, 'data'),
  MIXDOG_HOME: sandbox,
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  MIXDOG_USER_DATA_BACKUP_ROOT: join(sandbox, 'backups'),
  HOME: sandbox,
  USERPROFILE: sandbox,
  APPDATA: sandbox,
  LOCALAPPDATA: sandbox,
});
process.chdir(sandbox);
const { createSetupToolExecutor } = await import(pathToFileURL(`${TREE}/src/session-runtime/setup-tool/executor.mjs`).href);

const CRON = { time: '0 9 * * 1-5', whenCron: '0 9 * * 1-5', timezone: 'Asia/Seoul' };
const STATES = {
  empty: { schedules: [], webhooks: [], webhook: { enabled: true, port: 3333, domain: 'h.example', publicUrl: 'https://h.example' } },
  busy: {
    schedules: [
      // Keys out of declaration order, and keys that are not entry keys (`secret`, `id`, `nextFireAt`).
      { instructions: 'Tidy up PRs', name: 'pr-sweep', owner: 'reviewer', description: 'd', ...CRON, executorAgentId: 'worker', enabled: true, cwd: '/w', nextFireAt: '2031-01-01T00:00:00.000Z', id: 7, secret: 'sek' },
      { name: 'mixy-daily', ...CRON, instructions: 'Morning', owner: 'lead', executorAgentId: null, enabled: true, days: ['mon', 'fri'] },
      { name: 'once', time: 'at 2031-05-06T07:08:09.000Z', whenAt: '2031-05-06T07:08:09.000Z', at: '2031-05-06T07:08:09.000Z', instructions: 'Once', owner: 'lead', executorAgentId: null, enabled: false,
        attachments: [
          { kind: 'text', name: 'n.txt', mimeType: 'text/plain', data: 'héllo😀', path: '/p' },
          { kind: 'image', name: 'i.png', mimeType: 'image/png' },
          { kind: 'text', name: 'z', mimeType: 'text/plain', data: null },
          { kind: 'text', name: 'num', mimeType: 'text/plain', data: 12345 },
          { kind: 'text', name: 'no', mimeType: 'text/plain', data: false },
        ] },
      { name: 'ownerless', ...CRON, instructions: 'x', enabled: true, attachments: 'not-a-list' },
      { name: 'empty-attachments', instructions: 'x', attachments: [] },
    ],
    webhooks: [
      { name: 'hook', parser: 'github', instructions: 'Summarise', owner: 'reviewer', executorAgentId: null, enabled: true, secretSet: true, hasLastPayload: true, secret: 'sek' },
      { name: 'quiet', parser: 'stripe', instructions: 'Pay', owner: 'lead', executorAgentId: null, enabled: false, secretSet: true, hasLastPayload: false },
    ],
    webhook: { enabled: false, port: 4100, domain: null, publicUrl: null },
  },
  // No listener block at all: `enabled` false, `port` omitted, `domain` ''.
  bare: { schedules: [{ name: 'a', instructions: 'x' }], webhooks: [{ name: 'b', instructions: 'y' }] },
  // The listener fields as they happen to be stored.
  odd: {
    schedules: [],
    webhooks: [],
    webhook: { enabled: 'yes', port: '8080', domain: 0 },
  },
  oddNull: { schedules: [], webhooks: [], webhook: { enabled: true, port: null, domain: '' } },
  noPort: { schedules: [], webhooks: [], webhook: { enabled: true, domain: 'only.example' } },
  // A runtime that did not list the domain.
  broken: {},
  brokenNull: { schedules: null, webhooks: null },
  brokenType: { schedules: 'x', webhooks: {} },
};

const CALLERS = {
  human: ['sess_human', { id: 'sess_human', sourceType: 'lead', owner: 'user' }],
  room: ['sess_room', { id: 'sess_room' }],
};
const plain = (v) => (v === undefined ? { absent: true } : JSON.parse(JSON.stringify(v)));
const ARGS = [];
for (const domain of ['schedules', 'webhooks']) {
  ARGS.push({ action: 'status', domain });
  ARGS.push({ action: 'status', domain, detail: true });
  ARGS.push({ action: 'status', domain, detail: 'true' });
}
ARGS.push({ action: 'status', domain: ' webhooks ' });

const cases = [];
for (const state of Object.keys(STATES)) {
  for (const args of ARGS) {
    for (const [caller, [id, record]] of Object.entries(CALLERS)) {
      const executor = createSetupToolExecutor({
        getApi: () => ({ getChannelSetup: async () => STATES[state] }),
        getConfig: () => ({}),
        getSessionId: () => id,
        getCallerSession: (sid) => (sid === id ? record : null),
        notifySessionUi: () => false,
        flushSettings: async () => {},
      });
      let result;
      try {
        result = { reply: await executor.execute(structuredClone(args), { callerSessionId: id }) };
      } catch (error) {
        result = { error: String(error?.message ?? error) };
      }
      cases.push({ caller, state, args: plain(args), ...result });
    }
  }
}

const out = { domain: 'automation-status', recorder: 'benchmarks/rust-core/recorders/record-automation-status.mjs', states: STATES, cases };
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`recorded ${cases.length} replies`);
process.exit(0);
