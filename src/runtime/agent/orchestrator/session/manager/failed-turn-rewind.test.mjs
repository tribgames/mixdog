import assert from 'node:assert/strict';
import test from 'node:test';
import { withRuntimeUserContext } from '../runtime-user-context.mjs';
import { rewindUnansweredPrompt, trailingUnansweredPromptIndex } from './failed-turn-rewind.mjs';

const PROMPT = '전체 테스트 돌려줘';
const system = { role: 'system', content: 'environment' };
// The persisted user turn carries the runtime reminder suffix; the retry
// resubmits only the human text.
const prompt = withRuntimeUserContext(
  { role: 'user', content: PROMPT, meta: { transcript: { at: 1 } } },
  { suffix: '\n\n<system-reminder>\n# Current Time\nnow\n</system-reminder>' }
);

test('an unanswered prompt repeated by the retry is rewound with its provider state', () => {
  const session = {
    messages: [system, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, prompt],
    providerState: { chain: 'resp_1' },
    _providerPrefixGuardState: { snapshot: 4 },
  };
  assert.equal(trailingUnansweredPromptIndex(session.messages, `${PROMPT}\n`), 3);
  assert.equal(rewindUnansweredPrompt(session, PROMPT), true);
  assert.deepEqual(
    session.messages.map((message) => message.role),
    ['system', 'user', 'assistant']
  );
  assert.equal(session.providerState, undefined);
  assert.equal('_providerPrefixGuardState' in session, false);
});

test('a tail answered by assistant or tool output is kept so the retry continues from it', () => {
  for (const tail of [
    { role: 'assistant', content: 'partial answer' },
    { role: 'tool', toolCallId: 'call_1', content: 'ok' },
  ]) {
    const session = { messages: [system, prompt, tail] };
    assert.equal(rewindUnansweredPrompt(session, PROMPT), false);
    assert.equal(session.messages.length, 3);
  }
});

test('a resubmission that does not repeat the prompt never rewinds', () => {
  const session = { messages: [system, prompt], providerState: { chain: 'resp_1' } };
  assert.equal(rewindUnansweredPrompt(session, 'Continue from where you left off.'), false);
  assert.equal(rewindUnansweredPrompt(session, ''), false);
  assert.equal(session.messages.length, 2);
  assert.deepEqual(session.providerState, { chain: 'resp_1' });
});

test('a prompt carrying media is not rewound by a text-only resubmission', () => {
  const session = {
    messages: [system, { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: 'AAAA' }] }],
  };
  assert.equal(rewindUnansweredPrompt(session, 'look'), false);
  assert.equal(session.messages.length, 2);
});
