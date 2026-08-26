import assert from 'node:assert/strict';
import test from 'node:test';

import { fileLooksLikeText } from './file-content.ts';

test('file text sniffing accepts text and rejects binary or unreadable files', async () => {
  assert.equal(await fileLooksLikeText(new File(['plain text\n'], 'note.txt')), true);
  assert.equal(await fileLooksLikeText(new File([new Uint8Array([65, 0, 66])], 'binary.bin')), false);
  assert.equal(await fileLooksLikeText({ slice() { throw new Error('unreadable'); } }), false);
});
