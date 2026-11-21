import assert from 'node:assert/strict';
import test from 'node:test';

import { errorDiagnosticFields } from './diagnostic-error.ts';

test('an Error reports its name and message', () => {
  assert.deepEqual(errorDiagnosticFields(new TypeError('bad')), { errorName: 'TypeError', message: 'bad' });
});

test('a thrown non-Error reports the name Error and its text', () => {
  assert.deepEqual(errorDiagnosticFields('boom'), { errorName: 'Error', message: 'boom' });
  assert.deepEqual(errorDiagnosticFields({ message: 'from object' }), { errorName: 'Error', message: 'from object' });
});

test('the message is cut to 300 characters', () => {
  assert.equal(errorDiagnosticFields(new Error('x'.repeat(500))).message.length, 300);
});
