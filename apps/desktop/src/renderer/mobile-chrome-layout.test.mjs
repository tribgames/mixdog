import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const css = (name) => readFileSync(new URL(`./desktop/${name}`, import.meta.url), 'utf8');

test('phone drawer rail scrolls instead of clipping and keeps every item whole', (t) => {
  // Rendered: the real stylesheet is injected and jsdom's cascade decides what the rail and its items get.
  const dom = new JSDOM(
    '<!doctype html><html data-mixdog-mobile-tabs><body><div class="sidebar-drawer-frame"><nav class="activity-rail"><button id="item">x</button></nav></div></body></html>'
  );
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const style = document.createElement('style');
  t.after(() => style.remove());
  style.textContent = css('07-mobile-chrome.css');
  document.head.append(style);
  const rail = dom.window.getComputedStyle(document.querySelector('.activity-rail'));
  assert.equal(rail.overflowY, 'auto', 'phone rail must scroll vertically');
  assert.equal(rail.overflowX, 'hidden');
  assert.equal(dom.window.getComputedStyle(document.getElementById('item')).flexShrink, '0', 'rail items must not shrink into each other');
});

// Source-text on purpose: the rule sits inside `@media (max-width: 640px)`, which jsdom's getComputedStyle does not
// evaluate, so the stylesheet text is the only surface that holds it.
test('remote browser toolbar gives the address field the phone width', () => {
  const source = css('32-browser-pane.css');
  assert.match(source, /\.browser-remote-pane \.browser-pane-address-form \{\s*min-width: 120px;/);
});