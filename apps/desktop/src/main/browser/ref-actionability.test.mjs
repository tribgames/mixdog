import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createBrowserRefPoints } from './ref-points.ts';
import { createBrowserRefActions } from './ref-actions.ts';
import { createBrowserReply } from './reply.ts';
import { BrowserGuestStateStore } from './guest-state.ts';
import { createBrowserRefSet } from './ref-recovery.ts';
import { formActions } from './actions/forms.ts';

test('a framed element rect adds the frame offset without the hit test that guards input', async () => {
  const dom = new JSDOM('<button>Framed</button>', { runScripts: 'outside-only', pretendToBeVisual: true });
  try {
    const button = dom.window.document.querySelector('button');
    button.scrollIntoView = () => {};
    button.getBoundingClientRect = () => ({ left: 10, top: 20, width: 80, height: 24, right: 90, bottom: 44 });
    const guest = {};
    const offsetCalls = [];
    const points = createBrowserRefPoints({
      accessibilityRefs: new Map([[guest, { refs: new Map([['ref', { backendNodeId: 1, sessionId: 'frame-1' }]]) }]]),
      visualGrounding: new Map(),
      diagnostics: () => ({ pendingDialog: null }),
      callAccessibilityRef: async (_guest, _ref, source, args) => ({
        handled: true,
        value: await dom.window.eval(`(${source})`).apply(button, args),
      }),
      cdp: { call: async () => ({}) },
      frameOffsetForSession: async (_guest, sessionId, _signal, localPoint) => {
        offsetCalls.push({ sessionId, localPoint });
        return { x: 200, y: 100 };
      },
      captureSnapshotPayload: async () => assert.fail('measuring a box must not retire the ref'),
    });
    assert.deepEqual(await points.resolveRefRect(guest, 'ref'), { x: 210, y: 120, width: 80, height: 24 });
    assert.deepEqual(offsetCalls, [{ sessionId: 'frame-1', localPoint: undefined }]);
  } finally {
    dom.window.close();
  }
});

for (const blocker of ['disabled', 'covered', 'moving', 'not-visible', 'not-actionable']) {
  test(`ref click preflight waits through a temporary ${blocker} state without input or ref invalidation`, async () => {
    const dom = new JSDOM('<button>Continue</button><div>Loading</div>', {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    try {
      const button = dom.window.document.querySelector('button');
      const overlay = dom.window.document.querySelector('div');
      const guest = {};
      let ready = false;
      let rectReads = 0;
      let probes = 0;
      let captures = 0;
      let clicks = 0;
      button.addEventListener('click', () => {
        clicks++;
      });
      button.scrollIntoView = () => {};
      button.disabled = blocker === 'disabled';
      if (blocker === 'not-actionable') button.style.display = 'none';
      button.getBoundingClientRect = () => ({
        left: blocker === 'moving' && ++rectReads > 1 ? 30 : 10,
        top: 10,
        width: !ready && blocker === 'not-visible' ? 0 : 80,
        height: 20,
      });
      dom.window.document.elementFromPoint = () => (!ready && blocker === 'covered' ? overlay : button);
      const refs = new Map([['ref', { backendNodeId: 1 }]]);
      const points = createBrowserRefPoints({
        accessibilityRefs: new Map([[guest, { refs }]]),
        visualGrounding: new Map(),
        diagnostics: () => ({ pendingDialog: null }),
        callAccessibilityRef: async (_guest, _ref, source, args) => {
          probes++;
          const value = await dom.window.eval(`(${source})`).apply(button, args);
          ready = true;
          button.disabled = false;
          button.style.display = '';
          return { handled: true, value };
        },
        cdp: {
          call: async (_guest, method) => {
            assert.equal(method, 'DOM.getBoxModel');
            return { model: { content: [10, 10, 90, 10, 90, 30, 10, 30] } };
          },
        },
        frameOffsetForSession: async () => ({ x: 0, y: 0 }),
        captureSnapshotPayload: async () => {
          captures++;
          assert.fail('a temporary blocker must not retire the ref');
        },
      });
      assert.deepEqual(await points.resolveRefPoint(guest, 'ref'), { x: 50, y: 20 });
      assert.equal(probes, 2);
      assert.equal(captures, 0);
      assert.equal(clicks, 0, 'only the caller may dispatch input after preflight');
    } finally {
      dom.window.close();
    }
  });
}

test('a disabled form field becomes editable before fill dispatches exactly once', async () => {
  const dom = new JSDOM('<input disabled>', { runScripts: 'outside-only' });
  try {
    const input = dom.window.document.querySelector('input');
    input.scrollIntoView = () => {};
    let writes = 0;
    let blocked = 0;
    input.addEventListener('input', () => {
      writes++;
    });
    const guest = { getURL: () => 'https://fixture.example/' };
    const state = new BrowserGuestStateStore();
    state.for(guest).refSet = createBrowserRefSet({
      snapshotId: 'p1-s1',
      url: guest.getURL(),
      viewportWidth: 100,
      viewportHeight: 100,
      elements: [{ ref: 'ref', role: 'textbox', name: 'Email', tag: 'input' }],
    });
    const refActions = createBrowserRefActions({
      callAccessibilityRef: async (_guest, _ref, source, args) => {
        const value = await dom.window.eval(`(${source})`).apply(input, args);
        if (value === 'element is disabled') {
          assert.equal(writes, 0);
          blocked++;
          input.disabled = false;
        }
        return { handled: true, value };
      },
    });
    const reply = createBrowserReply({ state });
    const result = await formActions.fill({
      guest,
      command: { action: 'fill', ref: 'ref', text: 'ready' },
      refRecovery: reply.refRecoveryFor(guest),
      services: { state, refActions, reply },
      actionSnapshot: async () => ({ text: 'filled' }),
    });
    assert.equal(blocked, 1);
    assert.equal(input.value, 'ready');
    assert.equal(writes, 1);
    assert.equal(result.text, 'filled');
  } finally {
    dom.window.close();
  }
});
