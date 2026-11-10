import assert from 'node:assert/strict';
import test from 'node:test';
import { redactToolCallSecretsInMessages } from './text-utils.mjs';

test('raw secret redaction consumes complete values and resumes at the next key', () => {
  const cases = [
    [
      'token=secret fileName=public.txt password="two words" mode=read',
      'token=[redacted] fileName=public.txt password=[redacted] mode=read',
    ],
    ['authorization: Bearer private.value, fileName=public.txt', 'authorization: [redacted], fileName=public.txt'],
    ['cookie: session=private; other=hidden\nfileName=public.txt', 'cookie: [redacted]\nfileName=public.txt'],
    ['accessToken=private fileName=public.txt', 'accessToken=[redacted] fileName=public.txt'],
    ['password="unterminated secret', 'password=[redacted]'],
  ];
  for (const [input, expected] of cases) {
    const message = { role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'read', arguments: input }] };
    for (let repeat = 0; repeat < 2; repeat++) {
      const [redacted] = redactToolCallSecretsInMessages([message]);
      assert.equal(redacted.toolCalls[0].arguments, expected);
      assert.equal(message.toolCalls[0].arguments, input);
    }
  }
});

test('non-secret tool arguments remain byte-exact and preserve message identity', () => {
  const message = {
    role: 'assistant',
    content: 'unchanged',
    toolCalls: [{ id: 'call', name: 'read', arguments: ' { "fileName": "public.txt", "limit": 42 } ' }],
  };
  assert.equal(redactToolCallSecretsInMessages([message])[0], message);
});
