import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';

// A data dir without a PostgreSQL cluster yet: the channel setup read and the
// automation probe must answer without starting one (first start = runtime
// extract + initdb, seconds of work).
const root = mkdtempSync(join(tmpdir(), 'mixdog-channel-setup-cold-'));
process.env.MIXDOG_DATA_DIR = root;

const here = (path) => new URL(path, import.meta.url).href;
const reads = { schedules: 0, webhooks: 0 };
const schedulesDb = await import('../../runtime/channels/lib/schedules-db.mjs');
mock.module(here('../../runtime/channels/lib/schedules-db.mjs'), {
  namedExports: {
    ...schedulesDb,
    listSchedules: async () => {
      reads.schedules += 1;
      return [{ name: 'nightly', whenCron: '0 3 * * *', prompt: 'go', enabled: true }];
    },
  },
});
const webhooksDb = await import('../../runtime/channels/lib/webhooks-db.mjs');
mock.module(here('../../runtime/channels/lib/webhooks-db.mjs'), {
  namedExports: {
    ...webhooksDb,
    listEndpoints: async () => {
      reads.webhooks += 1;
      return [{ name: 'gh', parser: 'github', enabled: true, instructions: 'x' }];
    },
  },
});
const tunnel = await import('../../runtime/channels/lib/webhook/relay-tunnel.mjs');
mock.module(here('../../runtime/channels/lib/webhook/relay-tunnel.mjs'), {
  namedExports: { ...tunnel, readHookPublicBase: () => null },
});
const { channelSetup, hasActiveAutomation } = await import('./channel-admin.mjs');

test.after(() => rmSync(root, { recursive: true, force: true }));

test('channel setup and the automation probe never start a first-ever cluster', async () => {
  const setup = await channelSetup({});
  assert.deepEqual(setup.schedules, []);
  assert.deepEqual(setup.webhooks, []);
  assert.equal(await hasActiveAutomation(), false);
  assert.deepEqual(reads, { schedules: 0, webhooks: 0 }, 'neither store was opened');
});

test('once a cluster exists, channel setup reads both stores', async () => {
  mkdirSync(join(root, 'pgdata'), { recursive: true });
  writeFileSync(join(root, 'pgdata', 'PG_VERSION'), '17\n');
  const setup = await channelSetup({});
  assert.deepEqual(
    setup.schedules.map((row) => row.name),
    ['nightly']
  );
  assert.deepEqual(
    setup.webhooks.map((row) => row.name),
    ['gh']
  );
  assert.deepEqual(reads, { schedules: 1, webhooks: 1 });
});
