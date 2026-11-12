// The message a person sees for a refused argument names the field the core refused (its `expected` sentence), so the person knows
// which text to fix; other failures keep their message.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClientFailure } from '../src/client.ts';

test('a refused argument names its field in the message', () => {
  const expected = 'text without unpaired surrogates (a lone \\ud800-\\udfff escape) in thread/name/set.params/threadId';
  const failure = new ClientFailure({
    kind: 'rpc',
    code: -32602,
    reason: 'invalidParams',
    message: 'invalidParams',
    data: { reason: 'invalidParams', path: 'thread/name/set.params/threadId', expected },
  } as never);
  assert.equal(failure.message, `-32602 invalidParams invalidParams: ${expected}`);
});

test('any other failure keeps its message', () => {
  const failure = new ClientFailure({ kind: 'rpc', code: -32601, reason: 'methodNotFound', message: 'nope', data: { reason: 'methodNotFound' } } as never);
  assert.equal(failure.message, '-32601 methodNotFound nope');
});
