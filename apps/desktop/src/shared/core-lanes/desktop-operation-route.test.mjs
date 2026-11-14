import assert from 'node:assert/strict';
import test from 'node:test';

import { base64ByteLength } from './desktop-operation-route.ts';

test('base64ByteLength matches the length Buffer decodes to', () => {
  for (const text of ['', 'QQ==', 'QUI=', 'QUJD', 'QUJDRA==', 'a-_b', 'QU JD\nRA==', 'QUJD=junk', 'Q']) {
    assert.equal(base64ByteLength(text), Buffer.from(text, 'base64').length, JSON.stringify(text));
  }
});
