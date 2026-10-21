// A compaction divider lands ABOVE the prompt that started the turn (the
// runtime inserts it at the turn's boundary). The frame that carries it may
// also still carry a second copy of that prompt — its pending twin, or the
// same item twice — and both used to project under the prompt's one row key.
// The virtual list owns elements by key: the twin mounted a second element,
// the core's element cache moved to it, and the original element was never
// positioned again. It stayed at its pre-insert offset, drawn over the
// divider, while the twin painted the prompt a second time below — and the
// stranded element kept overlapping the divider after the twin was gone.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const VIEWPORT = 400;
const SESSION = 'compaction-divider';

const prompt = { kind: 'user', id: 'desktop-submit-1', text: '투명도나 채도 이런거 좀 조정좀해야할거같은데 흠' };
const divider = { kind: 'statusdone', id: 'it_352', status: 'compacted', label: 'Conversation compacted' };
const previousTurns = Array.from({ length: 4 }, (_, turn) => [
  { kind: 'user', id: `u${turn}`, text: `question ${turn}` },
  { kind: 'assistant', id: `a${turn}`, text: `answer ${turn}` },
  { kind: 'turndone', id: `t${turn}`, status: 'done', verb: 'Completed', elapsedMs: 1000, checkpointId: `cp${turn}` },
]).flat();
const archived = previousTurns.map((item) => ({ ...item, archived: true }));
const pendingTwin = { ...prompt, pending: true, accepted: true, submittedAt: 1 };

async function projection() {
  const { projectSettledTranscriptRows, appendLiveTranscriptRows } = await import('./transcript-rows.ts');
  const { transcriptTurnKeys } = await import('./renderer-logic.mjs');
  return (items, { pendingItems = [], steerItems = [] } = {}) =>
    appendLiveTranscriptRows({
      sessionKey: SESSION,
      settled: projectSettledTranscriptRows({
        sessionKey: SESSION,
        items,
        turnKeys: transcriptTurnKeys(items),
        failedTurns: new Set(),
      }),
      pendingItems,
      steerItems,
      thinking: true,
    });
}

const promptKey = `${SESSION}:${prompt.id}`;

function rowHeight(row) {
  if (row._tag === 'TurnGap') return 24;
  if (row._tag === 'UserMessage') return 55;
  if (row._tag === 'Thinking') return 40;
  if (row.item?.kind === 'statusdone') return 36;
  return 90;
}

// A layout stand-in (transcript-list-prepend.test.mjs): the viewport scrolls
// over the spacer the list sizes directly, and a ResizeObserver reports each
// row's box from the heights the projection assigned.
async function mountTranscript(heights) {
  const dom = new JSDOM("<div id='viewport'></div>", { url: 'http://localhost/', pretendToBeVisual: true });
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'ResizeObserver', 'HTMLElement', 'Element'];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const viewport = dom.window.document.getElementById('viewport');
  const spacerHeight = () =>
    Number.parseFloat(viewport.querySelector('.transcript-virtual-space')?.style.height || '0') || 0;
  let top = 0;
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, get: () => VIEWPORT },
    offsetHeight: { configurable: true, get: () => VIEWPORT },
    offsetWidth: { configurable: true, get: () => 600 },
    scrollHeight: { configurable: true, get: () => Math.max(VIEWPORT, spacerHeight()) },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value) => {
        top = Math.max(0, Math.min(Number(value) || 0, Math.max(0, spacerHeight() - VIEWPORT)));
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
  const render = (rows) =>
    act(async () => {
      root.render(
        React.createElement(TranscriptList, {
          sessionKey: SESSION,
          rows,
          viewport: { current: viewport },
          content: { current: null },
          shouldAnchorBottom: true,
          scrollToEndRef: { current: () => {} },
          renderRow: (row) => React.createElement('div', null, row.key),
          markProgrammaticScroll: () => {},
          hasScrollGesture: () => false,
          hasTouchScroll: () => false,
          onSelectionAutoScroll: () => {},
        })
      );
    });
  const settle = async () => {
    for (let pass = 0; pass < 4; pass += 1) {
      await act(async () => {
        deliver();
        viewport.dispatchEvent(new dom.window.Event('scroll'));
        await new Promise((resolve) => dom.window.requestAnimationFrame(resolve));
      });
    }
  };
  /** Every mounted row element, in document order. */
  const mounted = () =>
    [...viewport.querySelectorAll('.transcript-virtual-row')].map((element) => ({
      key: element.dataset.timelineKey,
      top: Number.parseFloat(element.style.top),
    }));
  const cleanup = async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
  return { render, settle, mounted, cleanup };
}

/** Where each row of `rows` starts, from the heights alone. */
function expectedTops(rows) {
  const tops = new Map();
  let offset = 0;
  for (const row of rows) {
    tops.set(row.key, offset);
    offset += rowHeight(row);
  }
  return tops;
}

test('a prompt and its twin in the divider frame project ONE row under the prompt key', async () => {
  const project = await projection();
  for (const [name, items, options] of [
    ['pending twin', [...archived, divider, prompt], { pendingItems: [pendingTwin] }],
    ['steering twin', [...archived, divider, prompt], { steerItems: [{ ...pendingTwin, queuedBehindTurn: true }] }],
    ['repeated item', [...archived, divider, prompt, { ...prompt }], {}],
  ]) {
    const rows = project(items, options);
    const keys = rows.map((row) => row.key);
    assert.equal(new Set(keys).size, keys.length, `${name}: every row key is unique (${keys.join(', ')})`);
    assert.equal(
      rows.filter((row) => row._tag === 'UserMessage' && row.item.id === prompt.id).length,
      1,
      `${name}: one bubble`
    );
    // The settled copy keeps its place right under the divider, then the band.
    assert.deepEqual(
      rows.slice(-4).map((row) => row.key),
      [`${SESSION}:${divider.id}`, `${SESSION}:gap:${prompt.id}`, promptKey, `${SESSION}:thinking:${prompt.id}`],
      name
    );
  }
});

// The same twin without a divider: a message sent while the reply runs is a
// steering bubble at the end; when the model reads it, its durable row can
// land a publication before the queue drops the entry. A second message sent
// meanwhile is a steering bubble under both. Every row must keep its own box:
// a stranded element drew the first message over the typing band and the
// rows below it (and the bubble's text twice).
test('a steering message delivered while its queue entry lingers is drawn once, with no row overlapping another', async () => {
  const project = await projection();
  const turn = { kind: 'user', id: 'desktop-submit-go', text: 'go' };
  const first = { kind: 'user', id: 'desktop-submit-a', text: 'BB쪽 개선할만하거 더 있을까. '.repeat(6) };
  const second = { kind: 'user', id: 'desktop-submit-b', text: 'BB쪽 개선할만한거 더 있을까.' };
  const steering = (item) => ({
    ...item,
    pending: true,
    accepted: true,
    submittedAt: 1,
    queuedBehindTurn: true,
    steer: 'pending',
  });
  const heights = new Map();
  const rowsOf = (rows) => {
    for (const row of rows) heights.set(row.key, row.item?.id === first.id ? 220 : rowHeight(row));
    return rows;
  };
  const mount = await mountTranscript(heights);
  const checkFrame = (rows, label) => {
    const keys = rows.map((row) => row.key);
    assert.equal(new Set(keys).size, keys.length, `${label}: every row key is unique (${keys.join(', ')})`);
    const elements = mount.mounted();
    assert.equal(
      new Set(elements.map((element) => element.key)).size,
      elements.length,
      `${label}: one element per row`
    );
    let offset = 0;
    for (const row of rows) {
      const element = elements.find((candidate) => candidate.key === row.key);
      if (element) assert.equal(element.top, offset, `${label}: ${row.key} sits at its own offset`);
      offset += heights.get(row.key);
    }
  };
  try {
    const base = [...previousTurns, turn];
    for (const [label, rows] of [
      ['first sent', project(base, { steerItems: [steering(first)] })],
      ['second sent', project(base, { steerItems: [steering(first), steering(second)] })],
      [
        'first delivered, its entry lingers',
        project([...base, first], { steerItems: [steering(first), steering(second)] }),
      ],
      ['entry gone', project([...base, first], { steerItems: [steering(second)] })],
      ['both delivered', project([...base, first, second])],
    ]) {
      await mount.render(rowsOf(rows));
      await mount.settle();
      checkFrame(rows, label);
    }
  } finally {
    await mount.cleanup();
  }
});

for (const [name, frame] of [
  ['its pending twin', (project) => project([...archived, divider, prompt], { pendingItems: [pendingTwin] })],
  ['a repeated copy of the item', (project) => project([...archived, divider, prompt, { ...prompt }])],
]) {
  test(`a divider inserted above the prompt with ${name} draws the prompt once, below the divider`, async () => {
    const project = await projection();
    const heights = new Map();
    const rowsOf = (rows) => {
      for (const row of rows) heights.set(row.key, rowHeight(row));
      return rows;
    };
    const mount = await mountTranscript(heights);
    try {
      await mount.render(rowsOf(project([...previousTurns, prompt])));
      await mount.settle();
      const checkFrame = (rows, label) => {
        const tops = expectedTops(rows);
        const elements = mount.mounted();
        const promptElements = elements.filter((element) => element.key === promptKey);
        assert.equal(promptElements.length, 1, `${label}: one prompt element (${JSON.stringify(elements)})`);
        for (const element of elements) {
          assert.equal(element.top, tops.get(element.key), `${label}: ${element.key} sits at its own offset`);
        }
        const dividerTop = tops.get(`${SESSION}:${divider.id}`);
        assert.ok(promptElements[0].top >= dividerTop + rowHeight({ item: divider }), `${label}: below the divider`);
      };
      const inserted = rowsOf(frame(project));
      await mount.render(inserted);
      await mount.settle();
      checkFrame(inserted, 'divider frame');
      // The twin leaves with the next publication; nothing stays stranded.
      const settled = rowsOf(project([...archived, divider, prompt]));
      await mount.render(settled);
      await mount.settle();
      checkFrame(settled, 'next frame');
    } finally {
      await mount.cleanup();
    }
  });
}
