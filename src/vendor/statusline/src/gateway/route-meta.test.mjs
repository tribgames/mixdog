import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The usage store path resolves from MIXDOG_DATA_DIR on every flush.
const root = mkdtempSync(join(tmpdir(), 'mixdog-route-meta-usage-'));
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_HOME = root;
process.on('exit', () => {
  rmSync(root, { recursive: true, force: true });
});

const { recordGatewayUsageEvent, settleGatewayUsageWrites } = await import('./route-meta.mjs');
const usagePath = join(root, 'gateway-usage.local.json');

function record(count, tag) {
  for (let index = 0; index < count; index += 1) {
    recordGatewayUsageEvent({ provider: 'anthropic', model: 'm', inputTokens: index, requestKind: tag });
  }
}

function storedEvents(tag) {
  return JSON.parse(readFileSync(usagePath, 'utf8')).events.filter((event) => event.requestKind === tag);
}

test('a usage flush against a held lock never blocks the event loop and lands after release', async () => {
  // Own pid + foreign token: a live holder that is never reclaimable.
  writeFileSync(`${usagePath}.lock`, `${process.pid} ${Date.now()} foreign-holder\n`);
  let maxLagMs = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - last - 10);
    last = now;
  }, 10);
  const release = setTimeout(() => unlinkSync(`${usagePath}.lock`), 500);
  try {
    const startedAt = performance.now();
    record(20, 'contended'); // the 20th event flushes immediately
    assert.ok(performance.now() - startedAt < 100, 'recording blocked on the usage lock');
    await settleGatewayUsageWrites();
  } finally {
    clearInterval(probe);
    clearTimeout(release);
  }
  assert.ok(maxLagMs < 200, `event loop blocked for ${Math.round(maxLagMs)}ms by the usage flush`);
  assert.deepEqual(
    storedEvents('contended').map((event) => event.inputTokens),
    Array.from({ length: 20 }, (_, index) => index)
  );
});

test('overlapping flushes keep batches in record order', async () => {
  record(20, 'ordered');
  record(20, 'ordered');
  record(3, 'ordered');
  await settleGatewayUsageWrites();
  const expected = [...Array.from({ length: 20 }, (_, i) => i), ...Array.from({ length: 20 }, (_, i) => i), 0, 1, 2];
  assert.deepEqual(
    storedEvents('ordered').map((event) => event.inputTokens),
    expected
  );
});

test('process exit writes still-pending usage events synchronously', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-route-meta-exit-'));
  try {
    const source = `
      const { recordGatewayUsageEvent } = await import(${JSON.stringify(new URL('./route-meta.mjs', import.meta.url).href)});
      for (let i = 0; i < 3; i++) recordGatewayUsageEvent({ provider: 'anthropic', model: 'm', inputTokens: i, requestKind: 'exit' });
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8',
      env: { ...process.env, MIXDOG_DATA_DIR: dir, MIXDOG_HOME: dir },
      timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const events = JSON.parse(readFileSync(join(dir, 'gateway-usage.local.json'), 'utf8')).events;
    assert.deepEqual(
      events.map((event) => event.inputTokens),
      [0, 1, 2]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
