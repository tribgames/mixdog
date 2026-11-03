// A message sent while the agent is busy waits as a queued bubble whose image
// thumbnails carry their stored-original refs, but the session's transcript
// does not name those attachments until the message is submitted, so the host
// refuses to serve them by session + id ("This conversation has no such
// attachment."). The queued bubble must open and save from the picture on
// hand without that read; once the message is in the transcript, the host
// file is used as before.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><body><main></main></body>',
  jsdom: { pretendToBeVisual: true },
  expose: ['navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver'],
});
test.after(() => restore());

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { TranscriptRow } = await import('./transcript-row.tsx');
const { MarkdownSessionContext } = await import('./MarkdownLink.tsx');
const { steerPromptItems } = await import('./conversation-prompt-items.ts');
const { persistentImagePreviews, previewKey } = await import('./image-preview-store.ts');
const { DESKTOP_TOAST_EVENT } = await import('./desktop-toasts.tsx');
const { registerImagePreview } = await import('./transcript-metrics.ts');

const REFS = ['c'.repeat(64), 'd'.repeat(64)];
const THUMBNAIL = 'data:image/png;base64,AAAA';
const ORIGINAL = 'data:image/png;base64,BBBB';

async function mount(item, named) {
  const calls = { reads: [], saves: [], toasts: [] };
  window.addEventListener(DESKTOP_TOAST_EVENT, (event) => calls.toasts.push(event.detail.text));
  window.mixdogDesktop = {
    // The host serves only ids the session's transcript names.
    readSessionAttachment: async (session, id) => {
      calls.reads.push([session, id]);
      if (!named.has(id)) throw new Error('This conversation has no such attachment.');
      return { name: 'photo.png', mimeType: 'image/png', size: 1, dataUrl: ORIGINAL };
    },
    saveFileAs: async (...args) => void calls.saves.push(args),
    openAttachmentFile: async () => {},
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      React.createElement(MarkdownSessionContext.Provider, { value: 's1' }, React.createElement(TranscriptRow, { item }))
    )
  );
  return { host, calls, unmount: () => act(async () => root.unmount()) };
}

async function saveEach(host) {
  const cards = [...host.querySelectorAll('.attachment-card')];
  for (const card of cards) {
    await act(async () => {
      card.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    const save = [...document.querySelectorAll('[role="menuitem"]')].find((entry) =>
      /Save image as/.test(entry.textContent)
    );
    assert.ok(save, 'the card offers Save image as');
    await act(async () => save.click());
  }
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  return cards.length;
}

const images = REFS.map((attachmentRef, index) => ({ name: `photo-${index}.png`, mimeType: 'image/png', attachmentRef }));

test('a queued message whose original this pane holds saves it, with no host read and no error toast', async (t) => {
  const [item] = steerPromptItems([{ id: 'q1', text: '', images }], []);
  assert.equal(item.pending, true);
  registerImagePreview('q1', undefined, undefined, ORIGINAL);
  const { host, calls, unmount } = await mount(item, new Set());
  t.after(unmount);
  assert.equal(await saveEach(host), 2, 'both images render');
  assert.deepEqual(calls.reads, [], 'nothing is read by id before the message is in the transcript');
  assert.deepEqual(calls.toasts, []);
  assert.deepEqual(
    calls.saves.map(([source]) => source),
    [ORIGINAL, ORIGINAL]
  );
});

test('a queued message with only the cached thumbnail can be opened but not saved or copied as the image', async (t) => {
  for (const ref of REFS) await persistentImagePreviews.put(previewKey('s1', `attachment:${ref}`), 's1', THUMBNAIL);
  const [item] = steerPromptItems([{ id: 'q4', text: '', images }], []);
  const { host, calls, unmount } = await mount(item, new Set());
  t.after(unmount);
  const cards = [...host.querySelectorAll('.attachment-card')];
  assert.equal(cards.length, 2);
  for (const card of cards) {
    await act(async () => {
      card.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent.trim());
    assert.ok(labels.includes('Open'), 'the thumbnail can be viewed');
    assert.deepEqual(
      labels.filter((label) => /Save|Copy image/.test(label)),
      [],
      'the reduced thumbnail is never offered as the image'
    );
  }
  assert.deepEqual(calls.reads, []);
  assert.deepEqual(calls.saves, []);
  assert.deepEqual(calls.toasts, []);
});

test('once the message is in the transcript its images open from the stored host file', async (t) => {
  const { pending: _pending, ...settled } = { ...steerPromptItems([{ id: 'q2', text: '', images }], [])[0] };
  const { host, calls, unmount } = await mount(settled, new Set(REFS));
  t.after(unmount);
  assert.equal(await saveEach(host), 2);
  assert.deepEqual(
    calls.reads,
    REFS.map((ref) => ['s1', ref])
  );
  assert.deepEqual(calls.toasts, []);
  assert.deepEqual(
    calls.saves.map(([source]) => source),
    [ORIGINAL, ORIGINAL]
  );
});

test('a settled message whose attachment the host refuses still reports the failure', async (t) => {
  const { pending: _pending, ...settled } = { ...steerPromptItems([{ id: 'q3', text: '', images }], [])[0] };
  const { host, calls, unmount } = await mount(settled, new Set());
  t.after(unmount);
  await saveEach(host);
  assert.equal(calls.toasts.length, 2);
  assert.match(calls.toasts[0], /no such attachment/);
});
