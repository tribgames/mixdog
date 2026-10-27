// Fallback chains of Lead-class sessions: the coding Lead takes the Lead
// preset's, a bot's home chat and Mixy their own route's; only while the
// session runs on the owner's primary model.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-owner-fallbacks-'));
test.after(() => rmSync(root, { recursive: true, force: true }));
const dataDir = join(root, 'data');
mkdirSync(join(dataDir, 'bots', 'sample'), { recursive: true });
mkdirSync(join(dataDir, 'bots', 'plain'), { recursive: true });
mkdirSync(join(dataDir, 'bots', 'mixy'), { recursive: true });
writeFileSync(join(dataDir, 'bots', 'migration.json'), JSON.stringify({ version: 1, bots: ['sample', 'plain'] }));
const route = (provider, model, fallbacks) =>
  JSON.stringify({ route: { provider, model, ...(fallbacks ? { fallbacks } : {}) } });
writeFileSync(join(dataDir, 'bots', 'sample', 'agent.json'), route('p1', 'm1', [{ provider: 'p2', model: 'm2' }]));
writeFileSync(join(dataDir, 'bots', 'plain', 'agent.json'), route('p1', 'm1'));
writeFileSync(join(dataDir, 'bots', 'mixy', 'agent.json'), route('p3', 'm3', [{ provider: 'p4', model: 'm4' }]));

const { registerBotRouteStore } = await import('../../../../shared/agent-store.mjs');
registerBotRouteStore(() => dataDir);
const { ownerRouteFallbacks } = await import('./owner-route-fallbacks.mjs');

const config = {
  default: 'workflow-lead',
  presets: [
    {
      id: 'workflow-lead',
      name: 'WORKFLOW LEAD',
      provider: 'p1',
      model: 'm1',
      fallbacks: [{ provider: 'p9', model: 'm9' }],
    },
  ],
};

test('the coding Lead takes the Lead preset chain while on the Lead model', () => {
  const lead = { sessionMode: 'coding', agentId: 'lead', config };
  assert.deepEqual(ownerRouteFallbacks({ ...lead, provider: 'p1', model: 'm1' }), [{ provider: 'p9', model: 'm9' }]);
  // A model picked for this session (composer, New Task) gets none.
  assert.deepEqual(ownerRouteFallbacks({ ...lead, provider: 'p1', model: 'other' }), []);
  // No fallbacks stored: unchanged behaviour.
  const bare = { default: 'workflow-lead', presets: [{ id: 'workflow-lead', provider: 'p1', model: 'm1' }] };
  assert.deepEqual(ownerRouteFallbacks({ ...lead, config: bare, provider: 'p1', model: 'm1' }), []);
});

test('a stored fallback on the Lead model provider is inactive; the other fallbacks still apply', () => {
  const stored = {
    default: 'workflow-lead',
    presets: [
      {
        id: 'workflow-lead',
        provider: 'anthropic-oauth',
        model: 'opus',
        fallbacks: [
          { provider: 'anthropic-oauth', model: 'sonnet' },
          { provider: 'openai', model: 'gpt' },
        ],
      },
    ],
  };
  const lead = { sessionMode: 'coding', agentId: 'lead', config: stored, provider: 'anthropic-oauth', model: 'opus' };
  assert.deepEqual(ownerRouteFallbacks(lead), [{ provider: 'openai', model: 'gpt' }]);
});

test('a bot and Mixy use their own folder route, never the Lead or each other', () => {
  const agent = { sessionMode: 'agent', config };
  assert.deepEqual(ownerRouteFallbacks({ ...agent, agentId: 'sample', provider: 'p1', model: 'm1' }), [
    { provider: 'p2', model: 'm2' },
  ]);
  assert.deepEqual(ownerRouteFallbacks({ ...agent, agentId: 'lead', provider: 'p3', model: 'm3' }), [
    { provider: 'p4', model: 'm4' },
  ]);
  // Mixy on the Lead's model is not on its own primary.
  assert.deepEqual(ownerRouteFallbacks({ ...agent, agentId: 'lead', provider: 'p1', model: 'm1' }), []);
  assert.deepEqual(ownerRouteFallbacks({ ...agent, agentId: 'plain', provider: 'p1', model: 'm1' }), []);
  assert.deepEqual(ownerRouteFallbacks({ ...agent, agentId: '', provider: 'p1', model: 'm1' }), []);
});
