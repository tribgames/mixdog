import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

test('a pane is downloaded with preload links and never imported', async () => {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><html><head></head><body></body></html>',
    actEnvironment: false,
  });
  try {
    const { fetchChunkGraph } = await import(`./chunk-prefetch.ts?links=${Date.now()}`);
    const files = { editor: ['assets/EditorPane.js', 'assets/monaco.js', 'assets/monaco.css'] };
    const done = fetchChunkGraph('editor', files);
    const links = [...document.head.querySelectorAll('link')];
    assert.deepEqual(
      links.map((link) => [link.rel, link.getAttribute('as'), link.getAttribute('href'), link.crossOrigin]),
      [
        ['modulepreload', null, './assets/EditorPane.js', ''],
        ['modulepreload', null, './assets/monaco.js', ''],
        ['prefetch', 'style', './assets/monaco.css', ''],
      ]
    );
    // No script element and no stylesheet: nothing evaluates or applies.
    assert.equal(document.querySelectorAll('script, link[rel="stylesheet"]').length, 0);
    for (const link of links) link.dispatchEvent(new window.Event(link === links[1] ? 'error' : 'load'));
    await done;
    // A second warm-up of an overlapping graph requests nothing twice.
    await fetchChunkGraph('editor', files);
    assert.equal(document.head.querySelectorAll('link').length, 3);
    // The dev server and tests have no lists: nothing is fetched.
    await fetchChunkGraph('terminal');
    assert.equal(document.head.querySelectorAll('link').length, 3);
  } finally {
    restore();
  }
});
