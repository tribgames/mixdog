import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BROWSER_PAGE_ZOOM_CHANNEL,
  browserPageZoomAtDocumentStart,
  installBrowserPageZoom,
  setBrowserPageZoom,
} from './page-zoom.ts';

const partition = { name: 'persist:mixdog-browser' };

/** A page of `session` that records every zoom set on it. */
function page(session = partition, zoom = 1) {
  const set = [];
  return {
    session,
    set,
    getZoomFactor: () => zoom,
    setZoomFactor(factor) {
      set.push(factor);
      zoom = factor;
    },
  };
}

test('a page the pane never zoomed starts every document at 100%, and the site level goes back to 100% first', () => {
  const agent = page(partition, 0.3944); // a document committed at the level the pane left on the site
  assert.equal(browserPageZoomAtDocumentStart(agent, partition), 1);
  assert.deepEqual(agent.set, [1], "the site's shared level is set back before the page takes its own");
});

test("the pane's zoom stays with its page, across its documents, and never reaches another page of the site", () => {
  const pane = page();
  const agent = page();
  setBrowserPageZoom(pane, 0.3944);
  assert.deepEqual(pane.set, [0.3944]);
  assert.equal(
    browserPageZoomAtDocumentStart(pane, partition),
    0.3944,
    "the pane's page keeps its zoom on its next document"
  );
  assert.equal(browserPageZoomAtDocumentStart(agent, partition), 1, 'a hidden page of the same site stays at 100%');
});

test('an asker outside the partition changes nothing and keeps its own zoom', () => {
  const shell = page({ name: 'app' }, 1.25);
  assert.equal(browserPageZoomAtDocumentStart(shell, partition), 1.25);
  assert.deepEqual(shell.set, []);
});

test("the preload's question is answered on its channel until the partition goes", () => {
  const listeners = new Map();
  const ipc = {
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel, listener) => listeners.get(channel) === listener && listeners.delete(channel),
  };
  const uninstall = installBrowserPageZoom(ipc, partition);
  const event = { sender: page() };
  listeners.get(BROWSER_PAGE_ZOOM_CHANNEL)(event);
  assert.equal(event.returnValue, 1, 'a synchronous answer, so the page never waits forever');
  uninstall();
  assert.equal(listeners.size, 0);
});
