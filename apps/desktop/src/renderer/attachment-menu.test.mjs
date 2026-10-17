import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachmentMenuItems,
  composerAttachmentSource,
  extractFileMarkers,
  fileChipKind,
  registerSentAttachments,
  sentAttachmentData,
  sentFileSource,
  sentPastedTextSource,
} from './attachment-menu.ts';

const all = {
  openInApp: async () => {},
  openLightbox: async () => {},
  openFile: async () => {},
  saveAs: async () => {},
  copyImage: async () => {},
  copyText: async () => {},
};
const ids = (source, actions = all) => attachmentMenuItems(source, actions).map((item) => item.id);

test('extractFileMarkers turns [File #n: name] and [PDF #n: name] tokens into chips', () => {
  const parsed = extractFileMarkers('look [File #2: notes.md] and [PDF #3: a b.pdf] please');
  assert.equal(parsed.text, 'look and please');
  assert.deepEqual(
    parsed.chips.map((chip) => [chip.token, chip.tokenKind, chip.name]),
    [
      ['[File #2: notes.md]', 'File', 'notes.md'],
      ['[PDF #3: a b.pdf]', 'PDF', 'a b.pdf'],
    ]
  );
  assert.deepEqual(extractFileMarkers('plain [File #x]'), { text: 'plain [File #x]', chips: [] });
});

test('fileChipKind falls back to the extension', () => {
  assert.equal(fileChipKind({ token: '', tokenKind: 'PDF', name: 'x' }), 'pdf');
  assert.equal(fileChipKind({ token: '', tokenKind: 'File', name: 'r.DOCX' }), 'office');
  assert.equal(fileChipKind({ token: '', tokenKind: 'File', name: 'a.ts' }), 'text-file');
});

test('menu items per attachment kind', () => {
  const png = { kind: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,AA' };
  // Previewable types open inside the app; none of them offers the OS app.
  assert.deepEqual(ids(png), ['open', 'copy-image', 'save']);
  assert.deepEqual(ids({ kind: 'image', name: 'a.png' }), []);
  assert.deepEqual(ids({ kind: 'image-marker', name: 'a.png' }), ['copy-name']);
  assert.deepEqual(ids({ kind: 'pasted-text', name: 'p', text: 'hi' }), ['open', 'copy-text', 'save']);
  assert.deepEqual(ids({ kind: 'pasted-text', name: 'p' }), []);
  assert.deepEqual(ids({ kind: 'text-file', name: 'a.ts', text: 'x' }), ['open', 'copy-contents', 'save']);
  assert.deepEqual(ids({ kind: 'pdf', name: 'a.pdf', dataUrl: 'data:application/pdf;base64,AA' }), ['open', 'save']);
  assert.deepEqual(ids({ kind: 'office', name: 'a.docx', dataUrl: 'data:x;base64,AA' }), ['open', 'save']);
  const labels = attachmentMenuItems(png, all).map((item) => item.label);
  assert.deepEqual(labels, ['Open', 'Copy image', 'Save image as…']);
});

test('only a type the app cannot preview keeps "open with default app"', () => {
  assert.deepEqual(ids({ kind: 'office', name: 'a.zip', dataUrl: 'data:x;base64,AA' }), ['open-default', 'save']);
  const { openFile, ...remote } = { ...all, deviceSave: true };
  assert.deepEqual(ids({ kind: 'office', name: 'a.zip', dataUrl: 'data:x;base64,AA' }, remote), ['save']);
});

test('every attachment kind has a save item, labelled Download / Share on a paired device', () => {
  const sources = [
    { kind: 'image', name: 'a.png', dataUrl: 'data:x;base64,AA' },
    { kind: 'pasted-text', name: 'p', text: 'hi' },
    { kind: 'text-file', name: 'a.ts', text: 'x' },
    { kind: 'pdf', name: 'a.pdf', dataUrl: 'data:x;base64,AA' },
    { kind: 'office', name: 'a.zip', dataUrl: 'data:x;base64,AA' },
  ];
  for (const source of sources) {
    const desktop = attachmentMenuItems(source, all).find((item) => item.id === 'save');
    const device = attachmentMenuItems(source, { ...all, deviceSave: true }).find((item) => item.id === 'save');
    assert.match(desktop.label, /^Save .* as…$/, source.kind);
    assert.equal(device.label, 'Download / Share', source.kind);
  }
});

test('an attachment stored on the PC opens and saves from that file, ahead of any bytes in this window', async () => {
  const calls = [];
  const stored = { sessionId: 's1', id: 'a'.repeat(64) };
  const actions = {
    ...all,
    openStored: async (ref, name) => void calls.push(['open', ref.id, name]),
    openStoredDefault: async (ref, name) => void calls.push(['open-default', ref.id, name]),
    saveStored: async (ref, name) => void calls.push(['save', ref.id, name]),
    saveAs: async () => void calls.push(['saveAs']),
    openInApp: async () => void calls.push(['openInApp']),
  };
  const select = (source, id) =>
    attachmentMenuItems(source, actions)
      .find((item) => item.id === id)
      ?.onSelect();
  // Bytes the window also holds never win over the host's file.
  const pdf = { kind: 'pdf', name: 'spec.pdf', dataUrl: 'data:application/pdf;base64,AA', stored };
  select(pdf, 'open');
  select(pdf, 'save');
  // No bytes at all (after a restart): the stored file is all there is.
  select({ kind: 'pdf', name: 'spec.pdf', stored }, 'open');
  select({ kind: 'image-marker', name: 'old.png', stored }, 'open');
  // Not previewable: the OS app (desktop only).
  select({ kind: 'office', name: 'bundle.zip', stored }, 'open-default');
  await Promise.resolve();
  assert.deepEqual(calls, [
    ['open', stored.id, 'spec.pdf'],
    ['save', stored.id, 'spec.pdf'],
    ['open', stored.id, 'spec.pdf'],
    ['open', stored.id, 'old.png'],
    ['open-default', stored.id, 'bundle.zip'],
  ]);
  assert.deepEqual(ids({ kind: 'image-marker', name: 'old.png', stored }, actions), ['open', 'save', 'copy-name']);
  // On a paired device the unpreviewable type is only Download / Share.
  const remote = { ...actions, deviceSave: true, openStoredDefault: undefined };
  const items = attachmentMenuItems({ kind: 'office', name: 'bundle.zip', stored }, remote);
  assert.deepEqual(
    items.map((item) => [item.id, item.label]),
    [['save', 'Download / Share']]
  );
});

test('without a stored file a legacy chip behaves as it did, without errors', () => {
  assert.deepEqual(ids({ kind: 'pdf', name: 'old.pdf' }), []);
  assert.deepEqual(ids({ kind: 'text-file', name: 'old.ts' }), []);
  assert.deepEqual(ids({ kind: 'image-marker', name: 'old.png' }), ['copy-name']);
});

test('in-app Open is omitted when staging is unavailable; images fall back to the lightbox', () => {
  const { openInApp, ...noStage } = all;
  assert.deepEqual(ids({ kind: 'pdf', name: 'a.pdf', dataUrl: 'data:x;base64,AA' }, noStage), ['save']);
  assert.deepEqual(ids({ kind: 'pasted-text', name: 'p', text: 'hi' }, noStage), ['copy-text', 'save']);
  assert.deepEqual(ids({ kind: 'image', name: 'a.png', dataUrl: 'data:x;base64,AA' }, noStage), [
    'open',
    'copy-image',
    'save',
  ]);
});

test('an image opens in the side panel when it can, never in the OS viewer', async () => {
  const calls = [];
  const items = attachmentMenuItems(
    { kind: 'image', name: 'a.png', dataUrl: 'data:x;base64,AA' },
    {
      openInApp: async (_url, name) => void calls.push(['side', name]),
      openLightbox: async () => void calls.push(['lightbox']),
      openFile: async () => void calls.push(['os']),
    }
  );
  items.find((item) => item.id === 'open').onSelect();
  await Promise.resolve();
  assert.deepEqual(calls, [['side', 'a.png']]);
});

test('in-app Open stages the pasted text as pasted-text.txt', async () => {
  const calls = [];
  const items = attachmentMenuItems(
    { kind: 'pasted-text', name: 'p', text: 'hi' },
    { openInApp: async (url, name) => void calls.push([url.startsWith('data:text/plain'), name]) }
  );
  items[0].onSelect();
  await Promise.resolve();
  assert.deepEqual(calls, [[true, 'pasted-text.txt']]);
});
test('items without a backing action are omitted', () => {
  assert.deepEqual(ids({ kind: 'text-file', name: 'a.ts', text: 'x' }, { copyText: all.copyText }), ['copy-contents']);
});

const pending = { id: 1, name: 'n', kind: 'text', mimeType: 'text/plain', data: 'body', token: '[File #1: n]' };

test('composer sources carry pending data', () => {
  assert.deepEqual(composerAttachmentSource(pending), { kind: 'text-file', name: 'n', text: 'body' });
  assert.equal(composerAttachmentSource({ ...pending, source: 'paste' }).kind, 'pasted-text');
});

test('the same token in two messages resolves to each message own data', () => {
  const chip = { token: '[File #1: n]', tokenKind: 'File', name: 'n' };
  registerSentAttachments('msg-a', sentAttachmentData([{ ...pending, data: 'first' }]));
  registerSentAttachments('msg-b', sentAttachmentData([{ ...pending, data: 'second' }]));
  assert.equal(sentFileSource(chip, 'msg-a').text, 'first');
  assert.equal(sentFileSource(chip, 'msg-b').text, 'second');
  const paste = { ...pending, source: 'paste', token: '[Pasted text #1 +1 lines]' };
  registerSentAttachments('msg-a', sentAttachmentData([{ ...paste, data: 'pa' }]));
  registerSentAttachments('msg-b', sentAttachmentData([{ ...paste, data: 'pb' }]));
  assert.equal(sentPastedTextSource(paste.token, 'p', 'msg-a').text, 'pa');
  assert.equal(sentPastedTextSource(paste.token, 'p', 'msg-b').text, 'pb');
});

test('no identity or an unknown identity resolves no data (no token-only fallback)', () => {
  const chip = { token: '[File #1: n]', tokenKind: 'File', name: 'n' };
  registerSentAttachments('msg-c', sentAttachmentData([pending]));
  assert.deepEqual(sentFileSource(chip, undefined), { kind: 'text-file', name: 'n' });
  assert.deepEqual(sentFileSource(chip, 'msg-other'), { kind: 'text-file', name: 'n' });
  assert.equal(sentPastedTextSource('[Pasted text #1 +1 lines]', 'p', 'msg-other').text, undefined);
  assert.deepEqual(ids(sentFileSource(chip, 'msg-other')), []);
});

test('a never-accepted submission registers nothing (registration is explicit)', () => {
  const chip = { token: '[File #5: r.txt]', tokenKind: 'File', name: 'r.txt' };
  // The composer calls registerSentAttachments only after `accepted === true`;
  // a rejected id therefore stays unresolvable even if the token is reused.
  registerSentAttachments('accepted-1', sentAttachmentData([{ ...pending, token: chip.token, data: 'ok' }]));
  assert.equal(sentFileSource(chip, 'rejected-1').text, undefined);
  assert.equal(sentFileSource(chip, 'accepted-1').text, 'ok');
});

test('sentAttachmentData skips images and tokenless attachments', () => {
  const image = { ...pending, kind: 'image', token: '' };
  assert.deepEqual(sentAttachmentData([image, { ...pending, token: '' }]), []);
});
