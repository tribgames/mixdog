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

test('selector normalization preserves CSS literals and escaped whitespace', () => {
  for (const selector of ['[data-key="a  b"]', '#a\\  b', '  [title=" spaced "]  ']) {
    assert.equal(normalizeBrowserTarget({ selector }).selector, selector);
  }
  assert.throws(() => normalizeBrowserTarget({ selector: ' \t\n' }), /requires role, name, and\/or selector/);
  assert.throws(() => normalizeBrowserTarget({ selector: 1 }), /must be a string/);
  assert.throws(() => normalizeBrowserTarget({ selector: 'x'.repeat(4097) }), /at most 4096/);
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

test('exact names distinguish case and match the whole normalized name', () => {
  const elements = [
    element('p1-s2-e1', 'button', 'Save'),
    element('p1-s2-e2', 'button', 'SAVE'),
    element('p1-s2-e3', 'button', 'Save as draft'),
  ];
  assert.equal(selectBrowserTarget({ name: 'Save', exact: true }, elements).ref, 'p1-s2-e1');
  assert.equal(selectBrowserTarget({ name: 'SAVE', exact: true }, elements).ref, 'p1-s2-e2');
  assert.throws(
    () => selectBrowserTarget({ name: 'Save', exact: true }, elements.slice(1)),
    /no element matched/,
  );
  assert.throws(
    () => selectBrowserTarget({ name: 'save', exact: true }, elements),
    /no element matched/,
  );
  assert.equal(
    selectBrowserTarget(normalizeBrowserTarget({ name: '  Save  as draft ', exact: true }), elements).ref,
    'p1-s2-e3',
  );
  assert.equal(selectBrowserTarget({ name: 'sAvE aS' }, elements).ref, 'p1-s2-e3');
});

test('exact names preserve ambiguity and nth only counts case-sensitive matches', () => {
  const elements = [
    element('p1-s2-e1', 'button', 'Save'),
    element('p1-s2-e2', 'button', 'SAVE'),
    element('p1-s2-e3', 'button', 'Save'),
  ];
  assert.throws(
    () => selectBrowserTarget({ name: 'Save', exact: true }, elements),
    /matched 2 elements/,
  );
  assert.equal(selectBrowserTarget({ name: 'Save', exact: true, nth: 2 }, elements).ref, 'p1-s2-e3');
});

function resolverFixture({ ax = true, elements, unfiltered = elements.length, dom, selectorNodes, describeNode }) {
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
          if (selectorNodes) return { nodeIds: selectorNodes(params.selector) };
          return { nodeIds: params.selector === 'input[name=agree]' ? [77] : [77, 78] };
        }
        if (method === 'DOM.describeNode') {
          if (describeNode) return { node: describeNode(params.nodeId) };
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

test('a delayed target is resolved from a new observation without weakening its identity', async () => {
  let captures = 0;
  const commands = [];
  const resolver = createBrowserTargetResolver({
    captureSnapshotPayload: async (_guest, command) => {
      commands.push(command);
      captures++;
      return {
        elements: captures === 1 ? [] : [element('p1-s2-e1', 'button', 'Continue')],
        unfilteredElements: captures === 1 ? 0 : 1,
      };
    },
  });
  const result = await resolver.resolveTargetRefs({}, [{ role: 'button', name: 'Continue', exact: true }]);
  assert.deepEqual(result, [{ ref: 'p1-s2-e1', description: 'button "Continue" (exact)' }]);
  assert.equal(captures, 2);
  assert.deepEqual(commands[0], commands[1], 'waiting must not loosen the supplied target');
});

test('an ambiguous target is rejected immediately instead of selecting a transient first match', async () => {
  let captures = 0;
  const resolver = createBrowserTargetResolver({
    captureSnapshotPayload: async () => {
      captures++;
      return { elements: [
        element('p1-s1-e1', 'button', 'Continue'),
        element('p1-s1-e2', 'button', 'Continue'),
      ] };
    },
  });
  await assert.rejects(resolver.resolveTargetRefs({}, [{ role: 'button', name: 'Continue' }]), /matched 2 elements/);
  assert.equal(captures, 1);
});

test('a selector target reuses the AX ref for a known node and mints one for an unknown node', async () => {
  const elements = [element('p1-s2-e1', 'button', 'Cancel'), element('p1-s2-e2', 'checkbox', 'I agree')];
  const f = resolverFixture({ elements });
  const [known] = await f.resolver.resolveTargetRefs(f.guest, [{ selector: 'input[name=agree]' }]);
  assert.equal(known.ref, 'p1-s2-e2');
  await assert.rejects(
    f.resolver.resolveTargetRefs(f.guest, [{ selector: 'div.row' }]),
    /matched 2 elements[\s\S]*\[p1-s2-t\d+\] div "consent"/,
  );
  const [minted] = await f.resolver.resolveTargetRefs(f.guest, [{ selector: 'div.row', nth: 2 }]);
  assert.equal(f.state.for(f.guest).accessibilityRefs.refs.get(minted.ref).backendNodeId, 900);
  assert.equal(f.state.for(f.guest).refSet.refs.get(minted.ref).role, 'div');
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

for (const ax of [true, false]) {
  test(`batched CSS targets keep distinct elements and reuse overlapping matches (${ax ? 'AX' : 'DOM'})`, async () => {
    const dom = new JSDOM('<input id="first" data-key="a  b"><input id="second" data-key="a b">', { runScripts: 'outside-only' });
    try {
      const nodes = [dom.window.document.querySelector('#first'), dom.window.document.querySelector('#second')];
      dom.window.__mixdogAgentSnapshot = { id: 'p1-s2', refs: new Map() };
      const f = resolverFixture({
        ax, elements: [], dom,
        selectorNodes: selector => [...dom.window.document.querySelectorAll(selector)].map(node => nodes.indexOf(node) + 101),
        describeNode: id => ({ backendNodeId: id, nodeName: 'INPUT', attributes: ['id', nodes[id - 101].id] }),
      });
      const resolved = await f.resolver.resolveTargetRefs(f.guest, [
        { selector: '[data-key="a  b"]' },
        { selector: '[data-key="a b"]' },
        { selector: '#first' },
      ]);
      assert.notEqual(resolved[0].ref, resolved[1].ref);
      assert.equal(resolved[0].ref, resolved[2].ref, 'overlapping selectors retain the same element identity');
      for (const [index, entry] of resolved.slice(0, 2).entries()) {
        if (ax) {
          assert.equal(f.state.for(f.guest).accessibilityRefs.refs.get(entry.ref).backendNodeId, index + 101);
        } else {
          assert.equal(dom.window.__mixdogAgentSnapshot.refs.get(entry.ref).element, nodes[index]);
        }
        assert.equal(f.state.for(f.guest).refSet.refs.get(entry.ref).name, nodes[index].id);
      }
      assert.equal(f.captured.length, 1, 'a batch keeps one observation');
    } finally {
      dom.window.close();
    }
  });

  test(`CSS matching refuses truncated uniqueness and still supports the limit boundary (${ax ? 'AX' : 'DOM'})`, async () => {
    const dom = new JSDOM(Array.from({ length: 51 }, (_, i) => (
      `<button id="b${i}" aria-label="${i === 0 || i === 50 ? 'Delete' : `Other ${i}`}"></button>`
    )).join(''), { runScripts: 'outside-only' });
    try {
      const nodes = [...dom.window.document.querySelectorAll('button')];
      const elements = nodes.map((node, index) => element(`p1-s2-e${index + 1}`, 'button', node.getAttribute('aria-label')));
      dom.window.__mixdogAgentSnapshot = {
        id: 'p1-s2', refs: new Map(elements.map((el, i) => [el.ref, { element: nodes[i], frames: [] }])),
      };
      const f = resolverFixture({
        ax, elements, dom,
        selectorNodes: selector => [...dom.window.document.querySelectorAll(selector)].map(node => nodes.indexOf(node) + 1),
        describeNode: id => ({ backendNodeId: id, nodeName: 'BUTTON' }),
      });
      for (const target of [
        { selector: 'button', name: 'Delete', exact: true },
        { selector: 'button', nth: 51 },
      ]) {
        await assert.rejects(f.resolver.resolveTargetRefs(f.guest, [target]),
          /matched 51 elements, exceeding the limit of 50; narrow target\.selector/);
      }
      assert.equal(f.captured.length, 2, 'overflow is final, not an actionability retry');
      assert.ok(!f.cdpCalls.includes('DOM.describeNode'), 'overflow stops before per-node work');
      assert.equal(f.state.for(f.guest).refSet.refs.size, elements.length);
      assert.equal(dom.window.__mixdogAgentSnapshot.refs.size, elements.length);
      const [atLimit] = await f.resolver.resolveTargetRefs(f.guest, [{ selector: 'button:not(#b50)', nth: 50 }]);
      assert.equal(atLimit.ref, elements[49].ref);
      const [narrowed] = await f.resolver.resolveTargetRefs(f.guest, [{ selector: '#b50', name: 'Delete', exact: true }]);
      assert.equal(narrowed.ref, elements[50].ref);
      await assert.rejects(f.resolver.resolveTargetRefs(f.guest, [{
        selector: '#b0, #b50', name: 'Delete', exact: true,
      }]), /matched 2 elements/);
    } finally {
      dom.window.close();
    }
  });
}
