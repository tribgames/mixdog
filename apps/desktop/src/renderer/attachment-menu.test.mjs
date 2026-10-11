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
  openImage: async () => {},
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
  assert.deepEqual(ids(png), ['open', 'open-default', 'copy-image', 'save']);
  assert.deepEqual(ids({ kind: 'image', name: 'a.png' }), []);
  assert.deepEqual(ids({ kind: 'image-marker', name: 'a.png' }), ['copy-name']);
  assert.deepEqual(ids({ kind: 'pasted-text', name: 'p', text: 'hi' }), ['open', 'copy-text', 'save']);
  assert.deepEqual(ids({ kind: 'pasted-text', name: 'p' }), []);
  assert.deepEqual(ids({ kind: 'text-file', name: 'a.ts', text: 'x' }), [
    'open',
    'open-default',
    'copy-contents',
    'save',
  ]);
  assert.deepEqual(ids({ kind: 'pdf', name: 'a.pdf', dataUrl: 'data:application/pdf;base64,AA' }), [
    'open',
    'open-default',
    'save',
  ]);
  assert.deepEqual(ids({ kind: 'office', name: 'a.docx', dataUrl: 'data:x;base64,AA' }), [
    'open',
    'open-default',
    'save',
  ]);
  const labels = attachmentMenuItems(png, all).map((item) => item.label);
  assert.deepEqual(labels.slice(0, 2), ['Open', 'Open with default app']);
});

test('in-app Open is omitted when staging or the opener is unavailable', () => {
  const { openInApp, ...noStage } = all;
  assert.deepEqual(ids({ kind: 'pdf', name: 'a.pdf', dataUrl: 'data:x;base64,AA' }, noStage), ['open-default', 'save']);
  assert.deepEqual(ids({ kind: 'pasted-text', name: 'p', text: 'hi' }, noStage), ['copy-text', 'save']);
  assert.deepEqual(ids({ kind: 'image', name: 'a.png', dataUrl: 'data:x;base64,AA' }, noStage), [
    'open-default',
    'copy-image',
    'save',
  ]);
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
