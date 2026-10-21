// An agent chat or room shows a reply only once it is complete, so a long
// reply lands in one frame. Pinned to the end, the reader was carried to the
// reply's LAST line (b-alpha: 3604px in one frame), its first line ~6 screens
// above. A reply taller than the viewport now opens at its first line and
// follow lets go; a reply that fits keeps the end pin, a reader scrolled up
// is never moved, later growth of the reply never re-pins. A coding session
// (streamed replies) does the same where a reply lands whole or grows past
// the viewport; its small deltas before that keep the end pin.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const VIEWPORT = 400;
const SESSION = 'whole-reply';
const GAP = 12;

const history = Array.from({ length: 10 }, (_, index) => ({
  _tag: index % 2 ? 'AssistantPart' : 'UserMessage',
  key: `${SESSION}:h${index}`,
  turnKey: `t${index >> 1}`,
  item: { kind: index % 2 ? 'assistant' : 'user', id: `h${index}`, text: `history ${index}` },
}));
const prompt = { _tag: 'UserMessage', key: `${SESSION}:p`, turnKey: 'tp', item: { kind: 'user', id: 'p', text: 'go' } };
const reply = {
  _tag: 'AssistantPart',
  key: `${SESSION}:r`,
  turnKey: 'tp',
  item: { kind: 'assistant', id: 'r', text: 'long' },
};

let mounts = 0;

async function mountTranscript({ surface, canPause = true }) {
  mounts += 1;
  const mountKey = `${SESSION}-${mounts}`;
  const heights = new Map();
  const dom = new JSDOM("<div id='viewport'></div>", { url: 'http://localhost/', pretendToBeVisual: true });
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'ResizeObserver', 'HTMLElement', 'Element'];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const viewport = dom.window.document.getElementById('viewport');
  const spacerHeight = () =>
    Number.parseFloat(viewport.querySelector('.transcript-virtual-space')?.style.height || '0') || 0;
  let top = 0;
  const maxTop = () => Math.max(0, spacerHeight() - VIEWPORT);
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, get: () => VIEWPORT },
    offsetHeight: { configurable: true, get: () => VIEWPORT },
    offsetWidth: { configurable: true, get: () => 600 },
    scrollHeight: { configurable: true, get: () => Math.max(VIEWPORT, spacerHeight()) },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value) => {
        top = Math.max(0, Math.min(Number(value) || 0, maxTop()));
      },
    },
  });
  viewport.scrollTo = ({ top: next }) => {
    viewport.scrollTop = next;
  };
  const heightOf = (target) => (target === viewport ? VIEWPORT : (heights.get(target.dataset?.timelineKey) ?? 0));
  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const height = heightOf(this);
    return { top: 0, bottom: height, height, left: 0, right: 600, width: 600, x: 0, y: 0 };
  };
  const observers = new Set();
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      observers.add(this);
    }
    observe(target) {
      this.targets.add(target);
    }
    unobserve(target) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
      observers.delete(this);
    }
  }
  const deliver = () => {
    for (const observer of [...observers]) {
      const entries = [...observer.targets]
        .filter((target) => target.isConnected)
        .map((target) => {
          const height = heightOf(target);
          return {
            target,
            borderBoxSize: [{ blockSize: height, inlineSize: 600 }],
            contentRect: { height, width: 600 },
          };
        });
      if (entries.length) observer.callback(entries, observer);
    }
  };
  dom.window.ResizeObserver = FakeResizeObserver;
  for (const [key, value] of [
    ['window', dom.window],
    ['document', dom.window.document],
    ['ResizeObserver', FakeResizeObserver],
    ['HTMLElement', dom.window.HTMLElement],
    ['Element', dom.window.Element],
  ]) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { TranscriptList } = await import('./TranscriptList.tsx');
  const root = createRoot(viewport);
  const setAnchorBottomRef = { current: () => {} };
  let following = true;
  const pauses = [];
  // follow.pause(): the anchor flips in the same task (publish → setAnchorBottomRef).
  const pauseFollow = () => {
    pauses.push(top);
    following = false;
    setAnchorBottomRef.current(false);
  };
  let rows = [];
  const draw = () =>
    root.render(
      React.createElement(TranscriptList, {
        // Each mount is its own session: the list replays a session's
        // remembered measurements on entry.
        sessionKey: mountKey,
        rows,
        viewport: { current: viewport },
        content: { current: null },
        shouldAnchorBottom: following,
        scrollToEndRef: { current: () => {} },
        setAnchorBottomRef,
        pauseFollow: canPause ? pauseFollow : undefined,
        renderRow: (row) => (heights.get(row.key) ? React.createElement('div', null, row.key) : null),
        markProgrammaticScroll: () => {},
        hasScrollGesture: () => false,
        hasTouchScroll: () => false,
        onSelectionAutoScroll: () => {},
        surface,
      })
    );
  const settle = async () => {
    for (let pass = 0; pass < 4; pass += 1) {
      await act(async () => {
        deliver();
        viewport.dispatchEvent(new dom.window.Event('scroll'));
        await new Promise((resolve) => dom.window.requestAnimationFrame(resolve));
      });
    }
  };
  const render = async (next, sizes = {}) => {
    rows = next;
    for (const row of next) if (!heights.has(row.key)) heights.set(row.key, row._tag === 'UserMessage' ? 55 : 90);
    for (const [key, size] of Object.entries(sizes)) heights.set(key, size);
    await act(async () => draw());
    await settle();
  };
  /** The reader scrolls up: follow lets go, the offset is theirs. */
  const scrollUp = async (to) => {
    following = false;
    setAnchorBottomRef.current(false);
    viewport.scrollTop = to;
    await act(async () => draw());
    await settle();
  };
  /** The reader reaches the bottom again: follow re-attaches. */
  const reattach = async () => {
    viewport.scrollTop = maxTop();
    following = true;
    setAnchorBottomRef.current(true);
    await act(async () => draw());
    await settle();
  };
  /** A submit: the prompt row joins and follow is armed in one commit, the viewport where it was. */
  const submit = async (next) => {
    following = true;
    setAnchorBottomRef.current(true);
    await render(next);
  };
  const startOf = (key) => {
    let offset = 0;
    for (const row of rows) {
      if (row.key === key) return offset;
      offset += heights.get(row.key) ?? 0;
    }
    return -1;
  };
  const cleanup = async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
  return { render, scrollUp, reattach, submit, startOf, maxTop, top: () => top, pauses, cleanup };
}

async function withList(surface, body, options = {}) {
  const list = await mountTranscript({ surface, ...options });
  try {
    await list.render(history);
    assert.equal(list.top(), list.maxTop(), 'opens pinned to the end');
    await list.render([...history, prompt]);
    assert.equal(list.top(), list.maxTop(), 'the prompt is pinned');
    await body(list);
  } finally {
    await list.cleanup();
  }
}

for (const surface of ['agent', 'room']) {
  test(`${surface}: a whole reply taller than the viewport lands at its first line and follow pauses`, async () => {
    await withList(surface, async (list) => {
      await list.render([...history, prompt, reply], { [reply.key]: 1200 });
      assert.equal(list.top(), list.startOf(reply.key) - GAP, 'the first line shows');
      assert.equal(list.pauses.length, 1, 'follow paused once');
      // An image in the reply decodes: the reader stays where they are.
      await list.render([...history, prompt, reply], { [reply.key]: 1500 });
      assert.equal(list.top(), list.startOf(reply.key) - GAP, 'growth after the landing never re-pins');
      assert.equal(list.pauses.length, 1);
    });
  });
}

test('agent: a reply painted small first, then whole, lands at its first line', async () => {
  await withList('agent', async (list) => {
    await list.render([...history, prompt, reply], { [reply.key]: 36 });
    assert.equal(list.top(), list.maxTop(), 'the first small paint is pinned');
    await list.render([...history, prompt, reply], { [reply.key]: 1200 });
    assert.equal(list.top(), list.startOf(reply.key) - GAP);
    assert.equal(list.pauses.length, 1);
  });
});

test('agent: a hidden unfinished reply that completes lands at its first line', async () => {
  await withList('agent', async (list) => {
    await list.render([...history, prompt, reply], { [reply.key]: 0 });
    await list.render([...history, prompt, reply], { [reply.key]: 1200 });
    assert.equal(list.top(), list.startOf(reply.key) - GAP);
    assert.equal(list.pauses.length, 1);
  });
});

// Landing on the first line comes with follow letting go. A list that cannot
// let go must not park its followed viewport there: nothing re-pins it.
test('a list without a follow pause keeps a whole reply at the end', async () => {
  await withList(
    'coding',
    async (list) => {
      await list.render([...history, prompt, reply], { [reply.key]: 1200 });
      assert.equal(list.top(), list.maxTop(), 'the followed tail stays at the end');
      assert.equal(list.pauses.length, 0);
    },
    { canPause: false }
  );
});

test('agent: a reply that fits keeps the end pin', async () => {
  await withList('agent', async (list) => {
    await list.render([...history, prompt, reply], { [reply.key]: 300 });
    assert.equal(list.top(), list.maxTop());
    assert.equal(list.pauses.length, 0);
  });
});

test('agent: a reader scrolled up is not moved, and returning to the end does not jump back to the reply', async () => {
  await withList('agent', async (list) => {
    await list.scrollUp(120);
    await list.render([...history, prompt, reply], { [reply.key]: 1200 });
    assert.equal(list.top(), 120, 'the scrolled-up reader stays');
    assert.equal(list.pauses.length, 0);
    await list.reattach();
    await list.render([...history, prompt, reply], { [reply.key]: 1300 });
    assert.equal(list.top(), list.maxTop(), 're-attached follow keeps the end');
    assert.equal(list.pauses.length, 0);
  });
});

test('coding: a reply that lands whole opens at its first line and follow lets go; streamed growth is followed', async () => {
  await withList('coding', async (list) => {
    await list.render([...history, prompt, reply], { [reply.key]: 1200 });
    assert.equal(list.top(), list.startOf(reply.key) - GAP, 'a whole landing shows the first line');
    assert.equal(list.pauses.length, 1);
    await list.render([...history, prompt, reply], { [reply.key]: 1500 });
    assert.equal(list.top(), list.startOf(reply.key) - GAP, 'it stays put while it grows');
    await list.reattach();
    await list.render([...history, prompt, reply], { [reply.key]: 1600 });
    assert.equal(list.top(), list.maxTop(), 'reaching the bottom resumes follow');
  });
  await withList('coding', async (list) => {
    await list.render([...history, prompt, reply], { [reply.key]: 100 });
    assert.equal(list.top(), list.maxTop(), 'small streaming keeps the end pin');
    // The reply grows past the viewport a few lines at a time: followed.
    for (const size of [250, 400, 550, 700, 850, 1000]) {
      await list.render([...history, prompt, reply], { [reply.key]: size });
      assert.equal(list.top(), list.maxTop(), `${size}px: follow keeps the bottom`);
    }
    assert.equal(list.pauses.length, 0);
    // A burst that lands in one step is a whole landing.
    await list.render([...history, prompt, reply], { [reply.key]: 1800 });
    assert.equal(list.top(), list.startOf(reply.key) - GAP, 'a landed burst aligns to the first line');
    assert.equal(list.pauses.length, 1);
  });
});

const pendingPrompt = {
  _tag: 'UserMessage',
  key: `${SESSION}:pp`,
  turnKey: 'tpp',
  item: { kind: 'user', id: 'pp', text: 'go', pending: true },
};
const liveReply = { ...reply, key: `${SESSION}:lr`, turnKey: 'tpp', active: true };

// A prompt sent at the bottom stays at the bottom: no trailing space places
// it near the top (an upward jump of the view); the answer is followed down.
test('a prompt sent at the bottom keeps the end pinned, and the answer is followed as it grows', async () => {
  const { TRANSCRIPT_BOTTOM_SPACER } = await import('./transcript-virtual-cache.ts');
  for (const surface of ['coding', 'agent', 'room']) {
    await withList(surface, async (list) => {
      await list.submit([...history, prompt, pendingPrompt]);
      const end = (rows) => list.startOf(rows.at(-1).key) + (rows.at(-1) === pendingPrompt ? 55 : 0);
      const promptEnd = end([...history, prompt, pendingPrompt]) + TRANSCRIPT_BOTTOM_SPACER - VIEWPORT;
      assert.equal(list.maxTop(), promptEnd, `${surface}: the range ends at the content, no space below it`);
      assert.equal(list.top(), promptEnd, `${surface}: the bottom stays pinned`);
      if (surface !== 'coding') return;
      const rows = [...history, prompt, pendingPrompt, liveReply];
      for (const size of [60, 120, 200, 300, 420, 520]) {
        await list.render(rows, { [liveReply.key]: size });
        const contentEnd = list.startOf(liveReply.key) + size + TRANSCRIPT_BOTTOM_SPACER - VIEWPORT;
        assert.equal(list.maxTop(), contentEnd, `${size}px: the range is the content`);
        assert.equal(list.top(), contentEnd, `${size}px: follow keeps the bottom`);
      }
      assert.equal(list.pauses.length, 0, 'follow never let go');
    });
  }
});

// A streamed answer that grows a few lines per step is followed to the
// bottom at once at every step.
test('coding: an answer growing in small steps keeps the bottom pinned at every step', async () => {
  await withList('coding', async (list) => {
    await list.submit([...history, prompt, pendingPrompt]);
    const rows = [...history, prompt, pendingPrompt, liveReply];
    for (let size = 160; size <= 2400; size += 160) {
      await list.render(rows, { [liveReply.key]: size });
      assert.equal(list.top(), list.maxTop(), `${size}px: pinned to the bottom`);
    }
    assert.equal(list.pauses.length, 0, 'follow never let go');
  });
});

test('coding: a tall answer landing whole after a sent prompt opens at its first line', async () => {
  await withList('coding', async (list) => {
    await list.submit([...history, prompt, pendingPrompt]);
    await list.render([...history, prompt, pendingPrompt, liveReply], { [liveReply.key]: 1500 });
    assert.equal(list.top(), list.startOf(liveReply.key) - GAP, 'the first line shows');
    assert.equal(list.pauses.length, 1, 'follow lets go');
    await list.reattach();
    await list.render([...history, prompt, pendingPrompt, liveReply], { [liveReply.key]: 1600 });
    assert.equal(list.top(), list.maxTop(), 'reaching the bottom resumes follow');
  });
});

test('agent: rows restored on entry never move the reader', async () => {
  const list = await mountTranscript({ surface: 'agent' });
  try {
    await list.render([...history, prompt, reply], { [reply.key]: 1200 });
    assert.equal(list.top(), list.maxTop());
    assert.equal(list.pauses.length, 0);
  } finally {
    await list.cleanup();
  }
});
