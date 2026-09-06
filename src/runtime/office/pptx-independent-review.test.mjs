import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preparePacket, reviewPrompt, runReview, validatePacket, validateReview } from '../../defaults/skills/pptx/scripts/review-deck.mjs';

const packet = () => ({
  task: 'Explain the annual result to a finance reader.',
  sources: ['source.md'],
  questions: [{ id: 'Q1', question: 'What period is shown?', answer: 'WITHHELD ANSWER' }],
  candidates: [{ id: 'C1', pages: ['preferred-author-design.png'], rationale: 'AUTHOR PREFERENCE' }],
  critique: 'AUTHOR SELF SCORE',
});
const response = () => ({
  selection: { candidateId: null, reason: 'Neither candidate clearly answers the question.' },
  candidates: [{
    id: 'C1', pages: [{ page: 1, verdict: 'fix', observations: ['The period is absent from this page.'] }],
    answers: [{ id: 'Q1', status: 'missing', answer: 'Not visible.', evidencePages: [] }],
  }],
});
async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), 'ppt-review-packet-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  await writeFile(join(path, 'source.md'), 'Original source: year ended June 30, 2025.');
  await writeFile(join(path, 'preferred-author-design.png'), 'image fixture');
  const input = join(path, 'packet.json');
  await writeFile(input, JSON.stringify(packet()));
  return { path, input };
}

test('review inputs omit author rationale, answers, and revealing image filenames', async (t) => {
  const { path, input } = await fixture(t);
  const copied = await preparePacket(input, path);
  const prompt = reviewPrompt(copied.packet);
  for (const value of ['WITHHELD ANSWER', 'AUTHOR PREFERENCE', 'AUTHOR SELF SCORE', 'preferred-author-design']) {
    assert.equal(prompt.includes(value), false);
  }
  assert.equal(await readFile(copied.packet.sources[0], 'utf8'), 'Original source: year ended June 30, 2025.');
  assert.equal(copied.files.length, 2);
  assert.ok(copied.files.every((f) => /^[a-f0-9]{64}$/.test(f.sha256)));
});

test('review packet bounds and file types fail before provider execution', async (t) => {
  const { path, input } = await fixture(t);
  assert.throws(() => validatePacket({ ...packet(), candidates: [{ id: 'C1', pages: Array(25).fill('page.png') }] }), /1-24/);
  assert.throws(() => validatePacket({ ...packet(), questions: [{ id: 'Q1', question: 'a' }, { id: 'Q1', question: 'b' }] }), /unique/);
  await writeFile(input, JSON.stringify({ ...packet(), sources: ['author.js'] }));
  await assert.rejects(preparePacket(input, path), /unsupported source extension/);
});

test('review may reject all but incomplete coverage and invented evidence fail', () => {
  const valid = validatePacket(packet());
  assert.equal(validateReview(JSON.stringify(response()), valid).selection.candidateId, null);
  for (const corrupt of [
    (r) => { r.candidates[0].pages = []; },
    (r) => { r.candidates[0].answers[0].evidencePages = [2]; },
    (r) => { r.candidates[0].answers[0].status = 'answered'; },
    (r) => { r.selection.candidateId = 'winner'; },
  ]) {
    const r = response(); corrupt(r);
    assert.throws(() => validateReview(JSON.stringify(r), valid));
  }
});

test('runner uses fresh headless execution with the existing readonly policy and preserves rejected results', async (t) => {
  const { path, input } = await fixture(t);
  const output = join(path, 'report.json');
  let called = 0;
  const result = await runReview({ input, output, provider: 'test-provider', model: 'test-model' }, {
    createRuntime: async (options) => {
      assert.equal(options.toolMode, 'readonly');
      assert.equal(options.toolProfile, 'headless');
      return {};
    },
    execute: async (options) => {
      called++;
      assert.equal(options.webSearch, false);
      assert.notEqual(options.cwd, path);
      await options.runtimeFactory({ toolProfile: 'headless', toolMode: 'full' });
      options.write(JSON.stringify(response()));
      return 0;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.review.selection.candidateId, null);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).raw, JSON.stringify(response()));
  await assert.rejects(runReview({ input, output, provider: 'test-provider', model: 'test-model' }, {
    execute: async () => { called++; return 0; },
  }), /EEXIST/);
  assert.equal(called, 1);
});

test('execution and malformed-review failures are preserved, never promoted to a pass', async (t) => {
  const { path, input } = await fixture(t);
  for (const [name, execute] of [
    ['execution', async () => { throw new Error('provider unavailable'); }],
    ['malformed', async (options) => { options.write('not a review'); return 0; }],
  ]) {
    const output = join(path, `${name}.json`);
    const result = await runReview({ input, output, provider: 'test', model: 'test' }, { execute });
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).ok, false);
  }
});
