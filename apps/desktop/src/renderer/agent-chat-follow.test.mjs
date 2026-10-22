// A bot's chat (agent mode) and a room follow the bottom the way a session
// does: the real follow hook drives the real TranscriptList. At the bottom, a
// typing bubble arriving, a reply replacing it and the next typing bubble all
// stay pinned; a reader who scrolled up is never moved by any of them.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const VIEWPORT = 400;
const SESSION = 'agent-follow';

const rowOf = (index) => ({
  _tag: index % 2 ? 'AssistantPart' : 'UserMessage',
  key: `${SESSION}:h${index}`,
  turnKey: `t${index >> 1}`,
  item: { kind: index % 2 ? 'assistant' : 'user', id: `h${index}`, text: `history ${index}` },
});
const history = Array.from({ length: 12 }, (_, index) => rowOf(index));
const prompt = { _tag: 'UserMessage', key: `${SESSION}:p`, turnKey: 'tp', item: { kind: 'user', id: 'p', text: 'go' } };
const typing = { _tag: 'Thinking', key: `${SESSION}:th`, turnKey: 'tp' };
const reply = {
  _tag: 'AssistantPart',
  key: `${SESSION}:r`,
  turnKey: 'tp',
  item: { kind: 'assistant', id: 'r', text: 'reply' },
};
const prompt2 = { ...prompt, key: `${SESSION}:p2`, turnKey: 'tp2', item: { ...prompt.item, id: 'p2' } };
const typing2 = { ...typing, key: `${SESSION}:th2`, turnKey: 'tp2' };

let mounts = 0;

async function mountChat({ surface }) {
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
          const isRow = target.dataset?.timelineKey !== undefined;
          const height = target === viewport ? VIEWPORT : isRow ? heightOf(target) : spacerHeight();
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
  const [{ TranscriptList }, { useTranscriptFollow }] = await Promise.all([
    import('./TranscriptList.tsx'),
    import('./use-transcript-follow.ts'),
  ]);
  const root = createRoot(viewport);
  let rows = [];
  let follow = null;
  function Chat() {
    const viewportRef = React.useRef(viewport);
    const content = React.useRef(null);
    const scrollToEndRef = React.useRef(() => {});
    const setAnchorBottomRef = React.useRef(() => {});
    follow = useTranscriptFollow({
      viewport: viewportRef,
      content,
      sessionKey: mountKey,
      setAnchorBottomRef,
      scrollToEndRef,
    });
    return React.createElement(TranscriptList, {
      // Each mount is its own session: the list replays a session's
      // remembered measurements on entry.
      sessionKey: mountKey,
      rows,
      viewport: viewportRef,
      content,
      shouldAnchorBottom: follow.following,
      scrollToEndRef,
      setAnchorBottomRef,
      renderRow: (row) => (heights.get(row.key) ? React.createElement('div', null, row.key) : null),
      markProgrammaticScroll: follow.markProgrammaticScroll,
      hasScrollGesture: follow.hasScrollGesture,
      hasTouchScroll: follow.holdsScrollCorrections,
      touchHoldsCorrections: follow.touchHoldsCorrections,
      onSelectionAutoScroll: follow.handleSelectionAutoScroll,
      surface,
    });
  }
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
    await act(async () => root.render(React.createElement(Chat)));
    await settle();
  };
  /** The reader wheels up and the browser scrolls the transcript. */
  const scrollUp = async (to) => {
    await act(async () => {
      viewport.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -120, bubbles: true }));
      follow.handleWheel({ deltaY: -120, target: viewport, currentTarget: viewport });
      viewport.scrollTop = to;
      viewport.dispatchEvent(new dom.window.Event('scroll'));
      follow.handleScroll();
    });
    // The wheel's gesture window passes.
    await new Promise((resolve) => setTimeout(resolve, 700));
    await settle();
  };
  const cleanup = async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
  return { render, scrollUp, maxTop, top: () => top, following: () => follow.followingRef.current, cleanup };
}

for (const surface of ['agent', 'room', 'coding']) {
  test(`${surface}: at the bottom, a typing bubble, the reply replacing it and the next typing bubble stay pinned`, async () => {
    const chat = await mountChat({ surface });
    try {
      await chat.render(history);
      assert.equal(chat.top(), chat.maxTop(), 'opens at the bottom');
      await chat.render([...history, prompt]);
      assert.equal(chat.top(), chat.maxTop(), 'the sent prompt is at the bottom');
      await chat.render([...history, prompt, typing], { [typing.key]: 62 });
      assert.equal(chat.top(), chat.maxTop(), 'the typing bubble is followed');
      // The reply replaces the typing bubble: same turn, the live band leaves.
      await chat.render([...history, prompt, reply], { [reply.key]: 90 });
      assert.equal(chat.top(), chat.maxTop(), 'the reply is followed');
      await chat.render([...history, prompt, reply, prompt2, typing2], { [typing2.key]: 62 });
      assert.equal(chat.top(), chat.maxTop(), 'the next typing bubble is followed');
      assert.equal(chat.following(), true);
    } finally {
      await chat.cleanup();
    }
  });

  test(`${surface}: a reader scrolled up is not pulled by a typing bubble or a reply`, async () => {
    const chat = await mountChat({ surface });
    try {
      await chat.render([...history, prompt]);
      await chat.scrollUp(200);
      assert.equal(chat.following(), false);
      await chat.render([...history, prompt, typing], { [typing.key]: 62 });
      assert.equal(chat.top(), 200, 'the typing bubble leaves the reader alone');
      await chat.render([...history, prompt, reply], { [reply.key]: 90 });
      assert.equal(chat.top(), 200, 'the reply leaves the reader alone');
    } finally {
      await chat.cleanup();
    }
  });
}

// A reply taller than the viewport that lands whole is the followed tail on
// every surface: the end stays pinned and follow stays armed, as in a
// messenger. Only a reader who scrolled away is left where they are.
for (const surface of ['agent', 'room', 'coding']) {
  test(`${surface}: a reply taller than the viewport landing whole keeps the end pinned`, async () => {
    const chat = await mountChat({ surface });
    try {
      await chat.render([...history, prompt, typing], { [typing.key]: 62 });
      await chat.render([...history, prompt, reply], { [reply.key]: 1200 });
      assert.equal(chat.top(), chat.maxTop(), 'the whole reply is followed to its end');
      assert.equal(chat.following(), true, 'follow stays armed');
      await chat.render([...history, prompt, reply], { [reply.key]: 1500 });
      assert.equal(chat.top(), chat.maxTop(), 'its later growth is followed');
      assert.equal(chat.following(), true);
    } finally {
      await chat.cleanup();
    }
  });

  test(`${surface}: rows restored on entry open at the end and nothing moves the reader after`, async () => {
    const chat = await mountChat({ surface });
    try {
      await chat.render([...history, prompt, reply], { [reply.key]: 1200 });
      assert.equal(chat.top(), chat.maxTop(), 'opens at the end');
      assert.equal(chat.following(), true);
    } finally {
      await chat.cleanup();
    }
  });

  test(`${surface}: a reader scrolled up is not moved by a whole tall reply`, async () => {
    const chat = await mountChat({ surface });
    try {
      await chat.render([...history, prompt]);
      await chat.scrollUp(200);
      assert.equal(chat.following(), false);
      await chat.render([...history, prompt, reply], { [reply.key]: 1200 });
      assert.equal(chat.top(), 200, 'the reader stays');
      assert.equal(chat.following(), false);
    } finally {
      await chat.cleanup();
    }
  });
}

for (const surface of ['agent', 'room']) {
  test(`${surface}: an unfinished reply hidden behind the typing bubble, then shown whole, stays pinned`, async () => {
    const chat = await mountChat({ surface });
    try {
      await chat.render([...history, prompt]);
      await chat.render([...history, prompt, typing], { [typing.key]: 62 });
      await chat.render([...history, prompt, { ...reply, live: true }, typing], { [reply.key]: 0, [typing.key]: 62 });
      assert.equal(chat.top(), chat.maxTop(), 'unfinished + typing');
      await chat.render([...history, prompt, reply], { [reply.key]: 90 });
      assert.equal(chat.top(), chat.maxTop(), 'whole small');
      await chat.render([...history, prompt, reply, typing2], { [typing2.key]: 62 });
      assert.equal(chat.top(), chat.maxTop(), 'the next typing bubble');
      assert.equal(chat.following(), true);
    } finally {
      await chat.cleanup();
    }
  });
}

// A bot's reply that settles in steps while the reader is at the bottom (its
// markdown parses, an image decodes) is followed to its end like a session's
// streamed answer, and so is one that lands tall in ONE step.
for (const surface of ['agent', 'room', 'coding']) {
  test(`${surface}: a reply growing past the viewport in steps stays followed at the bottom`, async () => {
    const chat = await mountChat({ surface });
    try {
      await chat.render([...history, prompt, typing], { [typing.key]: 62 });
      assert.equal(chat.top(), chat.maxTop());
      await chat.render([...history, prompt, reply], { [reply.key]: 90 });
      for (const size of [200, 300, 420, 560, 700]) {
        await chat.render([...history, prompt, reply], { [reply.key]: size });
        assert.equal(chat.top(), chat.maxTop(), `${size}px: pinned to the bottom`);
        assert.equal(chat.following(), true, `${size}px: follow stays armed`);
      }
    } finally {
      await chat.cleanup();
    }
  });
}
