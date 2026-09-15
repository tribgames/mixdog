import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  browserRefElementSource,
  checkedBrowserRefResult,
  createBrowserRefAccess,
} from './ref-access.ts';
import { isBrowserStaleRefError } from './ref-recovery.ts';

function fixture(t, ax) {
  const dom = new JSDOM('<input id="field" value="old">', {
    runScripts: 'outside-only', url: 'https://fixture.example/',
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const field = window.document.querySelector('#field');
  window.__mixdogAgentSnapshot = { refs: new Map([['ref', field]]) };
  const realms = [];
  // CDP returns JSON-serialized values, never live page objects. The fixture
  // crosses the same boundary so no page realm's prototype reaches the caller.
  const serialized = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const access = createBrowserRefAccess({
    callAccessibilityRef: async (_guest, _ref, source, args) => {
      realms.push('accessibility');
      if (!ax) return { handled: false };
      return { handled: true, value: serialized(window.eval(`(${source})`).apply(field, args)) };
    },
    evaluate: async (_guest, expression) => {
      realms.push('page');
      return serialized(window.eval(expression));
    },
  });
  return { window, field, access, realms };
}

const APPEND = 'function(suffix) { this.value = this.value + suffix; return { value: this.value }; }';

test('one declaration reaches the ref through either realm with the same effect', async (t) => {
  for (const ax of [true, false]) {
    const f = fixture(t, ax);
    assert.deepEqual(await f.access.callRef({}, 'ref', APPEND, ['-typed']), { value: 'old-typed' });
    assert.equal(f.field.value, 'old-typed');
    assert.deepEqual(f.realms, ax ? ['accessibility'] : ['accessibility', 'page']);
  }
});

test('the page realm binds the element behind either ref table shape', (t) => {
  const f = fixture(t, false);
  const read = `(() => { ${browserRefElementSource('ref')} return element.id; })()`;
  assert.equal(f.window.eval(read), 'field');
  f.window.__mixdogAgentSnapshot = { refs: new Map([['ref', { element: f.field, frames: [] }]]) };
  assert.equal(f.window.eval(read), 'field');
});

test('a detached or unknown ref is refused as stale before any declaration runs', async (t) => {
  const f = fixture(t, false);
  f.field.remove();
  for (const ref of ['ref', 'never-observed']) {
    await assert.rejects(
      f.access.callRef({}, ref, 'function() { this.value = "written"; return true; }'),
      (error) => isBrowserStaleRefError(error),
    );
  }
  assert.equal(f.field.value, 'old', 'a stale ref never receives the declaration');
  await assert.rejects(f.access.prepareRef({}, 'ref'), (error) => isBrowserStaleRefError(error));
});

test('a page-side refusal names the ref only when a fresh snapshot answers it', () => {
  assert.deepEqual(checkedBrowserRefResult({ value: 'kept' }, 'p1-s1-e1'), { value: 'kept' });
  assert.throws(
    () => checkedBrowserRefResult({ error: 'stale' }, 'p1-s1-e1'),
    /^Error: ref p1-s1-e1 is stale or unknown; take a fresh snapshot first$/,
  );
  assert.throws(
    () => checkedBrowserRefResult({ error: 'element is not editable' }, 'p1-s1-e1'),
    /^Error: element is not editable$/,
  );
  assert.ok(isBrowserStaleRefError(new Error('ref p1-s1-e1 is stale or unknown; take a fresh snapshot first')));
});
