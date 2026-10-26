import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
const usagePath = join(root, 'gateway-usage.local.jsonl');
const { loadUsageEvents } = await import('./route-meta.mjs');

function readJsonl(path) {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function record(count, tag) {
  for (let index = 0; index < count; index += 1) {
    recordGatewayUsageEvent({ provider: 'anthropic', model: 'm', inputTokens: index, requestKind: tag });
  }
}

function storedEvents(tag) {
  return readJsonl(usagePath).filter((event) => event.requestKind === tag);
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

test('settlement includes the compaction a flush scheduled', async () => {
  // Past the compaction thresholds (8 MiB and 1.5 x 5000 events).
  const pad = 'x'.repeat(1100);
  const lines = Array.from({ length: 8000 }, (_, index) => JSON.stringify({ ts: Date.now(), inputTokens: index, pad }));
  writeFileSync(usagePath, `${lines.join('\n')}\n`);
  record(1, 'compacted');
  await settleGatewayUsageWrites();
  const stored = readJsonl(usagePath);
  assert.equal(stored.length, 5000, 'the store was rewritten before settlement resolved');
  assert.equal(stored.at(-1).requestKind, 'compacted');
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
    const events = readJsonl(join(dir, 'gateway-usage.local.jsonl'));
    assert.deepEqual(
      events.map((event) => event.inputTokens),
      [0, 1, 2]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy JSON store migrates idempotently to JSONL with a backup; readers see appended events incrementally', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-route-meta-migrate-'));
  try {
    const now = Date.now();
    const legacy = join(dir, 'gateway-usage.local.json');
    writeFileSync(legacy, JSON.stringify({ version: 1, events: [1, 2, 3].map((n) => ({ ts: now, provider: 'p', inputTokens: n })) }));
    const source = `
      import { appendFileSync } from 'node:fs';
      const m = await import(${JSON.stringify(new URL('./route-meta.mjs', import.meta.url).href)});
      const a = m.loadUsageEvents().map((e) => e.inputTokens);
      m.recordGatewayUsageEvent({ provider: 'p', model: 'm', inputTokens: 4 });
      await m.settleGatewayUsageWrites();
      appendFileSync(process.env.MIXDOG_DATA_DIR + '/gateway-usage.local.jsonl', '{"ts":' + Date.now() + ',"inputTokens":5,"torn":');
      const b = m.loadUsageEvents().map((e) => e.inputTokens);
      console.log(JSON.stringify({ a, b }));
    `;
    const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8', timeout: 20_000, env: { ...process.env, MIXDOG_DATA_DIR: dir, MIXDOG_HOME: dir },
    });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), { a: [1, 2, 3], b: [1, 2, 3, 4] });
    assert.equal(existsSync(legacy), false);
    assert.equal(existsSync(`${legacy}.migrated.bak`), true);
    // Crash between the two migration renames: both files present -> only the backup rename is redone.
    writeFileSync(legacy, JSON.stringify({ events: [{ ts: now, inputTokens: 99 }] }));
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(existsSync(legacy), false);
    assert.ok(!JSON.parse(second.stdout).a.includes(99));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
