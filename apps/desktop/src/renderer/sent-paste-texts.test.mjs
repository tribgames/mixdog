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

async function renderRow(item) {
  const { TranscriptRow } = await import('./transcript-row.tsx');
  const { MarkdownSessionContext } = await import('./MarkdownLink.tsx');
  window.mixdogDesktop = {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      React.createElement(MarkdownSessionContext.Provider, { value: 's1' }, React.createElement(TranscriptRow, { item }))
    )
  );
  return { host, unmount: () => act(async () => root.unmount()) };
}

test('a literal paste marker in the user text with no pastes shows verbatim', async () => {
  const text = 'keep \uE0000\uE001 and \uE002 here';
  const { host, unmount } = await renderRow({ kind: 'user', id: 'm5', text });
  assert.equal(host.querySelector('.message-body').textContent, text);
  assert.equal(host.querySelectorAll('.message-pasted-text').length, 0);
  await unmount();
});

test('a literal marker with an unrelated id next to real pastes shows verbatim; real pastes still render', async () => {
  const { registerSentAttachments } = await import('./attachment-menu.ts');
  const name = 'Pasted text · 2 lines';
  const token = '[Pasted text #1 +2 lines]';
  registerSentAttachments('m6', [{ token, kind: 'text', name, mimeType: 'text/plain', data: 'one\ntwo', paste: true }]);
  const literal = 'see \uE0000\uE001 and \uE0007\uE001 too';
  const { host, unmount } = await renderRow({ kind: 'user', id: 'm6', text: `${literal}\n${token}` });
  const pasted = [...host.querySelectorAll('.message-pasted-text')];
  assert.deepEqual(
    pasted.map((entry) => entry.textContent),
    ['one\ntwo'],
    'only the real paste is inlined'
  );
  const plain = [...host.querySelectorAll('.message-body p:not(.message-pasted-text)')].map((entry) => entry.textContent);
  assert.deepEqual(plain, [literal]);
  await unmount();
});

test('a file chip whose name holds a marker character shows its real name and keeps its attachment', async () => {
  const { registerSentAttachments } = await import('./attachment-menu.ts');
  const name = 'a\uE000b.txt';
  const token = `[File #1: ${name}]`;
  registerSentAttachments('m7', [{ token, kind: 'text', name, mimeType: 'text/plain', data: 'FILEDATA' }]);
  const item = {
    kind: 'user',
    id: 'm7',
    text: `${token}\n[Pasted text #2 +2 lines]`,
    attachments: [
      { id: F, name, kind: 'text' },
      { id: A, name: 'other', kind: 'text' },
    ],
  };
  assert.deepEqual(
    sentPastedRecords(item).map((record) => record?.id),
    [A],
    'the file chip reserves its own record by the real name'
  );
  const { host, unmount } = await renderRow(item);
  const cards = [...host.querySelectorAll('.attachment-card')];
  assert.ok(cards.some((card) => card.textContent.includes(name)), 'the card shows the real name');
  await unmount();
  const { extractEscapedFileMarkers, extractPastedTextMarkers } = await import('./transcript-attachments.tsx');
  const { sentFileSource } = await import('./attachment-menu.ts');
  const { text } = extractPastedTextMarkers(item.text);
  const [chip] = extractEscapedFileMarkers(text).chips;
  assert.deepEqual(sentFileSource(chip, 'm7'), { kind: 'text-file', name, text: 'FILEDATA' });
});

test('a tweaks line holding a marker character shows verbatim', async () => {
  const line = 'accent: \uE0000\uE001 \uE002 (was #000)';
  const { host, unmount } = await renderRow({ kind: 'user', id: 'm8', text: `hello\n\uD83C\uDF9A ${line}` });
  assert.equal(host.querySelector('.message-tweaks-line').textContent.trim(), line);
  await unmount();
});

test('marker characters in text, a file marker and a real paste together', async () => {
  const { registerSentAttachments } = await import('./attachment-menu.ts');
  const name = 'n\uE001.txt';
  const fileToken = `[File #1: ${name}]`;
  const pasteToken = '[Pasted text #2 +2 lines]';
  registerSentAttachments('m9', [
    { token: fileToken, kind: 'text', name, mimeType: 'text/plain', data: 'FILEDATA' },
    { token: pasteToken, kind: 'text', name: 'Pasted text · 2 lines', mimeType: 'text/plain', data: 'one\ntwo', paste: true },
  ]);
  const body = 'see \uE0000\uE001 and \uE002 0';
  const { host, unmount } = await renderRow({
    kind: 'user',
    id: 'm9',
    text: `${body}\n${fileToken}\n${pasteToken}`,
  });
  assert.deepEqual(
    [...host.querySelectorAll('.message-pasted-text')].map((entry) => entry.textContent),
    ['one\ntwo']
  );
  assert.deepEqual(
    [...host.querySelectorAll('.message-body p:not(.message-pasted-text)')].map((entry) => entry.textContent),
    [body]
  );
  assert.ok([...host.querySelectorAll('.attachment-card')].some((card) => card.textContent.includes(name)));
  await unmount();
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

async function renderPaste(id, lineCount) {
  const { registerSentAttachments } = await import('./attachment-menu.ts');
  const name = `Pasted text · ${lineCount} lines`;
  const token = `[Pasted text #1 +${lineCount} lines]`;
  const data = Array.from({ length: lineCount }, (_, i) => `line${i + 1}`).join('\n');
  registerSentAttachments(id, [{ token, kind: 'text', name, mimeType: 'text/plain', data, paste: true }]);
  return { data, ...(await renderRow({ kind: 'user', id, text: token })) };
}

test('a 20-line sent paste renders in full with no toggle', async () => {
  const { data, host, unmount } = await renderPaste('m20', 20);
  assert.equal(host.querySelector('.message-pasted-text').textContent, data);
  assert.equal(host.querySelector('.message-pasted-toggle'), null);
  await unmount();
});

test('a 21-line sent paste collapses to 20 lines and toggles', async () => {
  const { data, host, unmount } = await renderPaste('m21', 21);
  const block = () => host.querySelector('.message-pasted-text');
  const button = () => host.querySelector('.message-pasted-toggle');
  assert.equal(block().textContent, data.split('\n').slice(0, 20).join('\n'));
  assert.equal(button().textContent, 'Show more');
  assert.equal(button().getAttribute('aria-expanded'), 'false');
  assert.equal(button().getAttribute('aria-controls'), block().id);
  await act(async () => button().click());
  assert.equal(block().textContent, data);
  assert.equal(button().textContent, 'Show less');
  assert.equal(button().getAttribute('aria-expanded'), 'true');
  await act(async () => button().click());
  assert.equal(block().textContent, data.split('\n').slice(0, 20).join('\n'));
  assert.equal(button().textContent, 'Show more');
  assert.equal(button().getAttribute('aria-expanded'), 'false');
  await unmount();
});
