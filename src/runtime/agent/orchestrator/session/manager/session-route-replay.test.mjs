import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-route-replay-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'));
const { drainSessionStore, saveSessionAsync, loadSession } = await import('../store.mjs');
const { updateSessionRoute } = await import('./session-lifecycle.mjs');
const { settleSessionSummaryIndex } = await import('../store/listing.mjs');

test.after(async () => {
  drainSessionStore();
  await settleSessionSummaryIndex();
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

const replayAssistant = () => ({
  role: 'assistant',
  content: 'answer',
  providerReplay: { items: [{ type: 'reasoning' }] },
  reasoning: 'r',
  thinkingBlocks: [{ type: 'thinking' }],
  assistantBlocks: [{ type: 'text', text: 'answer' }],
  reasoningItems: [{ id: 'rs_1' }],
  reasoningContent: 'thoughts',
  providerMetadata: { gemini: { thoughtParts: [{ thought: true }] } },
});

// The route save is fire-and-forget; wait until it has landed on disk.
async function persisted(id) {
  const file = join(root, 'sessions', `${id}.json`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8'));
      if (stored.model === 'gpt-x') return stored;
    } catch {
      // Not written yet (or mid-write): poll again.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('route update was never persisted');
}

async function plant(id) {
  await saveSessionAsync(
    {
      id,
      provider: 'anthropic-oauth',
      model: 'claude-x',
      cwd: root,
      messages: [{ role: 'user', content: 'hi' }, replayAssistant()],
      generation: 0,
      closed: false,
    },
    { expectedGeneration: 0 }
  );
}

test('a cross-provider route change strips every provider replay field', async () => {
  const id = `sess_replay_cross_${process.pid}`;
  await plant(id);
  updateSessionRoute(id, { provider: 'openai-oauth', model: 'gpt-x' }, { crossProvider: true });
  const assistant = loadSession(id).messages[1];
  assert.deepEqual(assistant, { role: 'assistant', content: 'answer' });
  assert.deepEqual((await persisted(id)).messages[1], { role: 'assistant', content: 'answer' });
});

test('an ordinary route change keeps provider replay fields', async () => {
  const id = `sess_replay_plain_${process.pid}`;
  await plant(id);
  updateSessionRoute(id, { provider: 'openai-oauth', model: 'gpt-x' });
  assert.ok(loadSession(id).messages[1].assistantBlocks);
  assert.ok((await persisted(id)).messages[1].assistantBlocks);
});

test('a route change on the live turn object changes that object in place, whatever copy the id loads', async () => {
  const id = `sess_replay_live_${process.pid}`;
  await plant(id);
  // Without it the id's own loaded object takes the change (the previous behaviour, still the default).
  assert.equal(updateSessionRoute(id, { provider: 'openai-oauth', model: 'gpt-x' }), loadSession(id));
  // A turn that holds another object for the id (a reload after another process took the generation).
  const turn = {
    ...loadSession(id),
    provider: 'anthropic-oauth',
    model: 'claude-x',
    messages: [{ role: 'user', content: 'live turn' }, replayAssistant()],
    turnHop: 3,
  };
  const returned = updateSessionRoute(
    id,
    { provider: 'openai-oauth', model: 'gpt-x' },
    { crossProvider: true, session: turn }
  );
  assert.equal(returned, turn, 'the live object itself is returned');
  assert.equal(turn.provider, 'openai-oauth');
  assert.equal(turn.model, 'gpt-x');
  assert.deepEqual(turn.messages[1], { role: 'assistant', content: 'answer' }, 'its own messages were stripped');
  assert.equal(turn.messages[0].content, 'live turn');
  assert.equal(turn.turnHop, 3, 'turn state is untouched');
  assert.equal(JSON.parse(JSON.stringify(turn)).turnHop, 3, 'and survives a save');
  assert.equal(loadSession(id), turn, 'it is the live object from now on');
  // A closed session is refused as before, and an object of another id is ignored.
  assert.equal(updateSessionRoute(id, { model: 'x' }, { session: { id: 'other', model: 'q' } }) === turn, true);
  assert.equal(updateSessionRoute(id, { model: 'y' }, { session: { ...turn, closed: true } }), null);
});
