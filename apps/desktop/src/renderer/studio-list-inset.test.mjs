import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// Cascade order as shipped: rail pages, then the dialogs sheet that sets row padding.
const css = ['./desktop/10-rail-pages.css', './desktop/30-dialogs.css']
  .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
  .join('\n');

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

// The panels scroller gives other panels' rows a 12px card gutter; Studio rows
// must keep the Sessions 8px inner inset so the thumbnail sits on the heading line.
test('Studio rows keep the Sessions inner inset', () => {
  const row = '<div class="session-row"></div>';
  const dom = new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body>
    <div class="session-sidebar"><div class="session-sidebar-sessions">${row}</div>
    <div class="session-sidebar-panels"><div class="studio-panel">${row}</div></div></div>
    </body></html>`);
  try {
    const { document, getComputedStyle } = dom.window;
    // jsdom keeps the logical shorthand unexpanded; its leading value is the start inset.
    const pad = (selector) => getComputedStyle(document.querySelector(`${selector} .session-row`)).paddingInline;
    assert.match(pad('.session-sidebar-sessions'), /^8px /);
    assert.equal(pad('.studio-panel'), pad('.session-sidebar-sessions'));
  } finally {
    dom.window.close();
  }
});

// Studio's sections are children of .studio-panel, not of the scroller, so the
// scroller-child spacing rules must name it too or its categories touch.
test('Studio categories are spaced like the Sessions categories', () => {
  const section = '<section class="sidebar-recent"><nav class="session-list"></nav></section>';
  const dom = new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body>
    <div class="session-sidebar-sessions"><div class="session-sidebar-scroll">${section}${section}</div></div>
    <div class="session-sidebar-scroll session-sidebar-panels"><div class="studio-panel">${section}${section}</div></div>
    </body></html>`);
  try {
    const { document, getComputedStyle } = dom.window;
    const gap = (selector) => getComputedStyle(document.querySelectorAll(`${selector} .sidebar-recent`)[1]).marginTop;
    assert.equal(gap('.session-sidebar-sessions'), '20px');
    assert.equal(gap('.studio-panel'), gap('.session-sidebar-sessions'));
  } finally {
    dom.window.close();
  }
});
