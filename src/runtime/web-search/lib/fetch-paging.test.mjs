import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { handleToolCall } from '../index.mjs';
import { applyFetchPagination } from './formatter.mjs';

test('fetch pages never split a surrogate pair, so pages rebuild the source exactly', () => {
  const source = 'a😀b😀😀c😀';
  for (const maxLength of [1, 2, 3, 4]) {
    let startIndex = 0;
    let rebuilt = '';
    do {
      const page = applyFetchPagination({ content: source }, { startIndex, maxLength });
      assert.ok(page.content.length > 0);
      assert.doesNotMatch(page.content, /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/, `maxLength=${maxLength}`);
      rebuilt += page.content;
      startIndex = page.nextStartIndex;
    } while (startIndex != null);
    assert.equal(rebuilt, source, `maxLength=${maxLength}`);
  }
});

test('local_fetch names the startIndex that continues a cut page', async (t) => {
  const body = 'abcdefghijklmnopqrstuvwxyz';
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const text = (result) => result.content.map((part) => part.text).join('\n');

  let startIndex = 0;
  let rebuilt = '';
  let pages = 0;
  while (startIndex != null && pages < 10) {
    const out = text(await handleToolCall('local_fetch', { url, startIndex, maxLength: 10 }));
    const marker = /\[chars (\d+)-(\d+) of 26; startIndex:(\d+) for more\]$/.exec(out);
    rebuilt += out.slice(out.indexOf('\n\n') + 2).replace(/\n\n\[chars [^\]]*\]$/, '');
    startIndex = marker ? Number(marker[3]) : null;
    pages++;
  }
  assert.equal(rebuilt, body);
  assert.equal(pages, 3);
});
