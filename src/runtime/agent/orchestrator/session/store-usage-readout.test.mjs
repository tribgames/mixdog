// A session opened cold (no runtime yet) must already carry the composer
// usage readout's totals in its stored snapshot: the line under the composer
// reads stats.usageReadout, and a cold session otherwise showed nothing until
// a turn started its runtime and published a live frame.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-store-usage-readout-'));
process.env.MIXDOG_DATA_DIR = dataDir;
mkdirSync(join(dataDir, 'sessions'));

const { readStoredSessionTranscript, clearStoredTranscriptCache } = await import('./store-summary-reader.mjs');

test.after(() => {
  clearStoredTranscriptCache();
  rmSync(dataDir, { recursive: true, force: true });
});

const usageReadout = {
  input: 1_200,
  cacheRead: 98_000,
  cacheWrite: 800,
  output: 4_000,
  requestOutputTokens: 4_000,
  requestMs: 50_000,
};

function writeSession(id, extra = {}) {
  const doc = {
    id,
    owner: 'user',
    agent: 'lead',
    closed: false,
    generation: 1,
    provider: 'openai-oauth',
    model: 'gpt-5.6-sol',
    cwd: dataDir,
    contextWindow: 272_000,
    rawContextWindow: 272_000,
    compactBoundaryTokens: 272_000,
    messages: [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
    tools: [],
    ...extra,
  };
  writeFileSync(join(dataDir, 'sessions', `${id}.json`), JSON.stringify(doc));
}

test('a cold open carries the persisted usage totals in its stats', async () => {
  writeSession('cold-with-usage', { usageReadout });
  const opened = await readStoredSessionTranscript('cold-with-usage', { transcriptItemLimit: 16 });
  assert.deepEqual(opened.stats.usageReadout, usageReadout);
});

test('a cold session that never made a call has no totals, not a made-up zero', async () => {
  writeSession('cold-no-usage');
  const opened = await readStoredSessionTranscript('cold-no-usage', { transcriptItemLimit: 16 });
  assert.equal(opened.stats.usageReadout ?? null, null);
});
