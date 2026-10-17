import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, { html: '<!doctype html><html><body></body></html>' });
after(restore);
const { breadcrumbPickerAnchor } = await import('./editor-breadcrumb-anchor.ts');

const crumb = (top) => {
  const node = document.createElement('button');
  document.body.append(node);
  node.getBoundingClientRect = () => ({ left: 100, right: 180, top, bottom: top + 20, width: 80, height: 20 });
  return node;
};
const layoutHeight = () => document.documentElement.clientHeight || window.innerHeight;

test('a breadcrumb picker opens below its crumb, top-pinned', () => {
  const anchor = breadcrumbPickerAnchor(crumb(40), 0);
  assert.equal(anchor.top, 40 + 20 + 6);
  assert.equal(anchor.bottom, undefined);
  assert.equal(anchor.x, 100);
});

test('an above-opened breadcrumb picker is bottom-pinned so short content hugs the crumb', () => {
  const top = layoutHeight() - 40;
  const anchor = breadcrumbPickerAnchor(crumb(top), 0);
  assert.equal(anchor.top, undefined);
  assert.equal(anchor.bottom, layoutHeight() - top + 6);
  assert.ok(anchor.maxHeight <= 300);
});
