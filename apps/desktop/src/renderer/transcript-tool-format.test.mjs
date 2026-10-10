import assert from 'node:assert/strict';
import test from 'node:test';
import { toolActivitySubject } from './transcript-tool-format';

test('a browser row drops the scheme and www from its subject', () => {
  assert.equal(toolActivitySubject('browser', {}, 'open · https://www.example.com/path'), 'open · example.com/path');
  assert.equal(toolActivitySubject('browser_devtools', {}, 'http://example.com'), 'example.com');
  assert.equal(toolActivitySubject('browser', {}, 'open · example.com'), 'open · example.com');
});
