import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  gatewaySessionRoutesPath,
  readGatewaySessionRoute,
  writeGatewaySessionRoute,
} from './session-routes.mjs';

const route = (model) => ({ defaultProvider: 'openai', defaultModel: model });

function withData(run) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-session-routes-'));
  const saved = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dir;
  try {
    run(dir);
  } finally {
    if (saved === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a NUL route store is kept aside and the route pin is writable again', () =>
  withData((dir) => {
    const sid = 'session-aaaa-0001';
    assert.equal(writeGatewaySessionRoute(sid, route('one')), true);
    const damaged = Buffer.alloc(48);
    writeFileSync(gatewaySessionRoutesPath(), damaged);
    assert.equal(readGatewaySessionRoute(sid), null);
    assert.ok(readdirSync(dir).some((n) => n.includes('.corrupt-') && readFileSync(join(dir, n)).equals(damaged)));
    assert.equal(writeGatewaySessionRoute(sid, route('two')), true);
    assert.equal(readGatewaySessionRoute(sid).defaultModel, 'two');
  }));

test('a truncated route store is restored from the previous version', () =>
  withData(() => {
    const sid = 'session-aaaa-0002';
    writeGatewaySessionRoute(sid, route('one'));
    writeGatewaySessionRoute(sid, route('two'));
    writeFileSync(gatewaySessionRoutesPath(), '{"version":2,"sess');
    assert.equal(readGatewaySessionRoute(sid).defaultModel, 'one');
  }));
