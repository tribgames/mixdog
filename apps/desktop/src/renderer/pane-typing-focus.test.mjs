import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

// A pane holds its retained (inert, unpainted) conversations next to the
// shown one, and a retained one can come first in document order. Typing
// into the window must reach the shown composer, never stop at the hidden one.
test('typing into the window focuses the shown composer, not a retained one before it', async (t) => {
  const { dom, root } = installTestDom(t, {
    html: `<!doctype html><html><body>
      <main id="root"></main>
      <section data-pane-id="pane-1">
        <div class="conversation-persistent-surface" data-retained inert>
          <form class="composer"><textarea id="retained"></textarea></form>
        </div>
        <div class="conversation-persistent-surface">
          <form class="composer"><textarea id="shown"></textarea></form>
        </div>
      </section>
    </body></html>`,
    expose: ['Element', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'KeyboardEvent'],
    rootId: 'root',
  });
  const { usePaneTypingFocus } = await import('./use-composer-focus.ts');
  function Harness() {
    usePaneTypingFocus('pane-1', 'session');
    return null;
  }
  await act(async () => root.render(React.createElement(Harness)));
  const document = dom.window.document;
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  });
  assert.equal(document.activeElement?.id, 'shown');
});
