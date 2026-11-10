import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { digestFromSnapshots, execThreadParams, routeContractFromSnapshot, wireTools } from './contract-hash-rust.mjs';
import { changedContracts } from './fast8-ten-analysis-rust.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const sha = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

const read = { name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } };
const grep = { name: 'grep', description: 'Search', inputSchema: { type: 'object', properties: {} } };
const snapshot = (overrides = {}) => ({
  provider: 'openai-oauth',
  model: 'gpt-5.6-sol',
  providerMode: 'native',
  system: ['rules', 'env'],
  tools: [],
  catalog: [read, grep],
  active: [read],
  disallowedTools: ['memory', 'recall'],
  body: { model: 'gpt-5.6-sol', tools: [{ type: 'function', name: 'read', parameters: read.inputSchema }] },
  ...overrides,
});

test('a route contract hashes the snapshot the core returned', () => {
  const route = { id: 'lead', provider: 'openai-oauth', model: 'gpt-5.6-sol' };
  const contract = routeContractFromSnapshot(route, snapshot());
  assert.equal(contract.toolCatalogHash, sha(JSON.stringify([read, grep])));
  assert.equal(contract.toolCatalogCount, 2);
  assert.deepEqual(contract.toolCatalogNames, ['grep', 'read']);
  assert.equal(contract.activeToolCount, 1);
  assert.deepEqual(contract.disabledTools, ['memory', 'recall']);
  assert.equal(contract.providerToolCount, 1);
  const providerPayload = JSON.stringify({ provider: 'openai-oauth', model: 'gpt-5.6-sol', tools: snapshot().body.tools });
  assert.equal(contract.providerToolHash, sha(providerPayload));
  assert.equal(contract.providerToolBytes, Buffer.byteLength(providerPayload));
  assert.equal(contract.promptSurfaceHash, sha('rules\n\0\nenv'));
});

test('the wire tools are found where the codec puts them, and Gemini counts declarations', () => {
  assert.deepEqual(wireTools({ tools: [1] }), [1]);
  assert.deepEqual(wireTools({ request: { tools: [2] } }), [2]);
  assert.deepEqual(wireTools('not json'), []);
  const gemini = routeContractFromSnapshot({ id: 'lead', provider: 'gemini', model: 'g' }, snapshot({ body: { request: { tools: [{ functionDeclarations: [{ name: 'a' }, { name: 'b' }] }] } } }));
  assert.equal(gemini.providerToolCount, 2);
});

test('the digest has the shape of contract-hash.mjs, per route, and says where it came from', () => {
  const digest = digestFromSnapshots(REPO_ROOT, 'headless', [
    { id: 'lead', provider: 'openai-oauth', model: 'gpt-5.6-sol', snapshot: snapshot() },
    { id: 'leadFallback', provider: 'anthropic-oauth', model: 'claude-opus-4-8', snapshot: snapshot({ active: [grep], body: { tools: [{ name: 'grep' }] } }) },
  ]);
  assert.equal(digest.schemaVersion, 2);
  assert.equal(digest.source, 'mixdogd');
  assert.deepEqual(Object.keys(digest.routeContracts), ['lead', 'leadFallback']);
  assert.equal(digest.toolCount, 2);
  assert.equal(digest.activeToolCount, 1);
  assert.notEqual(digest.routeContracts.lead.providerToolHash, digest.routeContracts.leadFallback.providerToolHash);
  assert.ok(digest.rulesFiles > 0);
  for (const key of ['promptSurfaceHash', 'toolContractHash', 'rulesHash', 'toolCatalogHash', 'activeToolHash', 'providerToolHash']) {
    assert.match(digest[key], /^sha256:[0-9a-f]{64}$/, key);
  }
});

test('the thread a route is snapshotted on starts as mixdogd exec starts it', () => {
  const params = execThreadParams({ provider: 'openai-oauth', model: 'gpt-5.6-sol' }, '/work', 'headless');
  assert.deepEqual(params.session, { toolProfile: 'headless', toolMode: 'full', approvalMode: 'implicit', disallowDelegation: true, autoWakeCompletions: false, webSearch: true, memory: false });
  assert.deepEqual(params.draft.route, { provider: 'openai-oauth', model: 'gpt-5.6-sol' });
  assert.equal(params.draft.workflowId, 'headless');
});

test('a changed non-description contract is named, a changed description is not', () => {
  const baseline = [read, grep];
  assert.deepEqual(changedContracts([{ ...read, description: 'reworded' }], baseline), []);
  assert.deepEqual(changedContracts([{ ...read, inputSchema: { type: 'object', properties: { file: { type: 'string' } } } }], baseline), ['read']);
  assert.deepEqual(changedContracts([{ name: 'unknown', inputSchema: {} }], baseline), []);
  const reordered = { name: 'read', inputSchema: { properties: { path: { type: 'string' } }, type: 'object' }, description: 'x' };
  assert.deepEqual(changedContracts([reordered], baseline), [], 'key order is not a contract');
});
