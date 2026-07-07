import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMarkdownDocument } from '../src/runtime/shared/markdown-frontmatter.mjs';

// DATA_DIR resolves from MIXDOG_DATA_DIR at module import time (via
// ./config.mjs -> resolvePluginData), so the env var MUST be set before
// the first dynamic import of webhook.mjs. Endpoint defs + delivery dedup now
// live in PG; this smoke suite deliberately exercises ONLY the pure,
// PG-free surface (signature verify + header helpers) so it needs no live DB.
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-webhook-test-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const {
  extractSignature,
  verifySignature,
  STRIPE_TOLERANCE_MS,
} = await import('../src/runtime/channels/lib/webhook.mjs');
const { extractDeliveryId, buildHeadersSummary } = await import(
  '../src/runtime/channels/lib/webhook/deliveries.mjs'
);

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

// ── delivery-id extraction: header precedence + null fallback ─────────

test('extractDeliveryId: prefers x-github-delivery over other id headers', () => {
  const headers = { 'x-github-delivery': 'gh-1', 'x-delivery-id': 'dl-1', 'x-request-id': 'rq-1' };
  assert.equal(extractDeliveryId(headers), 'gh-1');
});

test('extractDeliveryId: falls back to x-delivery-id then x-request-id', () => {
  assert.equal(extractDeliveryId({ 'x-delivery-id': 'dl-1', 'x-request-id': 'rq-1' }), 'dl-1');
  assert.equal(extractDeliveryId({ 'x-request-id': 'rq-1' }), 'rq-1');
});

test('extractDeliveryId: returns null when no id header is present', () => {
  assert.equal(extractDeliveryId({ 'content-type': 'application/json' }), null);
});

// ── headers summary: event/delivery/content-type + signature presence ─

test('buildHeadersSummary: captures event, delivery, content-type and signature presence', () => {
  const summary = buildHeadersSummary({
    'x-github-event': 'issues',
    'x-github-delivery': 'gh-1',
    'x-hub-signature-256': 'sha256=abc',
    'content-type': 'application/json',
  });
  assert.equal(summary.event_type, 'issues');
  assert.equal(summary.delivery_id, 'gh-1');
  assert.equal(summary.signature_present, true);
  assert.equal(summary.content_type, 'application/json');
});

test('buildHeadersSummary: signature_present is false when no signature header is present', () => {
  const summary = buildHeadersSummary({ 'x-github-event': 'push' });
  assert.equal(summary.signature_present, false);
  assert.equal(summary.event_type, 'push');
});

// The webhook body/instructions still round-trip through the shared markdown
// parser (frontmatter + body split); confirm that pure surface directly.
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
