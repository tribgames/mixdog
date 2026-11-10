import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { providerAccountsResetAt, readProviderAccountPool } from './provider-accounts.mjs';

test('a BOM-prefixed provider-accounts.json still loads', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-provider-accounts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const roster = {
    version: 1,
    providers: { 'openai-oauth': { accounts: [{ id: 'default', label: 'Work' }], selectedId: 'default', auto: true } },
  };
  writeFileSync(join(dir, 'provider-accounts.json'), `\uFEFF${JSON.stringify(roster, null, 2)}`);
  const pool = readProviderAccountPool('openai-oauth', dir);
  assert.deepEqual(
    pool.accounts.map((row) => row.label),
    ['Work']
  );
});

test('a NUL-filled provider-accounts.json is moved aside and reads as an empty roster', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-provider-accounts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'provider-accounts.json'), Buffer.alloc(2608));
  const pool = readProviderAccountPool('anthropic-oauth', dir);
  assert.deepEqual(pool.accounts, []);
  assert.equal(existsSync(join(dir, 'provider-accounts.json')), false);
  assert.ok(readdirSync(dir).some((name) => name.startsWith('provider-accounts.json.corrupt-')));
});

test('a truncated provider-accounts.json falls back to its last good copy', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-provider-accounts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const roster = {
    version: 1,
    providers: { 'anthropic-oauth': { accounts: [{ id: 'default', label: 'Work' }], selectedId: 'default' } },
  };
  writeFileSync(join(dir, 'provider-accounts.json.bak'), JSON.stringify(roster));
  writeFileSync(join(dir, 'provider-accounts.json'), '{"version":1,"providers":');
  const pool = readProviderAccountPool('anthropic-oauth', dir);
  assert.deepEqual(
    pool.accounts.map((row) => row.label),
    ['Work']
  );
  assert.ok(readdirSync(dir).some((name) => name.startsWith('provider-accounts.json.corrupt-')));
});

test('a roster in a newer build format is left in place and reads as empty', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-provider-accounts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const newer = JSON.stringify({ version: 2, providers: {} });
  writeFileSync(join(dir, 'provider-accounts.json'), newer);
  assert.deepEqual(readProviderAccountPool('anthropic-oauth', dir).accounts, []);
  assert.equal(readFileSync(join(dir, 'provider-accounts.json'), 'utf8'), newer);
});

test('a provider a newer build added is kept, not treated as damage', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-provider-accounts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const roster = {
    version: 1,
    providers: {
      'future-oauth': { accounts: [{ id: 'default' }], selectedId: 'default' },
      'openai-oauth': { accounts: [{ id: 'default', label: 'Work' }], selectedId: 'default' },
    },
  };
  writeFileSync(join(dir, 'provider-accounts.json'), JSON.stringify(roster));
  assert.deepEqual(
    readProviderAccountPool('openai-oauth', dir).accounts.map((row) => row.label),
    ['Work']
  );
  assert.equal(existsSync(join(dir, 'provider-accounts.json')), true);
  assert.equal(
    readdirSync(dir).some((name) => name.includes('.corrupt-')),
    false
  );
});

const now = 1_000_000;
const account = (windows, extra = {}) => ({ usage: { windows, checkedAt: now }, ...extra });

test('scoped windows: a cleared 5H does not hide a full 7D Opus', () => {
  const row = account([
    { label: '5H', usedPct: 10, resetAt: now + 100 },
    { label: '7D Opus', usedPct: 100, resetAt: now + 900 },
  ]);
  assert.equal(providerAccountsResetAt([row], now, 'claude-opus-4'), now + 900);
});

test('a family window for another model is ignored', () => {
  const row = account([
    { label: '5H', usedPct: 100, resetAt: now + 100 },
    { label: '7D Opus', usedPct: 100, resetAt: now + 900 },
  ]);
  assert.equal(providerAccountsResetAt([row], now, 'claude-sonnet-4'), now + 100);
});

test('per account the latest blocking window, across accounts the earliest', () => {
  const a = account([
    { label: '5H', usedPct: 100, resetAt: now + 100 },
    { label: '7D', usedPct: 100, resetAt: now + 800 },
  ]);
  const b = account([{ label: '5H', usedPct: 100, resetAt: now + 500 }]);
  assert.equal(providerAccountsResetAt([a, b], now, 'm'), now + 500);
});

test('retry-after block counts; an inferred block makes the account unknown', () => {
  const server = { blockedUntil: now + 300, blockedSource: 'retry-after' };
  const inferred = { blockedUntil: now + 100 };
  assert.equal(providerAccountsResetAt([server], now, 'm'), now + 300);
  assert.equal(providerAccountsResetAt([inferred], now, 'm'), null);
  assert.equal(providerAccountsResetAt([inferred, server], now, 'm'), now + 300);
});

test('credit use ignores meter windows', () => {
  const row = account([{ label: '5H', usedPct: 100, resetAt: now + 100 }], {
    blockedUntil: now + 700,
    blockedSource: 'retry-after',
  });
  assert.equal(providerAccountsResetAt([row], now, 'm', { useCredits: true }), now + 700);
});

test('no exhausted account yields null', () => {
  assert.equal(providerAccountsResetAt([account([{ label: '5H', usedPct: 10, resetAt: now + 1 }])], now, 'm'), null);
  assert.equal(providerAccountsResetAt([], now, 'm'), null);
});
