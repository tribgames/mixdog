import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserPageSurface } from './page-surface.ts';

test('an initial blocking dialog is displayed without waiting for any renderer operation or pixels', async () => {
  const guest = {
    id: 1, getURL: () => 'https://example.test', getTitle: () => 'Dialog', isLoadingMainFrame: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
  const surface = createBrowserPageSurface({
    ensureGuest: async () => guest,
    state: { pageId: () => 'p1', for: () => ({ documentGeneration: 1, pendingDialog: {} }) },
    viewport: () => ({ width: 800, height: 600, zoom: 1 }),
    cdp: { guestDebugger: async () => { throw new Error('renderer is blocked'); } },
    capture: async () => { throw new Error('renderer is blocked'); },
    prompts: { describe: () => ({ dialog: { id: 'd1', type: 'alert', message: 'Hello' } }) },
  });
  const frame = await surface.frame('owner');
  assert.equal(frame.dialog.message, 'Hello');
  assert.equal(frame.documentId, 'p1:1');
  assert.equal(frame.image, undefined);
});
