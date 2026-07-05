import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMarkdownDocument } from '../src/runtime/shared/markdown-frontmatter.mjs';

// DATA_DIR resolves from MIXDOG_DATA_DIR at module import time (via
// ./config.mjs -> resolvePluginData), so the env var MUST be set before
// the first dynamic import of webhook.mjs.
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-webhook-test-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const {
  extractSignature,
  verifySignature,
  loadEndpointConfig,
  STRIPE_TOLERANCE_MS,
} = await import('../src/runtime/channels/lib/webhook.mjs');

function hmacHex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// ── verifySignature: github/generic hex HMAC ──────────────────────────

test('verifySignature: github parser accepts a valid sha256 hex signature', () => {
  const secret = 'shh';
  const body = '{"hello":"world"}';
  const sig = hmacHex(secret, body);
  assert.equal(verifySignature(secret, body, sig, 'github'), true);
});

test('verifySignature: generic parser accepts a valid sha256 hex signature', () => {
  const secret = 'shh';
  const body = '{"hello":"world"}';
  const sig = hmacHex(secret, body);
  assert.equal(verifySignature(secret, body, sig, 'generic'), true);
});

test('verifySignature: github/generic reject a wrong signature', () => {
  const secret = 'shh';
  const body = '{"hello":"world"}';
  const wrong = hmacHex('other-secret', body);
  assert.equal(verifySignature(secret, body, wrong, 'github'), false);
});

test('verifySignature: length-mismatch hex signature returns false without throwing', () => {
  const secret = 'shh';
  const body = 'payload';
  // Valid hex, wrong byte length vs the 32-byte sha256 digest.
  assert.doesNotThrow(() => {
    assert.equal(verifySignature(secret, body, 'ab', 'github'), false);
  });
});

test('verifySignature: malformed (non-hex) signature returns false without throwing', () => {
  const secret = 'shh';
  const body = 'payload';
  assert.doesNotThrow(() => {
    assert.equal(verifySignature(secret, body, 'not-hex-zzzz', 'github'), false);
  });
});

// ── verifySignature: stripe t= / v1= scheme ───────────────────────────

test('verifySignature: stripe accepts a valid t+v1 pair', () => {
  const secret = 'stripe-secret';
  const body = '{"id":"evt_1"}';
  const t = Math.floor(Date.now() / 1000);
  const v1 = hmacHex(secret, `${t}.${body}`);
  assert.equal(verifySignature(secret, body, `t=${t},v1=${v1}`, 'stripe'), true);
});

test('verifySignature: stripe rejects a header missing t=', () => {
  const secret = 'stripe-secret';
  const body = '{"id":"evt_1"}';
  const t = Math.floor(Date.now() / 1000);
  const v1 = hmacHex(secret, `${t}.${body}`);
  assert.equal(verifySignature(secret, body, `v1=${v1}`, 'stripe'), false);
});

test('verifySignature: stripe rejects a header missing v1=', () => {
  const secret = 'stripe-secret';
  const body = '{"id":"evt_1"}';
  const t = Math.floor(Date.now() / 1000);
  assert.equal(verifySignature(secret, body, `t=${t}`, 'stripe'), false);
});

test('verifySignature: stripe rejects a stale timestamp beyond the tolerance window (replay)', () => {
  const secret = 'stripe-secret';
  const body = '{"id":"evt_1"}';
  const staleT = Math.floor((Date.now() - STRIPE_TOLERANCE_MS - 60_000) / 1000);
  const v1 = hmacHex(secret, `${staleT}.${body}`);
  assert.equal(verifySignature(secret, body, `t=${staleT},v1=${v1}`, 'stripe'), false);
});

test('verifySignature: stripe rejects a tampered v1 (HMAC mismatch) with a fresh t', () => {
  const secret = 'stripe-secret';
  const body = '{"id":"evt_1"}';
  const t = Math.floor(Date.now() / 1000);
  const tamperedV1 = hmacHex('wrong-secret', `${t}.${body}`);
  assert.equal(verifySignature(secret, body, `t=${t},v1=${tamperedV1}`, 'stripe'), false);
});

// ── extractSignature: parser mapping + fallback scan ──────────────────

test('extractSignature: github parser strips the sha256= prefix from x-hub-signature-256', () => {
  const headers = { 'x-hub-signature-256': 'sha256=deadbeef' };
  assert.equal(extractSignature(headers, 'github'), 'deadbeef');
});

test('extractSignature: generic parser strips the sha256= prefix from x-signature-256', () => {
  const headers = { 'x-signature-256': 'sha256=cafebabe' };
  assert.equal(extractSignature(headers, 'generic'), 'cafebabe');
});

test('extractSignature: stripe parser returns the raw stripe-signature value (no prefix)', () => {
  const headers = { 'stripe-signature': 't=1,v1=abc123' };
  assert.equal(extractSignature(headers, 'stripe'), 't=1,v1=abc123');
});

test('extractSignature: sentry parser returns the raw sentry-hook-signature value', () => {
  const headers = { 'sentry-hook-signature': 'raw-sig-value' };
  assert.equal(extractSignature(headers, 'sentry'), 'raw-sig-value');
});

test('extractSignature: unknown parser name falls back to scanning all known headers', () => {
  const headers = { 'x-signature-256': 'sha256=fallback-hit' };
  assert.equal(extractSignature(headers, 'no-such-parser'), 'fallback-hit');
});

test('extractSignature: no parser given scans known headers in declaration order', () => {
  const headers = { 'x-hub-signature-256': 'sha256=github-hit' };
  assert.equal(extractSignature(headers, undefined), 'github-hit');
});

test('extractSignature: returns null when no known signature header is present', () => {
  const headers = { 'x-some-other-header': 'value' };
  assert.equal(extractSignature(headers, 'github'), null);
});

// ── endpoint config loader: WEBHOOK.md frontmatter + secret side file ─

test('loadEndpointConfig: loads frontmatter + reads secret from side file', () => {
  const name = 'my-endpoint';
  const dir = join(dataDir, 'webhooks', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'WEBHOOK.md'),
    [
      '---',
      'channel: main',
      'parser: github',
      'enabled: true',
      '---',
      '',
      'Handle this webhook by summarizing the payload.',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(dir, 'secret'), 'my-webhook-secret\n', 'utf8');

  const cfg = loadEndpointConfig(name);
  assert.equal(cfg.channel, 'main');
  assert.equal(cfg.parser, 'github');
  assert.equal(cfg.enabled, true);
});

test('loadEndpointConfig: enabled: false frontmatter casts to boolean false', () => {
  const name = 'disabled-endpoint';
  const dir = join(dataDir, 'webhooks', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'WEBHOOK.md'),
    ['---', 'channel: main', 'enabled: false', '---', '', 'body text', ''].join('\n'),
    'utf8',
  );
  const cfg = loadEndpointConfig(name);
  assert.equal(cfg.enabled, false);
});

test('loadEndpointConfig: returns null for a name with no WEBHOOK.md', () => {
  assert.equal(loadEndpointConfig('never-registered'), null);
});

// loadEndpointConfig only surfaces the frontmatter (by design — see
// webhook.mjs comment above loadEndpointConfig); confirm the underlying
// shared parser it delegates to also recovers the markdown body, since
// the loader's frontmatter/body split is not independently exercised
// through the exported loadEndpointConfig surface.
test('readMarkdownDocument: WEBHOOK.md-shaped input yields frontmatter + body', () => {
  const raw = [
    '---',
    'channel: main',
    'parser: github',
    '---',
    '',
    'Handle this webhook by summarizing the payload.',
    '',
  ].join('\n');
  const { frontmatter, body } = readMarkdownDocument(raw);
  assert.equal(frontmatter.channel, 'main');
  assert.equal(frontmatter.parser, 'github');
  assert.equal(body, 'Handle this webhook by summarizing the payload.');
});
