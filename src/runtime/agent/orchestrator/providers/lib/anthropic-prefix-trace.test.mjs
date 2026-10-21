import assert from 'node:assert/strict';
import test from 'node:test';
import {
  anthropicPrefixChanges,
  anthropicPrefixFingerprint,
  recordAnthropicPrefix,
} from './anthropic-prefix-trace.mjs';

const ttl = { type: 'ephemeral', ttl: '1h' };
function body({ bp3 = 'BP3 rules', marked = true, tools = [{ name: 'read' }] } = {}) {
  return {
    tools,
    system: [
      { type: 'text', text: 'prefix' },
      { type: 'text', text: 'BP1 secret rule text', cache_control: ttl },
      { type: 'text', text: 'BP2', cache_control: ttl },
      { type: 'text', text: bp3, ...(marked ? { cache_control: ttl } : {}) },
      { type: 'text', text: 'env' },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'tail', cache_control: { type: 'ephemeral' } }] },
    ],
  };
}

test('the fingerprint holds hashes and marker positions only, never text', () => {
  const print = anthropicPrefixFingerprint(body());
  assert.equal(print.system.length, 5);
  assert.match(print.tools, /^[0-9a-f]{12}$/);
  for (const hash of print.system) assert.match(hash, /^[0-9a-f]{12}$/);
  assert.deepEqual(print.markers, ['s1:1h', 's2:1h', 's3:1h', 'm1:5m']);
  assert.doesNotMatch(JSON.stringify(print), /secret|BP3 rules|tail/);
  // A marker does not change its block's hash: content and markers are told apart.
  assert.deepEqual(anthropicPrefixFingerprint(body({ marked: false })).system, print.system);
});

test('per session: which blocks and markers changed since the previous request', () => {
  const id = `sess-${Math.random()}`;
  assert.equal(anthropicPrefixChanges(id), null, 'nothing recorded');
  recordAnthropicPrefix(id, anthropicPrefixFingerprint(body()));
  assert.equal(anthropicPrefixChanges(id), null, 'one request has nothing to compare');
  recordAnthropicPrefix(id, anthropicPrefixFingerprint(body()));
  assert.deepEqual(anthropicPrefixChanges(id), { changedBlocks: 'none', markersChanged: false });
  recordAnthropicPrefix(id, anthropicPrefixFingerprint(body({ bp3: 'BP3 rules v2', marked: false })));
  assert.deepEqual(anthropicPrefixChanges(id), { changedBlocks: 's3', markersChanged: true });
  recordAnthropicPrefix(id, anthropicPrefixFingerprint(body({ tools: [{ name: 'grep' }] })));
  assert.deepEqual(anthropicPrefixChanges(id), { changedBlocks: 'tools,s3', markersChanged: true });
  recordAnthropicPrefix(null, anthropicPrefixFingerprint(body()));
});
