import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserRemoteTabs } from './remote-tabs.ts';

function fixture() {
  const pages = new Map();
  const published = [];
  const page = (title, url, loading = false) => ({
    title,
    url,
    loading,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    getTitle() {
      return this.title;
    },
    getURL() {
      return this.url;
    },
    isLoadingMainFrame() {
      return this.loading;
    },
  });
  const tabs = createBrowserRemoteTabs({
    sessionIds: () => [...pages.keys()],
    liveGuest: (id) => pages.get(id) ?? null,
    publish: async (list) => {
      published.push(list);
    },
    watchMs: 5,
  });
  return { pages, published, page, tabs };
}

test('lists only live main-workspace pages in the order first seen', () => {
  const { pages, page, tabs } = fixture();
  pages.set('main-browser-b', page('B', 'https://b.test/'));
  pages.set('conversation-1', page('Agent', 'https://agent.test/'));
  assert.deepEqual(
    tabs.list().map((tab) => tab.id),
    ['main-browser-b']
  );
  pages.set('main-browser-a', page('A', 'https://a.test/', true));
  pages.get('main-browser-b').destroyed = true;
  assert.deepEqual(tabs.list(), [{ id: 'main-browser-a', title: 'A', url: 'https://a.test/', loading: true }]);
  pages.get('main-browser-b').destroyed = false;
  assert.deepEqual(
    tabs.list().map((tab) => tab.id),
    ['main-browser-a', 'main-browser-b']
  );
});

test('a watch publishes changed lists only, and stops when unwatched', async () => {
  const { pages, published, page, tabs } = fixture();
  pages.set('main-browser-a', page('A', 'https://a.test/'));
  assert.equal(tabs.watch(true).length, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(published.length, 0, 'an unchanged list is not pushed');

  pages.get('main-browser-a').title = 'A2';
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(published.length, 1);
  assert.equal(published[0][0].title, 'A2');

  pages.delete('main-browser-a');
  tabs.changed();
  assert.deepEqual(published.at(-1), []);

  tabs.watch(false);
  const count = published.length;
  pages.set('main-browser-c', page('C', 'https://c.test/'));
  tabs.changed();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(published.length, count);
  tabs.dispose();
});
