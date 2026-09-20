import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-transcript-intake-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const { createTranscriptIntake } = await import('./transcript-intake.mjs');
const { loadPromptHistory } = await import('../prompt-history-store.mjs');

function createHarness() {
  const cwd = join(dataDir, 'project');
  let state = { items: [], cwd };
  const patches = [];
  const flags = { pendingTranscriptMeta: null };
  const intake = createTranscriptIntake({
    getState: () => state,
    flags,
    pushItem: (item) => {
      state = { ...state, items: [...state.items, item] };
    },
    patchItem: (id, patch) => {
      patches.push({ id, patch });
      state = { ...state, items: state.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) };
    },
    transcriptRouteMetadata: () => ({ provider: 'p', model: 'm' }),
  });
  return { intake, flags, patches, cwd, getState: () => state };
}

test('a typed user prompt becomes a user item with route metadata and persisted history', () => {
  const { intake, flags, cwd, getState } = createHarness();
  intake.pushUserOrSyntheticItem('hello there', 'u1', 'user', { sender: 'desktop', images: [{ name: 'a.png' }] });
  assert.deepEqual(getState().items, [
    {
      kind: 'user',
      id: 'u1',
      text: 'hello there',
      provider: 'p',
      model: 'm',
      sender: 'desktop',
      images: [{ name: 'a.png' }],
    },
  ]);
  assert.deepEqual(flags.pendingTranscriptMeta, { provider: 'p', model: 'm' });
  assert.deepEqual(loadPromptHistory(cwd), ['hello there']);
});

test('injected runtime text that is model-only never renders', () => {
  const { intake, getState } = createHarness();
  intake.pushUserOrSyntheticItem(
    '<system-reminder>\nDeferred tools are now available: browser\n</system-reminder>',
    'i1',
    'injected'
  );
  assert.deepEqual(getState().items, []);
});

test('synthetic cards upsert by task id instead of duplicating', () => {
  const { intake, patches, getState } = createHarness();
  const card = { name: 'agent', taskId: 'job-1', label: 'completed', summary: 'done', result: 'ok' };
  assert.equal(intake.upsertSyntheticToolItem('raw', 'c1', card), true);
  assert.equal(intake.upsertSyntheticToolItem('raw again', 'c2', { ...card, result: 'ok2' }), true);
  assert.equal(getState().items.length, 1);
  assert.equal(patches.length, 1);
  assert.equal(getState().items[0].id, 'c1');
  assert.equal(getState().items[0].result, 'ok2');
  assert.equal(getState().items[0].isError, false);
  assert.equal(intake.upsertSyntheticToolItem('plain prose', 'c3'), false);
});

test('pushAsyncAgentResponse falls back to the user/synthetic path for plain text', () => {
  const { intake, getState } = createHarness();
  intake.pushAsyncAgentResponse('plain reply', 'r1', 'injected');
  assert.equal(getState().items.length, 1);
  assert.equal(getState().items[0].kind, 'user');
  assert.equal(getState().items[0].id, 'r1');
});
