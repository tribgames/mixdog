import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const css = readFileSync(new URL('./desktop/10-rail-pages.css', import.meta.url), 'utf8');

// Studio reuses the Sessions list markup inside the sidebar's panels scroller,
// so its rows must take the same row-pill inset or they sit 8px right of them.
test('the Studio list lines up with the Sessions list', () => {
  const list = '<section class="sidebar-recent"><nav class="session-list recent-session-list"></nav></section>';
  const dom = new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body>
    <div class="session-sidebar-sessions">${list}</div>
    <div class="session-sidebar-panels"><div class="studio-panel">${list}</div></div>
    </body></html>`);
  try {
    const { document, getComputedStyle } = dom.window;
    const inset = (selector) => getComputedStyle(document.querySelector(`${selector} .session-list`)).marginLeft;
    assert.equal(inset('.studio-panel'), inset('.session-sidebar-sessions'));
  } finally {
    dom.window.close();
  }
});
