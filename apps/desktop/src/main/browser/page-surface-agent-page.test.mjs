import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserPageSurface } from './page-surface.ts';
import { BrowserSessionRegistry } from './session-registry.ts';

test('the display frame carries the agent page while it exists and drops it with the page', async () => {
  const sessions = new BrowserSessionRegistry();
  const makeGuest = (id) => ({
    id,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    getURL: () => 'https://a',
    getTitle: () => 'A',
    isLoadingMainFrame: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  });
  const blank = makeGuest(1);
  const popup = makeGuest(2);
  sessions.registerVisibleGuest(blank);
  sessions.bindVisibleGuest('owner', 1, true);
  sessions.setBackgroundPage('owner', 'popup-1', {
    guest: popup,
    kind: 'popup',
    lastUsedAt: 0,
    window: { isDestroyed: () => false },
  });
  const record = { documentGeneration: 1 };
  const surface = createBrowserPageSurface({
    ensureGuest: async () => blank,
    agentPage: (sessionId) => sessions.agentPage(sessionId),
    state: { pageId: (page) => `p${page.id}`, for: () => record },
    cdp: {
      waitForIdle: async () => {},
      guestDebugger: async () => ({
        sendCommand: async () => ({ cssVisualViewport: { scale: 1 } }),
      }),
      bounded: async (work) => work,
    },
    viewport: () => ({ width: 800, height: 600, zoom: 1, pixels: { width: 800, height: 600 } }),
    capture: async () => ({ data: 'pixels', width: 800, height: 600, mimeType: 'image/jpeg', fullPage: false }),
  });

  assert.equal('agentPage' in (await surface.frame('owner')), false);
  sessions.setAgentPage('owner', popup, 7);
  assert.deepEqual((await surface.frame('owner')).agentPage, { tabId: 'p2', turn: 7, paused: false });
  sessions.pauseAgentFollow('owner');
  assert.equal((await surface.frame('owner')).agentPage.paused, true);
  sessions.deleteBackgroundPage('owner', 'popup-1');
  assert.equal('agentPage' in (await surface.frame('owner')), false);
});
