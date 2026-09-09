import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { CapabilityIcon } from './CapabilityIcon.tsx';

function icon(name, kind = 'skill', size = 16) {
  const markup = renderToStaticMarkup(createElement(CapabilityIcon, { name, kind, size }));
  return new JSDOM(markup).window.document.querySelector('svg');
}

test('all built-in capabilities and shipped skills render self-contained scalable artwork', () => {
  const features = ['git', 'memory', 'browser', 'computer', 'office', 'localProvider', 'voice'];
  const skills = ['browser-use', 'computer-use', 'memory-management', 'local-provider',
    'history-recall', 'goal-management', 'skill-creator', 'setup', 'pdf', 'pptx', 'docx', 'xlsx', 'image', 'video'];
  for (const [kind, names] of [['builtin', features], ['skill', skills]]) {
    for (const name of names) {
      const node = icon(name, kind, 24);
      assert.equal(node.getAttribute('viewBox'), '0 0 24 24', name);
      assert.equal(node.getAttribute('width'), '24', name);
      assert.equal(node.getAttribute('height'), '24', name);
      assert.equal(node.getAttribute('aria-hidden'), 'true', name);
      assert.ok(node.querySelector('path'), name);
      assert.equal(node.querySelector('image, use, text'), null, name);
    }
  }
});

test('feature and bundled skill share artwork while document types remain visually distinct', () => {
  for (const [feature, skill] of [['memory', 'memory-management'], ['browser', 'browser-use'],
    ['computer', 'computer-use'], ['localProvider', 'local-provider']]) {
    assert.equal(icon(feature, 'builtin').outerHTML, icon(skill).outerHTML);
  }
  const docs = ['pdf', 'pptx', 'docx', 'xlsx'].map(name => icon(name));
  assert.equal(new Set(docs.map(node => node.innerHTML)).size, 4);
  assert.equal(new Set(docs.map(node => node.style.color)).size, 4);
});

test('unknown and object-property skill names safely render the generic artwork', () => {
  const fallback = icon('custom-workflow').outerHTML;
  for (const name of ['', 'constructor', '__proto__', 'toString']) {
    assert.equal(icon(name).outerHTML, fallback);
  }
});
