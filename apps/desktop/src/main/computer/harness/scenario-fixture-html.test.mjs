import assert from 'node:assert/strict';
import test from 'node:test';

const fixtures = await import('./scenario-fixture-html.ts');

test('every fixture page script parses as a classic page script', () => {
  const pages = Object.entries(fixtures).filter(([, value]) => typeof value === 'string' && value.includes('<script'));
  assert.ok(pages.length >= 3, 'the renderer, Korean and clutter pages carry scripts');
  for (const [name, html] of pages) {
    for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
      // A page script that does not parse never draws its surface or defines its probes.
      assert.doesNotThrow(() => new Function(script), `${name} page script must parse`);
    }
  }
});
