import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserPageClient } from './browser-page-client.ts';

test('unchanged display samples do not republish pixels, but metadata changes remain visible', async () => {
  let next = {
    documentId: 'p1:1', frameId: 'paint1', webContentsId: 1, url: 'https://example.test',
    title: 'Page', loading: false, canGoBack: false, canGoForward: false,
    width: 800, height: 600, viewportWidth: 800, viewportHeight: 600,
  };
  const updates = [];
  const client = createBrowserPageClient({
    sessionId: 's', update: frame => updates.push(frame), failure: error => assert.fail(error),
    api: { browserPageFrame: async () => ({ ...next }) },
  });
  await client.poll();
  await client.poll();
  assert.equal(updates.length, 1);
  next = { ...next, title: 'New title', loading: true };
  await client.poll();
  assert.equal(updates.length, 2);
  assert.equal(updates[1].title, 'New title');
  next = { ...next, frameId: 'paint2' };
  await client.poll();
  assert.equal(updates.length, 3);
});
