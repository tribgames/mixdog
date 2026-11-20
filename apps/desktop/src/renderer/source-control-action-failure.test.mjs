import assert from 'node:assert/strict';
import test from 'node:test';

import { isOutcomeUnknown } from '../shared/outcome-unknown.ts';
import { gitActionFailureText } from './source-control-action-failure.ts';

// The client library's failure for an op whose outcome it could not learn (packages/protocol-client ClientFailure).
const unknown = () =>
  Object.assign(new Error('opOutcomeUnknown'), {
    name: 'ClientError',
    detail: { kind: 'opOutcomeUnknown', opId: 'op-1', state: 'statusFailed' },
  });

test('an unknown outcome tells the person the Git action may have run', () => {
  const text = gitActionFailureText(unknown());
  assert.match(text, /may have run/);
  assert.match(text, /Check the repository status before trying it again/);
  assert.doesNotMatch(text, /opOutcomeUnknown/);
});

test('the bare protocol message of an unknown outcome, once the detail is gone, is worded the same', () => {
  assert.equal(gitActionFailureText(new Error('opOutcomeUnknown')), gitActionFailureText(unknown()));
  assert.equal(isOutcomeUnknown(new Error('opOutcomeUnknown')), true);
});

test('any other failure keeps its own message', () => {
  assert.equal(gitActionFailureText(new Error('fatal: not a git repository')), 'fatal: not a git repository');
  assert.equal(gitActionFailureText('plain'), 'plain');
  assert.equal(isOutcomeUnknown(Object.assign(new Error('x'), { detail: { kind: 'connectionLost' } })), false);
});
