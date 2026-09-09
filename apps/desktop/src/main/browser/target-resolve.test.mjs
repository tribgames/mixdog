import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { BrowserGuestStateStore } from './guest-state.ts';
import { createBrowserRefSet } from './ref-recovery.ts';
import {
  createBrowserTargetResolver,
  normalizeBrowserTarget,
  selectBrowserTarget,
} from './target-resolve.ts';

const element = (ref, role, name, extra = {}) => ({ ref, role, name, tag: 'ax', ...extra });

test('target normalisation rejects empty, unknown, and ill-typed specs', () => {
  assert.throws(() => normalizeBrowserTarget({}), /requires role, name, and\/or selector/);
  assert.throws(() => normalizeBrowserTarget({ text: 'x' }), /does not accept field\(s\): text/);
  assert.throws(() => normalizeBrowserTarget({ name: 'x', nth: 0 }), /nth must be an integer/);
  assert.throws(() => normalizeBrowserTarget({ role: 'button', exact: true }), /exact applies to target.name/);
  assert.deepEqual(normalizeBrowserTarget({ role: ' Button ', name: '  Save  changes ' }), {
    role: 'button', name: 'Save changes',
  });
});

test('selection insists on one match, prefers the verbatim name, and lists candidates with refs', () => {
  const elements = [
    element('p1-s2-e1', 'button', 'Save as draft'),
    element('p1-s2-e2', 'button', 'Save'),
    element('p1-s2-e3', 'link', 'Save', { href: 'https://example.test/save' }),
    element('p1-s2-e4', 'textbox', 'Email'),
  ];
  assert.equal(selectBrowserTarget({ role: 'button', name: 'save' }, elements).ref, 'p1-s2-e2');
  assert.equal(selectBrowserTarget({ name: 'email' }, elements).ref, 'p1-s2-e4');
  assert.equal(selectBrowserTarget({ role: 'button', name: 'save', nth: 1 }, elements).ref, 'p1-s2-e1');
  assert.equal(selectBrowserTarget({ name: 'save as', exact: false }, elements).ref, 'p1-s2-e1');
  assert.throws(
    () => selectBrowserTarget({ name: 'save' }, elements),
    (error) => /matched 3 elements/.test(error.message)
      && /\[p1-s2-e1\] button "Save as draft"/.test(error.message)
      && /\[p1-s2-e2\] button "Save"/.test(error.message)
      && /\[p1-s2-e3\] link "Save" href=https:\/\/example.test\/save/.test(error.message),
  );
  assert.throws(
    () => selectBrowserTarget({ role: 'button', name: 'publish' }, elements, { unfiltered: 12 }),
    /no element matched target button "publish" among 12 candidate element\(s\). Elements with role button: "Save as draft", "Save"/,
  );
  assert.throws(
    () => selectBrowserTarget({ role: 'button', name: 'save', nth: 5 }, elements),
    /only 2 matched/,
  );
  assert.throws(
    () => selectBrowserTarget({ role: 'button', name: 'save', exact: true }, elements.filter((e) => e.ref !== 'p1-s2-e2')),
    /no element matched/,
  );
});

function resolverFixture({ ax = true, elements, unfiltered = elements.length, dom }) {
  const guest = {};
  const state = new BrowserGuestStateStore();
  const captured = [];
  const payload = {
    snapshotId: 'p1-s2', url: 'https://example.test/', viewportWidth: 800, viewportHeight: 600,
    elements, unfilteredElements: unfiltered,
  };
  const cdpCalls = [];
  const resolver = createBrowserTargetResolver({
    state,
    async captureSnapshotPayload(_guest, command) {
      captured.push(command);
      state.for(guest).refSet = createBrowserRefSet(payload);
      state.for(guest).accessibilityRefs = ax
        ? { snapshotId: 'p1-s2', refs: new Map(elements.map((el, index) => [el.ref, { backendNodeId: index + 1 }])) }
        : undefined;
      return payload;
    },
    cdp: {
      async call(_guest, method, params) {
        cdpCalls.push(method);
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelectorAll') {
          if (params.selector === 'bad(') throw new Error("'bad(' is not a valid selector");
          return { nodeIds: params.selector === 'input[name=agree]' ? [77] : [77, 78] };
        }
        if (method === 'DOM.describeNode') {
          return params.nodeId === 77
            ? { node: { backendNodeId: 2, nodeName: 'INPUT' } }
            : { node: { backendNodeId: 900, nodeName: 'DIV', attributes: ['id', 'consent', 'class', 'row'] } };
        }
        throw new Error(`unexpected ${method}`);
      },
    },
    async evaluate(_guest, expression) {
      return dom.window.eval(expression);
    },
  });
  return { guest, state, resolver, captured, cdpCalls };
}

test('a lone named target narrows the observation with its name and resolves through the AX refs', async () => {
  const elements = [element('p1-s2-e1', 'button', 'Cancel'), element('p1-s2-e2', 'checkbox', 'I agree')];
  const f = resolverFixture({ elements });
  const [resolved] = await f.resolver.resolveTargetRefs(f.guest, [{ role: 'checkbox', name: 'agree' }]);
  assert.equal(resolved.ref, 'p1-s2-e2');
  assert.equal(resolved.description, 'checkbox "agree"');
  assert.equal(f.captured[0].query, 'agree');
  const many = await f.resolver.resolveTargetRefs(f.guest, [{ name: 'cancel' }, { name: 'agree' }]);
  assert.deepEqual(many.map((entry) => entry.ref), ['p1-s2-e1', 'p1-s2-e2']);
  assert.equal(f.captured[1].query, undefined, 'a batch resolves against one unfiltered observation');
});

test('a selector target reuses the AX ref for a known node and mints one for an unknown node', async () => {
  const elements = [element('p1-s2-e1', 'button', 'Cancel'), element('p1-s2-e2', 'checkbox', 'I agree')];
  const f = resolverFixture({ elements });
  const [known] = await f.resolver.resolveTargetRefs(f.guest, [{ selector: 'input[name=agree]' }]);
  assert.equal(known.ref, 'p1-s2-e2');
  await assert.rejects(
    f.resolver.resolveTargetRefs(f.guest, [{ selector: 'div.row' }]),
    /matched 2 elements[\s\S]*\[p1-s2-t1\] div "consent"/,
  );
  const [minted] = await f.resolver.resolveTargetRefs(f.guest, [{ selector: 'div.row', nth: 2 }]);
  assert.equal(minted.ref, 'p1-s2-t1');
  assert.equal(f.state.for(f.guest).accessibilityRefs.refs.get('p1-s2-t1').backendNodeId, 900);
  assert.equal(f.state.for(f.guest).refSet.refs.get('p1-s2-t1').role, 'div');
  await assert.rejects(f.resolver.resolveTargetRefs(f.guest, [{ selector: 'bad(' }]), /not a valid CSS selector/);
});

test('without an AX tree a selector resolves through the page-side ref table', async () => {
  const dom = new JSDOM('<button id="one">Cancel</button><div id="two" title="Consent row"></div>', { runScripts: 'outside-only' });
  try {
    const elements = [element('p1-s2-e1', 'button', 'Cancel')];
    const f = resolverFixture({ ax: false, elements, dom });
    dom.window.__mixdogAgentSnapshot = {
      id: 'p1-s2', refs: new Map([['p1-s2-e1', { element: dom.window.document.querySelector('#one'), frames: [] }]]),
    };
    const [known] = await f.resolver.resolveTargetRefs(f.guest, [{ selector: '#one' }]);
    assert.equal(known.ref, 'p1-s2-e1');
    const [minted] = await f.resolver.resolveTargetRefs(f.guest, [{ selector: '#two' }]);
    assert.equal(minted.ref, 'p1-s2-t1');
    assert.equal(dom.window.__mixdogAgentSnapshot.refs.get('p1-s2-t1').element.id, 'two');
    assert.equal(f.state.for(f.guest).refSet.refs.get('p1-s2-t1').name, 'Consent row');
    await assert.rejects(f.resolver.resolveTargetRefs(f.guest, [{ selector: '#nope' }]), /no element matched/);
    assert.deepEqual(f.cdpCalls, [], 'the DOM fallback never touches CDP');
  } finally {
    dom.window.close();
  }
});