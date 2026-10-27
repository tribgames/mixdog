import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-xai-effort-'));
test.after(() => rmSync(dataDir, { recursive: true, force: true }));
const row = (reasoning_options) => ({
  id: 'x',
  reasoning: true,
  tool_call: true,
  ...(reasoning_options ? { reasoning_options } : {}),
});
const effort = (...values) => [{ type: 'effort', values }];
// Every id is a fixture: the catalog's declaration alone decides.
writeFileSync(
  join(dataDir, 'modelsdev-catalog.json'),
  JSON.stringify({
    fetchedAt: Date.now(),
    data: {
      xai: {
        models: {
          'grok-9-fixture': row(effort('low', 'high')),
          // Listed, reasoning, but publishes no effort values.
          'grok-9-noeffort': row(),
          // A legacy-shaped id the catalog declares effort values for.
          'grok-3-declared': row(effort('low', 'high')),
        },
      },
    },
  })
);
writeFileSync(join(dataDir, 'litellm-catalog.json'), JSON.stringify({ fetchedAt: Date.now(), data: {} }));
process.env.MIXDOG_DATA_DIR = dataDir;

const { xaiModelSupportsReasoningEffort } = await import('./openai-compat-xai.mjs');

test('a listed model takes the effort exactly when the catalog publishes effort values', () => {
  assert.equal(xaiModelSupportsReasoningEffort('grok-9-fixture'), true);
  assert.equal(xaiModelSupportsReasoningEffort('GROK-9-FIXTURE'), true);
  assert.equal(xaiModelSupportsReasoningEffort('grok-9-noeffort'), false);
});

test('the catalog outranks the legacy id shape', () => {
  assert.equal(xaiModelSupportsReasoningEffort('grok-3-declared'), true);
});

test('a model the catalog does not list yet is sent the effort, whatever its id', () => {
  for (const id of ['grok-9-unlisted', 'grok-5', 'grok-4.9', 'grok-4.20-x', 'grok-40', 'grok-build-0.2', '']) {
    assert.equal(xaiModelSupportsReasoningEffort(id), true, id);
  }
  // Not a Grok id: a custom xAI-compatible deployment keeps the caller's choice.
  assert.equal(xaiModelSupportsReasoningEffort('custom-reasoner'), true);
});

test('the closed legacy generation that rejects any effort is held back offline', () => {
  for (const id of ['grok-3', 'grok-3-mini', 'grok-4', 'grok-4-0709', 'grok-4-fast-reasoning', 'grok-code-fast-1']) {
    assert.equal(xaiModelSupportsReasoningEffort(id), false, id);
  }
});
