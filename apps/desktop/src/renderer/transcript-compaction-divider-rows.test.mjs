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

// A layout stand-in (transcript-list-prepend.slow.test.mjs): the viewport scrolls
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

test('a compaction divider that splits a tool group mid-turn draws each half once, at its own offset', async () => {
  const project = await projection();
  const turn = { kind: 'user', id: 'desktop-submit-tools', text: '컴퓨터유즈 왜호출안되는지부터 파악필요할듯' };
  const tool = (id, count) => ({
    kind: 'tool',
    id,
    name: '__aggregate__',
    aggregate: true,
    count,
    completedCount: count,
  });
  const midTurn = { ...divider, id: 'divider:mid-turn' };
  // A group's box grows with its calls, so a split, a re-merge and an update
  // each change the heights of the rows below.
  const heightOf = (row) =>
    row._tag === 'ToolActivity' ? 40 + row.items.reduce((sum, item) => sum + item.count * 3, 0) : rowHeight(row);
  for (const [name, frames] of [
    [
      'a group whose head an older page supplied, split and merged again',
      [
        [tool('tool-n', 9), tool('tool-o', 4)],
        [...previousTurns, turn, tool('tool-a', 6), tool('tool-n', 9), tool('tool-o', 4)],
        [...archived, turn, tool('tool-a', 6), midTurn, tool('tool-n', 9), tool('tool-o', 4)],
        [...archived, turn, tool('tool-a', 6), midTurn, tool('tool-n', 9), tool('tool-o', 7)],
        [...archived, midTurn, turn, tool('tool-a', 6), tool('tool-n', 9), tool('tool-o', 7)],
      ],
    ],
  ]) {
    const heights = new Map();
    const mount = await mountTranscript(heights);
    try {
      for (const [index, items] of frames.entries()) {
        const rows = project(items);
        for (const row of rows) heights.set(row.key, heightOf(row));
        await mount.render(rows);
        await mount.settle();
        const label = `${name}, frame ${index}`;
        const tops = new Map();
        let offset = 0;
        for (const row of rows) {
          tops.set(row.key, offset);
          offset += heights.get(row.key);
        }
        const elements = mount.mounted();
        assert.equal(
          new Set(elements.map((element) => element.key)).size,
          elements.length,
          `${label}: one element per row (${JSON.stringify(elements.slice(-4))})`
        );
        for (const element of elements) {
          assert.equal(element.top, tops.get(element.key), `${label}: ${element.key} sits at its own offset`);
        }
        const keys = rows.map((row) => row.key);
        assert.equal(new Set(keys).size, keys.length, `${label}: every row key is unique (${keys.join(', ')})`);
      }
    } finally {
      await mount.cleanup();
    }
  }
});

test('rows re-sent archived after a compaction stay above the divider, out of the turn that goes on below it', async () => {
  const { sessionReducer, desktopSessionState } = await import(
    '../../../../packages/protocol-client/src/session-state.ts'
  );
  const { projectSettledTranscriptRows } = await import('./transcript-rows.ts');
  const { transcriptTurnKeys } = await import('./renderer-logic.mjs');
  const user = (id, text, ext = {}) => ({ type: 'userMessage', id, content: [{ type: 'text', text }], meta: { ext } });
  const reply = (id, text, ext = {}) => ({ type: 'agentMessage', id, text, meta: { ext } });
  const call = (id, name, ext = {}) => ({
    type: 'toolCall',
    id,
    name,
    input: { path: 'src' },
    run: { callId: id, result: 'ok' },
    meta: { status: 'completed', ext },
  });
  const archive = (item) => ({ ...item, meta: { ...item.meta, ext: { ...item.meta.ext, archived: true } } });
  const held = [
    user('u1', '모델피커에서 모델선택이안되네'),
    call('call:read-1', 'read'),
    call('call:grep-1', 'grep'),
    reply('a1', '원인을 절반까지 좁혔습니다'),
    user('u2', '컴퓨터유즈 왜호출안되는지부터 파악필요할듯'),
  ];
  const older = [
    user('u0', 'ㅎㅇ'),
    call('call:list-0', 'list'),
    call('call:explore-0', 'explore'),
    reply('a0', '안녕하세요'),
  ];
  const completed = (s, item) =>
    sessionReducer.apply(s, { method: 'item/completed', params: { threadId: SESSION, turnId: '', item } });
  let fold = sessionReducer.initial({ thread: { id: SESSION }, items: held, state: {}, hasOlder: true });
  for (const item of [
    { type: 'contextCompaction', id: 'divider:c1', meta: { label: 'Conversation compacted', detail: '520k→41k' } },
    ...[...older, ...held.slice(0, 4)].map(archive),
    reply('a2', '`computer` 호출이 거부되는 지점을 찾겠습니다'),
    call('call:grep-2', 'grep'),
    call('call:shell-2', 'shell'),
  ]) {
    fold = completed(fold, item);
  }
  const items = desktopSessionState(fold, []).items;
  const rows = projectSettledTranscriptRows({
    sessionKey: SESSION,
    items,
    turnKeys: transcriptTurnKeys(items),
    failedTurns: new Set(),
  }).rows;
  const dividerAt = rows.findIndex((row) => row.item?.id === 'divider:c1');
  const shown = (row) => (row._tag === 'ToolActivity' ? row.items.map((item) => item.id) : [row.item?.id]);
  assert.deepEqual(
    rows.slice(dividerAt + 1).map(shown),
    [['a2'], ['call:grep-2', 'call:shell-2']],
    'below the divider: only the turn that goes on'
  );
  assert.deepEqual(
    rows
      .slice(0, dividerAt)
      .filter((row) => row._tag !== 'TurnGap')
      .map((row) => [
        shown(row),
        row._tag === 'ToolActivity' ? row.items.every((item) => item.archived) : row.item.archived === true,
      ]),
    [
      [['u1'], true],
      [['call:read-1'], true],
      [['a1'], true],
      [['u2'], false],
    ],
    'the rows the store held dim where they are'
  );
});

test('a positioned transcript draws a turn whole above a compaction that followed it, and no end inside a turn still arriving', async () => {
  const { sessionReducer, desktopSessionState } = await import(
    '../../../../packages/protocol-client/src/session-state.ts'
  );
  const { projectSettledTranscriptRows } = await import('./transcript-rows.ts');
  const { transcriptTurnKeys } = await import('./renderer-logic.mjs');
  const pos = (id) => `h1:0:${id}`;
  const ext = (id, more = {}) => ({ historyPosition: pos(id), ...more });
  const user = (id) => ({ type: 'userMessage', id, content: [{ type: 'text', text: id }], meta: { at: 1_000, ext: ext(id) } });
  const call = (id) => ({ type: 'toolCall', id, name: 'read', input: { path: 'a.rs' }, run: { callId: id, result: 'ok' }, meta: { status: 'completed', ext: ext(id) } });
  const reply = (id, more = {}) => ({ type: 'agentMessage', id, text: id, meta: { at: 2_000, ext: ext(id, more) } });
  const divider = { type: 'contextCompaction', id: 'divider:k1', meta: { at: 9_000, label: 'Conversation compacted' } };
  // A turn's end is told with its terminal record, as that record's unit: none is shown for a turn still arriving.
  const storedEnd = (of, more = {}) => ({ type: 'turnEnd', id: `${of}:2`, status: 'done', elapsedMs: 1_000, finalAssistantId: of, meta: { at: 2_000, ext: ext(of, { attemptId: `att-${of}`, ...more }) } });
  const unit = (...items) => ({ position: pos(items[0].id), items });
  const fold = (units) =>
    sessionReducer.initial({
      thread: { id: SESSION },
      state: {},
      items: [],
      hasOlder: false,
      window: { windowVersion: 1, lineage: 1, ranges: [{ id: 'tail', older: { kind: 'end' }, newer: { kind: 'end' } }], added: [{ range: 'tail', units }], followTail: true },
    });
  const at = (s, method, params) => sessionReducer.apply(s, { method, params: { threadId: SESSION, ...params } });
  const changed = (s, change) => at(s, 'thread/transcript/changed', { lineage: 1, change });
  const drawn = (s) => {
    const items = desktopSessionState(s, []).items;
    return projectSettledTranscriptRows({ sessionKey: SESSION, items, turnKeys: transcriptTurnKeys(items), failedTurns: new Set() }).rows.map((row) =>
      row._tag === 'ToolActivity'
        ? 'tools'
        : row._tag === 'TurnGap'
          ? 'gap'
          : `${row.item.kind}:${row.item.id}${row.completion ? ` closed by ${row.completion.id} at ${row.completion.at}` : ''}`
    );
  };

  // Between turns: the turn closes, then a compaction reads its reply's record again with the divider on it.
  let s = fold([unit(user('u1')), unit(reply('r1'), storedEnd('r1'))]);
  s = changed(s, { op: 'replace', unit: unit(reply('r1', { archived: true }), storedEnd('r1', { archived: true, dividersAfter: [divider] })) });
  s = changed(s, { op: 'insert', after: pos('r1'), unit: unit(user('u2')) });
  assert.deepEqual(drawn(s), [
    'user:u1',
    'assistant:r1 closed by r1:2 at 2000',
    'gap',
    'statusdone:divider:k1',
    'gap',
    'user:u2',
  ]);

  // In a turn: the turn closes while the records stored after a compaction are still being read.
  s = fold([unit(user('u3')), unit(call('c1'))]);
  s = changed(s, { op: 'insert', after: pos('c1'), unit: unit({ ...call('c2'), meta: { status: 'completed', ext: ext('c2', { dividersAfter: [divider] }) } }) });
  assert.deepEqual(drawn(s), ['user:u3', 'tools', 'statusdone:divider:k1'], 'no end before its reply');
  s = changed(s, { op: 'insert', after: pos('c2'), unit: unit(reply('r3'), storedEnd('r3')) });
  assert.deepEqual(drawn(s), ['user:u3', 'tools', 'statusdone:divider:k1', 'assistant:r3 closed by r3:2 at 2000']);
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
