import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = (name) => readFileSync(new URL(`./desktop/${name}`, import.meta.url), 'utf8');

test('phone drawer rail scrolls instead of clipping and keeps every item whole', () => {
  const source = css('07-mobile-chrome.css');
  const rail = source.match(
    /html\[data-mixdog-mobile-tabs\] \.sidebar-drawer-frame > \.activity-rail \{\s*overflow-x: hidden;\s*overflow-y: auto;/
  );
  assert.ok(rail, 'phone rail must scroll vertically');
  assert.match(
    source,
    /\.sidebar-drawer-frame > \.activity-rail > \* \{\s*flex-shrink: 0;/,
    'rail items must not shrink into each other'
  );
});

test('remote browser toolbar gives the address field the phone width', () => {
  const source = css('32-browser-pane.css');
  assert.match(source, /\.browser-remote-pane \.browser-pane-address-form \{\s*min-width: 120px;/);
});
