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

test('page events publish changed lists only, with no polling, and stop when unwatched', async () => {
  const pass = () => new Promise((resolve) => setImmediate(resolve));
  const { pages, published, page, tabs } = fixture();
  const listeners = new Map();
  const events = {
    on: (event, fn) => listeners.set(event, fn),
    once: (event, fn) => listeners.set(event, fn),
  };
  pages.set('main-browser-a', page('A', 'https://a.test/'));
  tabs.observe(events);
  assert.deepEqual(
    [...listeners.keys()].sort(),
    ['destroyed', 'did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated']
  );
  assert.equal(published.length, 0, 'nothing is pushed before a client watches');
  assert.equal(tabs.watch(true).length, 1);
  listeners.get('did-stop-loading')();
  await pass();
  assert.equal(published.length, 0, 'an event with no change is not pushed');

  pages.get('main-browser-a').title = 'A2';
  listeners.get('page-title-updated')();
  listeners.get('did-navigate')();
  await pass();
  assert.equal(published.length, 1, 'repeated events for one change publish once');
  assert.equal(published[0][0].title, 'A2');

  pages.delete('main-browser-a');
  tabs.changed();
  assert.deepEqual(published.at(-1), []);

  tabs.watch(false);
  const count = published.length;
  pages.set('main-browser-c', page('C', 'https://c.test/'));
  listeners.get('did-start-loading')();
  await pass();
  assert.equal(published.length, count);
  tabs.dispose();
});
