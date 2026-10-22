import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

// Which stored attachment each pasted token of a sent message stands for, and
// how the originals are read back from the host.
const { restore } = installTestDom(null, {
  html: '<!doctype html><body><main></main></body>',
  jsdom: { pretendToBeVisual: true },
  expose: ['navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver'],
});
test.after(() => restore());

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { sentPastedRecords, useSentPastedTexts } = await import('./transcript-attachments.tsx');

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const F = 'f'.repeat(64);
const dataUrl = (text) => `data:text/plain;base64,${Buffer.from(text).toString('base64')}`;

test('same-name pastes each keep their own record', () => {
  const name = 'Pasted text · 2 lines';
  const item = {
    kind: 'user',
    id: 'm1',
    text: '[Pasted text #1 +2 lines]\n[Pasted text #2 +2 lines]',
    attachments: [
      { id: A, name, kind: 'text' },
      { id: B, name, kind: 'text' },
    ],
  };
  assert.deepEqual(
    sentPastedRecords(item).map((record) => record?.id),
    [A, B]
  );
});

test('with the first of two same-name pastes shown inline, the remaining card acts on its own attachment', async () => {
  const { registerSentAttachments } = await import('./attachment-menu.ts');
  const { TranscriptRow } = await import('./transcript-row.tsx');
  const { MarkdownSessionContext } = await import('./MarkdownLink.tsx');
  const name = 'Pasted text · 2 lines';
  const first = '[Pasted text #1 +2 lines]';
  registerSentAttachments('m4', [
    { token: first, kind: 'text', name, mimeType: 'text/plain', data: 'one\ntwo', paste: true },
  ]);
  const item = {
    kind: 'user',
    id: 'm4',
    text: `${first}\n[Pasted text #2 +2 lines]`,
    attachments: [
      { id: A, name, kind: 'text' },
      { id: B, name, kind: 'text' },
    ],
  };
  const reads = [];
  window.mixdogDesktop = {
    readSessionAttachment: async (session, id) => {
      reads.push([session, id]);
      // The row's own read of the second paste fails, so its card stays.
      if (reads.length === 1) throw new Error('store unavailable');
      return { name, mimeType: 'text/plain', size: 1, dataUrl: dataUrl('x') };
    },
    saveFileAs: async () => {},
    openAttachmentFile: async () => {},
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      React.createElement(
        MarkdownSessionContext.Provider,
        { value: 's1' },
        React.createElement(TranscriptRow, { item })
      )
    )
  );
  const cards = host.querySelectorAll('.attachment-card');
  assert.equal(cards.length, 1, 'only the unresolved paste stays a card');
  await act(async () => {
    cards[0].dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  const save = [...document.querySelectorAll('[role="menuitem"]')].find((entry) =>
    /Save file as/.test(entry.textContent)
  );
  await act(async () => save.click());
  assert.deepEqual(
    reads,
    [
      ['s1', B],
      ['s1', B],
    ],
    'the row reads B, then the card acts on B, never on A'
  );
  await act(async () => root.unmount());
});

test('an attached text file is never taken for a paste marker', () => {
  const item = {
    kind: 'user',
    id: 'm2',
    text: '[File #1: main.ts]\n[Pasted text #2]',
    attachments: [{ id: F, name: 'main.ts', kind: 'text' }],
  };
  assert.deepEqual(sentPastedRecords(item), [undefined]);
});

test('one finished read does not restart the reads still in flight', async () => {
  const name = 'Pasted text · 2 lines';
  const item = {
    kind: 'user',
    id: 'm3',
    text: '[Pasted text #1 +2 lines]\n[Pasted text #2 +2 lines]',
    attachments: [
      { id: A, name, kind: 'text' },
      { id: B, name, kind: 'text' },
    ],
  };
  const calls = [];
  const settlers = {};
  window.mixdogDesktop = {
    readSessionAttachment: (session, id) => {
      calls.push([session, id]);
      return new Promise((resolve) => {
        settlers[id] = resolve;
      });
    },
  };
  function Probe() {
    const { texts } = useSentPastedTexts(item, 's1');
    return React.createElement('output', null, JSON.stringify(texts));
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Probe)));
  assert.deepEqual(calls, [
    ['s1', A],
    ['s1', B],
  ]);
  await act(async () => settlers[A]({ dataUrl: dataUrl('first') }));
  await act(async () => settlers[B]({ dataUrl: dataUrl('second') }));
  assert.equal(calls.length, 2, 'each stored paste is read once');
  assert.equal(host.textContent, JSON.stringify(['first', 'second']));
  await act(async () => root.unmount());
});
