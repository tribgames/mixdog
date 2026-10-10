import assert from 'node:assert/strict';
import test from 'node:test';
import { previousHumanContext, PREVIOUS_HUMAN_POLICY } from './previous-human-request.mjs';
import { withRuntimeUserContext } from '../agent/orchestrator/session/runtime-user-context.mjs';

const user = (content, meta) => ({ role: 'user', content, ...(meta ? { meta } : {}) });
const asst = (content, extra = {}) => ({ role: 'assistant', content, ...extra });

test('empty and non-array history', () => {
  for (const input of [[], undefined, null]) {
    const r = previousHumanContext(input);
    assert.equal(r.prevHuman, null);
    assert.equal(r.prevHumanMissing, 'empty-history');
    assert.equal(r.canonicalReply, null);
    assert.equal(r.pairedReply, null);
    assert.equal(r.boundary, 0);
  }
});

test('simple turn pairs request and reply with original indices', () => {
  const r = previousHumanContext([user(' fix it '), asst('done'), { role: 'system', content: 's' }]);
  assert.deepEqual(r.prevHuman, { text: 'fix it', index: 0, source: null, runtimeContext: 'none' });
  assert.deepEqual(r.canonicalReply, { text: 'done', index: 1 });
  assert.deepEqual(r.pairedReply, { text: 'done', index: 1 });
  assert.equal(r.replyIsPaired, true);
});

test('role blocks: content arrays, tool messages, empty assistants', () => {
  const r = previousHumanContext([
    user([{ type: 'text', text: 'part a' }, { type: 'text', text: 'part b' }]),
    asst('', { toolCalls: [{ id: 'c1' }] }),
    { role: 'tool', toolCallId: 'c1', content: 'out' },
    asst([{ type: 'text', text: 'final' }]),
  ]);
  assert.equal(r.prevHuman.text, 'part a\npart b');
  assert.deepEqual(r.pairedReply, { text: 'final', index: 3 });
});

test('tool-only reply: canonical falls back to an older turn, paired never does', () => {
  const r = previousHumanContext([
    user('first'),
    asst('answer one'),
    user('second'),
    asst('', { toolCalls: [{ id: 'c' }] }),
    { role: 'tool', toolCallId: 'c', content: 'x' },
  ]);
  assert.equal(r.prevHuman.text, 'second');
  assert.deepEqual(r.canonicalReply, { text: 'answer one', index: 1 });
  assert.equal(r.pairedReply, null);
  assert.equal(r.pairedMissing, 'no-assistant-text-in-turn');
  assert.equal(r.replyIsPaired, false);
});

test('trailing unanswered user prompt is the previous human request when not a retry', () => {
  const r = previousHumanContext([user('a'), asst('b'), user('c')]);
  assert.equal(r.prevHuman.text, 'c');
  assert.equal(r.pairedReply, null);
  assert.deepEqual(r.canonicalReply, { text: 'b', index: 1 });
});

test('retry trims the stale unanswered copy; non-matching or answered retry does not', () => {
  const messages = [user('a'), asst('b'), withRuntimeUserContext(user('again'), { prefix: '# ctx\n' })];
  const r = previousHumanContext(messages, { retryPrompt: 'again' });
  assert.equal(r.retryTrimmedIndex, 2);
  assert.equal(r.boundary, 2);
  assert.equal(r.prevHuman.text, 'a');
  assert.deepEqual(r.pairedReply, { text: 'b', index: 1 });
  assert.equal(previousHumanContext(messages, { retryPrompt: 'other' }).prevHuman.text, 'again');
  const answered = [...messages, asst('ok')];
  const a = previousHumanContext(answered, { retryPrompt: 'again' });
  assert.equal(a.retryTrimmedIndex, -1);
  assert.equal(a.prevHuman.text, 'again');
});

test('runtime user context is stripped using recorded provenance only', () => {
  const wrapped = withRuntimeUserContext(user('real words'), {
    prefix: '# Context\n',
    suffix: '\n<system-reminder>time</system-reminder>',
  });
  const r = previousHumanContext([wrapped, asst('ok')]);
  assert.equal(r.prevHuman.text, 'real words');
  assert.equal(r.prevHuman.runtimeContext, 'stripped');
  const stale = { ...wrapped, content: `edited ${wrapped.content}` };
  assert.equal(previousHumanContext([stale]).prevHuman.runtimeContext, 'none');
});

test('synthetic runtime-owned user messages are skipped and reported', () => {
  const r = previousHumanContext([
    user('build it'),
    asst('plan'),
    user('continue the goal', { source: 'goal-continuation', synthetic: true }),
    asst('step'),
    user('<system-reminder>\nlone reminder\n</system-reminder>'),
    user('note', { source: 'task-notification' }),
    user('resume', { source: 'max-output-recovery' }),
  ]);
  assert.equal(r.prevHuman.index, 0);
  assert.deepEqual(
    r.skipped.map((s) => [s.index, s.reason]),
    [
      [6, 'runtime-owned'],
      [5, 'typed-source'],
      [4, 'protected-context'],
      [2, 'synthetic-flag'],
    ]
  );
  // The synthetic continuation stays inside the turn: its reply is the latest paired text.
  assert.deepEqual(r.pairedReply, { text: 'step', index: 3 });
  assert.equal(r.replyIsPaired, true);
});

test('human steering with meta.source is kept and ends the earlier turn span', () => {
  const r = previousHumanContext([
    user('start work'),
    asst('working'),
    user('actually use B', { source: 'steering' }),
    asst('switching'),
  ]);
  assert.equal(r.prevHuman.text, 'actually use B');
  assert.equal(r.prevHuman.source, 'steering');
  assert.equal(r.prevHuman.index, 2);
  assert.deepEqual(r.pairedReply, { text: 'switching', index: 3 });
  assert.equal(r.skipped.length, 0);
});

test('compaction summary alone yields no human request', () => {
  const r = previousHumanContext([user('S', { source: 'compact-summary' }), asst('.')]);
  assert.equal(r.prevHuman, null);
  assert.equal(r.prevHumanMissing, 'no-human-request');
  assert.equal(r.pairedMissing, 'no-human-request');
  assert.deepEqual(r.canonicalReply, { text: '.', index: 1 });
});

test('a compaction boundary does not recover an older human request', () => {
  const history = [
    user('old request'),
    asst('old reply'),
    user('compacted context', { source: 'compact-summary' }),
    asst('summary follow-up'),
  ];
  const result = previousHumanContext(history);
  assert.equal(result.prevHuman, null);
  assert.equal(result.replyIsPaired, false);
  assert.deepEqual(result.canonicalReply, { text: 'summary follow-up', index: 3 });
  assert.equal(previousHumanContext([...history, user('new request'), asst('new reply')]).prevHuman.text, 'new request');
});

test('does not mutate input and policy is frozen', () => {
  const messages = [withRuntimeUserContext(user('x'), { prefix: 'p\n' }), asst('y'), user('z')];
  const before = JSON.stringify(messages);
  previousHumanContext(messages, { retryPrompt: 'z' });
  assert.equal(JSON.stringify(messages), before);
  assert.ok(Object.isFrozen(PREVIOUS_HUMAN_POLICY));
});
