import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-session-titles-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'));
const { drainSessionStore, saveSessionAsync } = await import('../store.mjs');
const { settleSessionSummaryIndex } = await import('../store/listing.mjs');
const { getSession, updateSessionAiTitle, updateSessionManualTitle, updateSessionGeneratedTitle } = await import(
  './session-crud.mjs'
);

test.after(async () => {
  drainSessionStore();
  await settleSessionSummaryIndex();
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

async function plant(id, extra = {}) {
  const session = { id, provider: 'openai', model: 'm', cwd: root, messages: [], generation: 0, closed: false, ...extra };
  await saveSessionAsync(session, { expectedGeneration: session.generation });
}

test('an AI title locks out generated titles but yields to the user', async () => {
  await plant('t-ai');
  assert.deepEqual(await updateSessionAiTitle('t-ai', '  Fix   login  '), { ok: true, title: 'Fix login' });
  const stored = getSession('t-ai');
  assert.equal(stored.titleSource, 'ai');
  assert.equal(stored.titleLocked, true);
  assert.equal(await updateSessionGeneratedTitle('t-ai', 'auto', 'first'), false);
  assert.deepEqual(await updateSessionAiTitle('t-ai', 'Better'), { ok: true, title: 'Better' });
  assert.equal(await updateSessionManualTitle('t-ai', 'Mine'), true);
  assert.equal(getSession('t-ai').titleSource, 'user');
  assert.deepEqual(await updateSessionAiTitle('t-ai', 'Again'), { ok: false, reason: 'user-title' });
  assert.equal(getSession('t-ai').title, 'Mine');
});

test('legacy locked titles without a titleSource count as user titles', async () => {
  await plant('t-legacy', { title: 'Old', titleLocked: true });
  assert.deepEqual(await updateSessionAiTitle('t-legacy', 'AI'), { ok: false, reason: 'user-title' });
  assert.equal(getSession('t-legacy').title, 'Old');
});

test('a manual rename to the identical title still takes ownership from the AI', async () => {
  await plant('t-same');
  await updateSessionAiTitle('t-same', 'Same');
  assert.equal(await updateSessionManualTitle('t-same', 'Same'), true);
  assert.equal(getSession('t-same').titleSource, 'user');
  assert.deepEqual(await updateSessionAiTitle('t-same', 'Other'), { ok: false, reason: 'user-title' });
});
