// A titleless session keeps a durable fallback title derived from its first
// human prompt: it survives compaction and a cold reload, a generated title can
// still replace it, and a manual/generated title is never overwritten.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';

import { makeTempDirSync } from '../../../../../scripts/lib/scoped-temp.mjs';
const dataDir = makeTempDirSync('fallback-title');
process.env.MIXDOG_DATA_DIR = dataDir;
const { runSessionCompaction } = await import('./manager/compaction-runner.mjs');
const { updateSessionGeneratedTitle } = await import('./manager/session-crud.mjs');
const { backfillFallbackSessionTitle, fallbackTitleFromMessages, fallbackTitleFromText } = await import(
  './manager/session-fallback-title.mjs'
);
const { drainSessionStore, evictLiveSession, loadSession, saveSessionAsync } = await import('./store.mjs');
const { settleSessionSummaryIndex } = await import('./store/listing.mjs');

test.after(async () => {
  drainSessionStore();
  await settleSessionSummaryIndex();
  rmSync(dataDir, { recursive: true, force: true });
});

const SUMMARY = [
  '## Goal',
  '- keep the work',
  '',
  '## Constraints & Preferences',
  '- (none)',
  '',
  '## Progress',
  '### Done',
  '- older turns summarized',
  '',
  '### In Progress',
  '- (none)',
  '',
  '### Blocked',
  '- (none)',
  '',
  '## Key Decisions',
  '- (none)',
  '',
  '## Next Steps',
  '- continue',
  '',
  '## Critical Context',
  '- (none)',
  '',
  '## Relevant Files',
  '- (none)',
].join('\n');

const FIRST_PROMPT = 'Fix the login redirect bug';

function titlelessSession(tag, extra = {}) {
  const messages = [{ role: 'system', content: 'system rules stay exact' }];
  for (let turn = 0; turn < 30; turn += 1) {
    const id = `call-${turn}`;
    messages.push(
      { role: 'user', content: `${turn === 0 ? FIRST_PROMPT : `request ${turn}`} ${'context '.repeat(400)}` },
      { role: 'assistant', content: '', toolCalls: [{ id, name: 'read', arguments: { path: `file-${turn}.txt` } }] },
      { role: 'tool', toolCallId: id, content: `result ${turn}\n${'line of output\n'.repeat(300)}` },
      { role: 'assistant', content: `answer ${turn} ${'detail '.repeat(400)}` }
    );
  }
  return {
    id: `sess_fallback_title_${process.pid}_${tag}`,
    provider: 'anthropic-oauth',
    model: 'fake-model',
    owner: 'agent',
    contextWindow: 100_000,
    compactBoundaryTokens: 100_000,
    messages,
    tools: [],
    generation: 0,
    closed: false,
    compaction: { conversationThresholdTokens: 1 },
    ...extra,
  };
}

async function compact(session) {
  const provider = { name: 'anthropic-oauth', send: async () => ({ content: SUMMARY }) };
  const result = await runSessionCompaction(session, {
    mode: 'manual',
    force: true,
    config: {},
    provider,
    model: 'fake-model',
  });
  assert.equal(result.changed, true);
  return result;
}

test('an older titleless session is backfilled before compaction and keeps the title across a cold reload', async () => {
  const session = titlelessSession('older');
  assert.equal(session.title, undefined);
  await compact(session);
  assert.ok(session.title.startsWith(FIRST_PROMPT), session.title);
  assert.ok(session.title.length <= 32);
  assert.equal(session.generatedTitleStage, undefined);
  assert.equal(session.titleLocked, undefined);
  const expected = session.title;

  await saveSessionAsync(session, { expectedGeneration: session.generation });
  evictLiveSession(session.id);
  assert.equal(loadSession(session.id).title, expected);

  // The fallback is not a generated stage: a generated title still replaces it.
  assert.equal(await updateSessionGeneratedTitle(session.id, 'Login redirect fix', 'first'), true);
  assert.equal(loadSession(session.id).title, 'Login redirect fix');
});

test('compaction never overwrites a manual or generated title', async () => {
  const manual = titlelessSession('manual', { title: 'My own name', titleLocked: true, titleSource: 'user' });
  await compact(manual);
  assert.equal(manual.title, 'My own name');

  const generated = titlelessSession('generated', { title: 'Generated name', generatedTitleStage: 'first' });
  await compact(generated);
  assert.equal(generated.title, 'Generated name');
  assert.equal(generated.generatedTitleStage, 'first');
});

test('injected turns are recognised by meta provenance and never win over the real prompt', () => {
  const real = { role: 'user', content: 'Fix the login bug' };
  for (const meta of [
    { source: 'goal-continuation', synthetic: true },
    { source: 'goal-closeout' },
    { source: 'task-notification' },
    { synthetic: true },
  ]) {
    assert.equal(
      fallbackTitleFromMessages([{ role: 'user', content: 'Continue with the plan', meta }, real]),
      'Fix the login bug',
      JSON.stringify(meta)
    );
  }
  assert.equal(
    fallbackTitleFromMessages([{ role: 'user', content: 'Imported words', meta: { source: 'import' } }]),
    'Imported words'
  );
});

test('attachment envelopes are stripped before truncation; payload-only prompts give no title', () => {
  const payload = `<file path="a.txt">${'secret payload '.repeat(500)}</file>`;
  assert.equal(fallbackTitleFromText(`${payload}\nRefactor the parser`), 'Refactor the parser');
  assert.equal(fallbackTitleFromText(`Refactor the parser ${payload}`), 'Refactor the parser');
  assert.equal(fallbackTitleFromText(payload), '');
  assert.equal(fallbackTitleFromText('<file path="a.txt">never closed payload'), '');
  assert.equal(fallbackTitleFromText('<attachment name="b.png"/> [Image #1]'), '');
  assert.equal(fallbackTitleFromText([{ type: 'text', text: `${payload} Summarize the diff` }]), 'Summarize the diff');
});

test('the fallback skips synthetic rows and never stores the untitled placeholder', () => {
  assert.equal(fallbackTitleFromMessages([{ role: 'user', content: '[mixdog-runtime] resumed' }]), '');
  assert.equal(fallbackTitleFromMessages([{ role: 'user', content: 'Untitled session' }]), '');
  assert.equal(fallbackTitleFromMessages([{ role: 'user', content: '[Image]' }]), '');
  assert.equal(
    fallbackTitleFromMessages([
      { role: 'user', content: '<system-reminder>clock</system-reminder>' },
      { role: 'user', content: '  Real   prompt\nwith lines ' },
    ]),
    'Real prompt with lines'
  );
  const placeholder = { title: 'Untitled session' };
  assert.equal(backfillFallbackSessionTitle(placeholder, [{ role: 'user', content: 'Real prompt' }]), true);
  assert.equal(placeholder.title, 'Real prompt');
  const none = {};
  assert.equal(backfillFallbackSessionTitle(none, [{ role: 'user', content: 'Untitled' }]), false);
  assert.equal(none.title, undefined);
});
