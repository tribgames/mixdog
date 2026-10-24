import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  expose: ['HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'KeyboardEvent'],
  actEnvironment: false,
});
test.after(restore);
const { createRoot } = await import('react-dom/client');
const { SessionSidebarRow } = await import('./session-sidebar-rows.tsx');
const { requestSessionRead } = await import('./session-read-request.ts');
const { prepareSessionOpen, confirmSessionOpen } = await import('./session-open-intent.ts');
const { defaultSessionLaneStore } = await import('./session-lane-store.ts');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const session = { id: 'pd-1', title: 'Pointer session', updatedAt: 1, createdAt: 1 };

function rowProps(over) {
  const noop = () => {};
  return {
    session,
    active: false,
    attention: '',
    rowKey: 'recent:pd-1',
    editingRowKey: '',
    sessionTitleDraft: '',
    sessionTitleInvalid: false,
    confirmingSessionId: '',
    deletingSessionId: '',
    onTitleDraftChange: noop,
    onStartRename: noop,
    onCancelRename: noop,
    onCommitRename: noop,
    onPrefetchSession: noop,
    onResumeSession: noop,
    onCloseEditor: noop,
    onSetConfirming: noop,
    onSetDeleting: noop,
    onRequestDelete: noop,
    onArchiveSession: async () => {},
    onFavoriteSession: async () => {},
    onDeleteSession: async () => {},
    ...over,
  };
}

test('pressing a session row requests its lane read at once, with no timer, and the open joins it', async (t) => {
  let reads = 0;
  let finish;
  window.mixdogDesktop = {
    prefetchSession: () => {
      reads += 1;
      return new Promise((resolve) => {
        finish = () => {
          defaultSessionLaneStore.apply({
            sessionId: 'pd-1',
            snapshot: { sessionId: 'pd-1', items: [{ id: 'x', role: 'user' }] },
          });
          resolve(true);
        };
      });
    },
  };
  t.after(() => {
    delete window.mixdogDesktop;
  });
  const root = createRoot(document.querySelector('main'));
  t.after(async () => act(async () => root.unmount()));
  await act(async () =>
    root.render(React.createElement(SessionSidebarRow, rowProps({ onPrefetchSession: (id) => requestSessionRead(id) })))
  );
  const row = document.querySelector('.session-row');
  assert.equal(defaultSessionLaneStore.get('pd-1'), null);
  await act(async () => {
    row.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  });
  assert.equal(reads, 1, 'the press itself started the read (no hover delay)');
  // The click's open joins the in-flight read instead of fetching again.
  const joined = requestSessionRead('pd-1');
  assert.equal(reads, 1);
  await act(async () => finish());
  assert.equal(await joined, true);
  assert.ok(defaultSessionLaneStore.get('pd-1'), 'the lane is held by the time the click commits');
  await requestSessionRead('pd-1');
  assert.equal(reads, 1, 'a held lane is never read again');
});

// The intent's lane wait follows the press: it ends when the press does not
// become an open.
async function pressScenario(t, id, over = {}) {
  defaultSessionLaneStore.clear();
  const open = [];
  const subscribe = defaultSessionLaneStore.subscribe;
  defaultSessionLaneStore.subscribe = (sessionId, listener) => {
    open.push(sessionId);
    const stop = subscribe.call(defaultSessionLaneStore, sessionId, listener);
    return () => {
      open.splice(open.indexOf(sessionId), 1);
      stop();
    };
  };
  window.mixdogDesktop = { prefetchSession: async () => true };
  t.after(() => {
    defaultSessionLaneStore.subscribe = subscribe;
    delete window.mixdogDesktop;
  });
  const root = createRoot(document.querySelector('main'));
  t.after(async () => act(async () => root.unmount()));
  await act(async () =>
    root.render(
      React.createElement(SessionSidebarRow, {
        ...rowProps({ onPrefetchSession: prepareSessionOpen, ...over.props }),
        session: { ...session, id, ...over.session },
        rowKey: `recent:${id}`,
      })
    )
  );
  const row = document.querySelector('.session-row');
  const fire = (type, init = {}) =>
    act(async () =>
      row.dispatchEvent(
        type.startsWith('pointer')
          ? new window.MouseEvent(type, { bubbles: true, button: 0, ...init })
          : new window.Event(type, { bubbles: true })
      )
    );
  return { open, fire, root };
}

test('a cancelled press, or a pointer leaving while pressed, ends the intent wait', async (t) => {
  const { open, fire } = await pressScenario(t, 'pd-cancel');
  await fire('pointerdown');
  assert.deepEqual(open, ['pd-cancel'], 'the press waits for the lane');
  await fire('pointercancel');
  assert.deepEqual(open, [], 'pointercancel ended it');
  await fire('pointerdown');
  assert.deepEqual(open, ['pd-cancel']);
  await fire('pointerout');
  assert.deepEqual(open, [], 'leaving while pressed ended it');
});

test('a pointer that left after its release (touch) or a hover keeps the wait; the click commits it', async (t) => {
  const { open, fire } = await pressScenario(t, 'pd-touch');
  await fire('pointerdown');
  await fire('pointerup');
  await fire('pointerout');
  assert.deepEqual(open, ['pd-touch'], 'touch releases before it leaves');
  await fire('click');
});

test('a row that goes away without opening ends the wait; a real open keeps it until delivery', async (t) => {
  const { open, root, fire } = await pressScenario(t, 'pd-gone');
  await fire('pointerdown');
  assert.deepEqual(open, ['pd-gone']);
  await act(async () => root.render(null));
  assert.deepEqual(open, [], 'unmounting without an open ended it');

  const next = await pressScenario(t, 'pd-opened', {
    props: { onResumeSession: () => confirmSessionOpen('pd-opened') },
  });
  await next.fire('pointerdown');
  await next.fire('pointerup');
  await next.fire('click');
  assert.deepEqual(next.open, ['pd-opened'], 'the click navigated, so the wait stays');
  await act(async () => next.root.render(null));
  assert.deepEqual(next.open, ['pd-opened'], 'and outlives the row');
  defaultSessionLaneStore.apply({ sessionId: 'pd-opened', snapshot: { sessionId: 'pd-opened', items: [] } });
  assert.deepEqual(next.open, [], 'the lane delivery ended it');
});

test('a click that did not navigate ends the wait at once, with no timer', async (t) => {
  const { open, fire } = await pressScenario(t, 'pd-nonav');
  await fire('pointerdown');
  await fire('pointerup');
  await fire('click');
  assert.deepEqual(open, [], 'the click handler finalized the unconfirmed intent');
});

test('focus then blur out of the row ends the wait; blur within the row, or while pressed, does not', async (t) => {
  const { open, fire } = await pressScenario(t, 'pd-blur');
  const row = document.querySelector('.session-row');
  await fire('focusin');
  assert.deepEqual(open, ['pd-blur'], 'focus started the intent');
  await act(async () => {
    row.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, relatedTarget: row.querySelector('button') }));
  });
  assert.deepEqual(open, ['pd-blur'], 'focus moving inside the row keeps it');
  await act(async () => {
    row.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  });
  assert.deepEqual(open, [], 'focus leaving the row ended it');
  await fire('pointerdown');
  await act(async () => {
    row.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  });
  assert.deepEqual(open, ['pd-blur'], 'the press moving focus does not end its own intent');
});

test('a click on a row control (delete) ends its intent; the row is not opened', async (t) => {
  let resumed = 0;
  const { open, fire } = await pressScenario(t, 'pd-ctl', {
    session: { archived: true },
    props: { onResumeSession: () => (resumed += 1), onStartDelete: () => {} },
  });
  const control = document.querySelector('.session-row-delete');
  await fire('pointerdown');
  assert.deepEqual(open, ['pd-ctl']);
  await act(async () => control.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  assert.deepEqual(open, [], 'the control finalized its own click');
  assert.equal(resumed, 0);
});

for (const key of ['Enter', ' ']) {
  test(`the fork toggle's ${key === ' ' ? 'Space' : key} key ends its intent; the row is not opened`, async (t) => {
    let resumed = 0;
    let toggled = 0;
    const { open, fire } = await pressScenario(t, `pd-fork-${key.trim() || 'space'}`, {
      props: { forkKind: 'root', onResumeSession: () => (resumed += 1), onToggleFork: () => (toggled += 1) },
    });
    const toggle = document.querySelector('.session-row-fork-toggle');
    await fire('focusin');
    assert.equal(open.length, 1, 'focus started the intent');
    await act(async () => toggle.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key })));
    assert.deepEqual(open, [], 'the key finalized the unconfirmed intent');
    assert.equal(toggled, 1);
    assert.equal(resumed, 0);
  });
}

test('a context menu, and a press with a non-primary button, end or never start the intent', async (t) => {
  const { open, fire } = await pressScenario(t, 'pd-menu');
  await fire('pointerdown', { button: 2 });
  assert.deepEqual(open, [], 'a right-button press starts nothing');
  await fire('pointerdown');
  assert.deepEqual(open, ['pd-menu']);
  const row = document.querySelector('.session-row');
  await act(async () => row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  assert.deepEqual(open, [], 'the context menu ended it');
});

test('a drag that ends without navigating ends the intent', async (t) => {
  const { open, fire } = await pressScenario(t, 'pd-drag');
  await fire('pointerdown');
  assert.deepEqual(open, ['pd-drag']);
  await fire('dragend');
  assert.deepEqual(open, []);
});
