import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { syncFsCalls } from '../../../../runtime/shared/sync-fs-calls.fixture.mjs';
import {
  clearGatewaySessionRoute,
  gatewaySessionRoutesPath,
  gatewaySessionRoutesSettled,
  readGatewaySessionRoute,
  writeGatewaySessionRoute,
} from './session-routes.mjs';

const route = (model) => ({ defaultProvider: 'openai', defaultModel: model });

async function withData(run) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-session-routes-'));
  const saved = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dir;
  try {
    await run(dir);
  } finally {
    await gatewaySessionRoutesSettled();
    if (saved === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a NUL route store is kept aside and the route pin is writable again', () =>
  withData(async (dir) => {
    const sid = 'session-aaaa-0001';
    assert.equal(writeGatewaySessionRoute(sid, route('one')), true);
    await gatewaySessionRoutesSettled();
    const damaged = Buffer.alloc(48);
    writeFileSync(gatewaySessionRoutesPath(), damaged);
    assert.equal(readGatewaySessionRoute(sid), null);
    assert.ok(readdirSync(dir).some((n) => n.includes('.corrupt-') && readFileSync(join(dir, n)).equals(damaged)));
    assert.equal(writeGatewaySessionRoute(sid, route('two')), true);
    await gatewaySessionRoutesSettled();
    assert.equal(readGatewaySessionRoute(sid).defaultModel, 'two');
  }));

test('a truncated route store is restored from the previous version', () =>
  withData(async () => {
    const sid = 'session-aaaa-0002';
    writeGatewaySessionRoute(sid, route('one'));
    await gatewaySessionRoutesSettled();
    writeGatewaySessionRoute(sid, route('two'));
    await gatewaySessionRoutesSettled();
    writeFileSync(gatewaySessionRoutesPath(), '{"version":2,"sess');
    assert.equal(readGatewaySessionRoute(sid).defaultModel, 'one');
  }));

test('a burst of route writes makes no synchronous file call and lands in call order', () =>
  withData(async () => {
    const sids = Array.from({ length: 20 }, (_, i) => `session-burst-${String(i).padStart(4, '0')}`);
    const calls = await syncFsCalls(() => {
      for (const sid of sids) writeGatewaySessionRoute(sid, route('burst'));
      clearGatewaySessionRoute(sids[0]);
    });
    assert.deepEqual(calls, []);
    await gatewaySessionRoutesSettled();
    assert.equal(readGatewaySessionRoute(sids[0]), null, 'the clear queued after the write wins');
    for (const sid of sids.slice(1)) assert.equal(readGatewaySessionRoute(sid).defaultModel, 'burst');
  }));
