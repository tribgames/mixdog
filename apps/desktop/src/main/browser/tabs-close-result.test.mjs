import assert from 'node:assert/strict';
import test from 'node:test';

import { createGuestDebuggerAttachment } from './cdp-debugger-attach.ts';
import { closeSessionTab } from './tabs-close-result.ts';

const tab = (id, url = 'https://x.test/', extra = {}) => ({
  id,
  title: id,
  url,
  active: false,
  loading: false,
  kind: 'page',
  ...extra,
});

const enabledFor = new WeakSet();
function session(t, initial, onClose) {
  if (!enabledFor.has(t) && enabledFor.add(t)) t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  // `marked` holds the ids the host made as replacements for a closed last tab.
  const state = { list: initial, marked: new Set() };
  const tabs = {
    list: () => state.list,
    close: (_s, id) => onClose(state, id, t.mock.timers),
    isReplacement: (_s, id) => state.marked.has(id),
  };
  const run = (id) => closeSessionTab(tabs, 's', id);
  const advance = async (ms) => {
    t.mock.timers.tick(ms);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { state, run, advance };
}

test('closing the only tab reports no user tab left, though the host leaves a blank page of its own', async (t) => {
  const f = session(t, [tab('p1')], (state) => {
    setTimeout(() => {
      state.marked.add('p2');
      state.list = [tab('p2', 'about:blank')];
    }, 100);
  });
  const reply = f.run('p1');
  await f.advance(100);
  await f.advance(25);
  assert.deepEqual(await reply, { remainingTabs: 0 });
});

test('a blank tab the other device adds while the closing tab goes away is a user tab, not the replacement', async (t) => {
  const f = session(t, [tab('p1')], (state) => {
    // Between two polls: p1 is gone and the other device's blank tab is there;
    // the host made no replacement because a tab exists.
    setTimeout(() => {
      state.list = [tab('p7', 'about:blank')];
    }, 10);
  });
  const reply = f.run('p1');
  await f.advance(10);
  await f.advance(25);
  assert.deepEqual(await reply, { remainingTabs: 1 });
});

test('started with two tabs, the other device closes the remaining one: only the host replacement is left, so the panel closes', async (t) => {
  const f = session(t, [tab('p1'), tab('p2')], (state) => {
    setTimeout(() => {
      state.marked.add('p9');
      state.list = [tab('p9', 'about:blank')];
    }, 10);
  });
  const reply = f.run('p1');
  await f.advance(10);
  await f.advance(25);
  assert.deepEqual(await reply, { remainingTabs: 0 });
});

test('"+" reusing the blank replacement while a close is pending makes it a user tab: the panel stays', async (t) => {
  const f = session(t, [tab('p1'), tab('p2', 'about:blank')], (state) => {
    state.marked.add('p2');
    setTimeout(() => {
      state.list = [tab('p2', 'about:blank')];
    }, 100);
    // "+" reuses the blank page and the host releases its mark.
    setTimeout(() => state.marked.delete('p2'), 50);
  });
  const reply = f.run('p1');
  await f.advance(50);
  await f.advance(50);
  await f.advance(25);
  assert.deepEqual(await reply, { remainingTabs: 1 });
});

test('a claimed replacement (mark cleared) that is loading counts as a user tab', async (t) => {
  const f = session(t, [tab('p1')], (state) => {
    setTimeout(() => {
      state.list = [tab('p2', 'about:blank', { loading: true })];
    }, 10);
  });
  const reply = f.run('p1');
  await f.advance(10);
  await f.advance(25);
  assert.deepEqual(await reply, { remainingTabs: 1 });
});

test('a marked replacement with a real address counts as a user tab', async (t) => {
  const f = session(t, [tab('p1')], (state) => {
    setTimeout(() => {
      state.marked.add('p2');
      state.list = [tab('p2', 'https://x.test/', { loading: true })];
    }, 10);
  });
  const reply = f.run('p1');
  await f.advance(10);
  await f.advance(25);
  assert.deepEqual(await reply, { remainingTabs: 1 });
});

test('single page tab ×: the host replacement arriving still loading is not a user tab', async (t) => {
  const f = session(t, [tab('p1', 'https://example.com/')], (state) => {
    setTimeout(() => {
      state.marked.add('p2');
      state.list = [tab('p2', 'about:blank', { loading: true })];
    }, 10);
  });
  const reply = f.run('p1');
  await f.advance(10);
  await f.advance(25);
  assert.deepEqual(await reply, { remainingTabs: 0 });
});

test('single page tab ×: a lazy replacement that is not in the list yet leaves no user tab', async (t) => {
  const f = session(t, [tab('p1', 'https://example.com/')], (state) => {
    setTimeout(() => {
      state.list = [];
    }, 10);
  });
  const reply = f.run('p1');
  await f.advance(10);
  await f.advance(25);
  assert.deepEqual(await reply, { remainingTabs: 0 });
});

test('"+" then load then ×: the claimed page closes to a still-loading replacement and the panel closes', async (t) => {
  // "+" reused the blank replacement (mark cleared) and the user loaded a page into it.
  const f = session(t, [tab('p2', 'https://example.com/')], (state) => {
    state.marked.delete('p2');
    setTimeout(() => {
      state.marked.add('p3');
      state.list = [tab('p3', 'about:blank', { loading: true })];
    }, 10);
  });
  const reply = f.run('p2');
  await f.advance(10);
  await f.advance(25);
  assert.deepEqual(await reply, { remainingTabs: 0 });
});

test('"+" then load then ×: a replacement that is lazy and then loads a user address counts once claimed', async (t) => {
  const f = session(t, [tab('p2', 'https://example.com/')], (state) => {
    setTimeout(() => {
      state.marked.add('p3');
      state.list = [tab('p3', 'about:blank', { loading: true })];
    }, 10);
    // The user "+" claims the fresh stand-in before the reply is settled.
    setTimeout(() => state.marked.delete('p3'), 20);
  });
  const reply = f.run('p2');
  await f.advance(10);
  await f.advance(15);
  assert.deepEqual(await reply, { remainingTabs: 1 });
});

test('the only tab is closed even when the host keeps its blank page: a blank tab closes the panel', async (t) => {
  const f = session(t, [tab('p1', 'about:blank')], () => {});
  assert.deepEqual(await f.run('p1'), { remainingTabs: 0 });
  const g = session(t, [tab('p1', '')], () => {});
  assert.deepEqual(await g.run('p1'), { remainingTabs: 0 });
});

test('a vetoed close of the only page tab keeps the panel', async (t) => {
  const f = session(t, [tab('p1')], () => {});
  const reply = f.run('p1');
  await f.advance(2_000);
  assert.deepEqual(await reply, { remainingTabs: 1 });
});

test('a tab added next to the only tab while it closes still counts, blank or not', async (t) => {
  const f = session(t, [tab('p1')], (state) => {
    state.list = [tab('p1'), tab('p3', 'about:blank')];
    setTimeout(() => {
      state.list = [tab('p3', 'about:blank')];
    }, 100);
  });
  const reply = f.run('p1');
  await f.advance(100);
  await f.advance(25);
  assert.deepEqual(await reply, { remainingTabs: 1 });

  const g = session(t, [tab('p1')], (state) => {
    setTimeout(() => {
      state.list = [tab('p4', 'https://added.test/')];
    }, 100);
  });
  const second = g.run('p1');
  await g.advance(100);
  await g.advance(25);
  assert.deepEqual(await second, { remainingTabs: 1 });
});

test('a blank tab beside a tab added while the only blank tab closes is still counted', async (t) => {
  const f = session(t, [tab('p1', 'about:blank')], (state) => {
    state.list = [tab('p1', 'about:blank'), tab('p5', 'https://added.test/')];
  });
  assert.deepEqual(await f.run('p1'), { remainingTabs: 1 });
});

test('with two tabs, closing one keeps the panel and counts the other', async (t) => {
  const f = session(t, [tab('p1'), tab('p2')], (state) => {
    setTimeout(() => {
      state.list = [tab('p2')];
    }, 50);
  });
  const reply = f.run('p1');
  await f.advance(50);
  await f.advance(25);
  assert.deepEqual(await reply, { remainingTabs: 1 });
  const g = session(t, [tab('p1', 'about:blank'), tab('p2', 'about:blank')], () => {});
  const pending = g.run('p1');
  await g.advance(2_000);
  assert.deepEqual(await pending, { remainingTabs: 2 });
});

test('an aborted about:blank load (superseded by an address) does not fail initialization', async () => {
  const attachment = createGuestDebuggerAttachment({
    state: {},
    onCdpEvent() {},
    initializeTargetSession: async () => {},
  });
  const guest = (error) => ({
    isDestroyed: () => false,
    getURL: () => '',
    loadURL: async () => {
      throw error;
    },
  });
  await attachment.waitForInitialDocument(guest(new Error("ERR_ABORTED (-3) loading 'about:blank'")));
  await assert.rejects(
    attachment.waitForInitialDocument(guest(new Error("ERR_CONNECTION_REFUSED (-102) loading 'about:blank'"))),
    /ERR_CONNECTION_REFUSED/
  );
});
