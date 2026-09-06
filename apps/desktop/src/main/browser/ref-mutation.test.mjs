import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { BrowserGuestStateStore } from './guest-state.ts';
import { createBrowserRefSet } from './ref-recovery.ts';
import { createBrowserRefActions } from './ref-actions.ts';
import { createBrowserReply } from './reply.ts';
import { formActions } from './actions/forms.ts';
import { pointerActions } from './actions/pointer.ts';

function payload(snapshotId, role = 'checkbox') {
  return {
    snapshotId, url: 'https://fixture.example/app', viewportWidth: 100, viewportHeight: 100,
    elements: [{ ref: `${snapshotId}-e1`, role, name: 'Fixture', tag: 'input' }],
  };
}

test('checkbox recovery is allowed before input but a rerender after clicking never replays it', async () => {
  for (const phase of ['before', 'after']) {
    const dom = new JSDOM('<input type="checkbox">', { runScripts: 'outside-only' });
    try {
      const guest = { getURL: () => 'https://fixture.example/app' };
      const state = new BrowserGuestStateStore();
      state.for(guest).refSet = createBrowserRefSet(payload('p1-s1'));
      const original = dom.window.document.querySelector('input');
      const refs = new Map([['p1-s1-e1', original]]);
      let clicks = 0;
      let snapshots = 0;
      const replace = () => {
        const fresh = original.cloneNode();
        fresh.checked = false;
        original.replaceWith(fresh);
      };
      if (phase === 'before') replace();
      else original.addEventListener('click', replace, { once: true });
      const refActions = createBrowserRefActions({
        callAccessibilityRef: async (_guest, ref, source, args) => ({
          handled: true, value: await dom.window.eval(`(${source})`).apply(refs.get(ref), args),
        }),
        resolveRefPoint: async () => ({ x: 1, y: 1 }),
        input: { clickAt: async () => { clicks++; dom.window.document.querySelector('input').click(); } },
      });
      const reply = createBrowserReply({
        state,
        captureSnapshotPayload: async () => {
          snapshots++;
          const fresh = payload('p1-s2');
          refs.set('p1-s2-e1', dom.window.document.querySelector('input'));
          state.for(guest).refSet = createBrowserRefSet(fresh);
          return fresh;
        },
      });
      const context = {
        guest, command: { action: 'check', ref: 'p1-s1-e1', checked: true },
        refRecovery: reply.refRecoveryFor(guest),
        services: { state, reply, refActions }, actionSnapshot: async () => ({ text: 'observed' }),
      };
      if (phase === 'before') {
        const result = await formActions.check(context);
        assert.match(result.text, /Automatic ref recovery before input dispatch/);
        assert.equal(snapshots, 1);
        assert.equal(dom.window.document.querySelector('input').checked, true);
      } else {
        await assert.rejects(formActions.check(context), /input may have executed and was not replayed/);
        assert.equal(snapshots, 0);
        assert.equal(state.peek(guest).refSet, undefined);
      }
      assert.equal(clicks, 1);
    } finally { dom.window.close(); }
  }
});

test('form and ref-scroll failures after dispatch cannot enter the recovery loop', async () => {
  for (const action of ['fill', 'fields', 'type', 'select', 'scroll']) {
    const guest = { getURL: () => 'https://fixture.example/app' };
    const state = new BrowserGuestStateStore();
    state.for(guest).refSet = createBrowserRefSet(payload('p1-s1', 'textbox'));
    let writes = 0;
    let recoveries = 0;
    const fail = async () => { writes++; throw new Error('node detached after input'); };
    const reply = createBrowserReply({
      state,
      captureSnapshotPayload: async () => { recoveries++; throw new Error('unexpected recovery'); },
    });
    const context = {
      guest,
      command: action === 'fields'
        ? { action: 'fill', fields: [{ ref: 'p1-s1-e1', text: 'new' }] }
        : { action, ref: 'p1-s1-e1', text: action === 'scroll' ? undefined : 'new', values: ['new'], dy: 100 },
      refRecovery: reply.refRecoveryFor(guest),
      services: {
        state, reply,
        refActions: { prepareRef: async (_guest, ref) => ref, fillRef: fail, typeRef: fail, selectRef: fail },
        snapshots: { evaluateRefScript: fail },
      },
      actionSnapshot: async () => ({ text: 'unexpected success' }),
    };
    const run = action === 'scroll' ? pointerActions.scroll : formActions[action === 'fields' ? 'fill' : action];
    await assert.rejects(run(context), /not replayed/);
    assert.equal(writes, 1);
    assert.equal(recoveries, 0);
    assert.equal(state.peek(guest).refSet, undefined);
  }
});
