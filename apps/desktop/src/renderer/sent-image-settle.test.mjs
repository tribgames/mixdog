// A message sent with images: its pending bubble draws them from `images`, its stored row (protocol-client `userRow`)
// only from `[Image: …]` lines and `imageRefs`. The swap keeps each thumbnail's element and picture, and a line that is
// no image's own never takes another image's picture.
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
const { useComposerSubmission } = await import('./use-composer-submission.ts');
const { useConversationComposerActions } = await import('./conversation-support.tsx');
const { pendingPromptTranscriptItems } = await import('./conversation-prompt-items.ts');
const { rowOf } = await import('../../../../packages/protocol-client/src/rows.ts');

/** A composer image chip; `metadata` as `resizeImage` writes it, none when it fell back to the picked bytes. */
const image = (id, metadata = true) => ({
  id,
  name: `shot-${id}.png`,
  kind: 'image',
  mimeType: 'image/png',
  data: Buffer.from(`png bytes ${id}`).toString('base64'),
  token: '',
  ...(metadata ? { metadataText: `[Image: source: shot-${id}.png, ${id * 10}x10]` } : {}),
});

/** Sends `draft` with `attachments` through the composer's send and the pane's submit, as the app does; the host takes
 *  it. Returns this pane's pending bubble and what reached the host. */
async function sendThroughComposer(draft, attachments) {
  const state = { prompts: [], send: null, sent: [] };
  const submitHost = async (content, options) => {
    state.sent.push({ content, options });
    return true;
  };
  function Harness() {
    const [prompts, setPrompts] = React.useState([]);
    state.prompts = prompts;
    const actions = useConversationComposerActions({
      armFollowOnSubmitRef: { current: () => {} },
      composerActions: { current: { invokeResult: (action) => Promise.resolve().then(action), submit: submitHost } },
      draftModeRef: { current: false },
      goalSubmission: { current: null },
      goalSubmitScopeRef: { current: 'session:s1' },
      queuedBehindTurnAtSubmit: { current: false },
      routeSessionIdRef: { current: 's1' },
      setOptimisticPrompts: setPrompts,
      suppressDraftSubmitPaintHandoff: { current: false },
    });
    state.send = useComposerSubmission({
      turnBusy: false,
      commandBusy: false,
      recoveryScope: 'scope-sent-images',
      textarea: { current: { value: draft } },
      draftRef: { current: draft },
      attachmentsRef: { current: attachments },
      pendingLoads: { current: 0 },
      transitioningRef: { current: false },
      composingRef: { current: false },
      submittingRef: { current: false },
      submissionRetryRef: { current: null },
      mountedRef: { current: true },
      historyNavigation: { current: { index: -1, seed: '' } },
      setDraft() {},
      setSubmitting() {},
      setSubmissionRecoveryVersion() {},
      clearNotice() {},
      showNotice() {},
      setAttachmentError(message) {
        if (message) throw new Error(message);
      },
      removeAttachments() {},
      mergeRestoredAttachments: (_restored, text) => text,
      restoredAttachments: (_value, text) => ({ attachments: [], text }),
      executeSlash: async () => false,
      rememberPrompt() {},
      submit: actions.composerSubmit,
      abort: async () => ({}),
    }).send;
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Harness)));
  await act(async () => state.send('', 'form-submit'));
  await act(async () => root.unmount());
  host.remove();
  assert.equal(state.sent.length, 1, 'the host took the message');
  const [pending] = pendingPromptTranscriptItems(state.prompts, []);
  return { pending, ...state.sent[0] };
}

const IMAGE_METADATA_LINE = /\[Image(?::| source:) [^\]\r\n]+\]\s*$/;

/** The thread item the core publishes for that send (user_text.rs `restored_user_parts`, transcript_rows.rs `image_refs`):
 *  the text parts joined by lines, an image drawn by the metadata line that ends the text before it or else by an
 *  `[Image: <type>]` line of its own, and each image's slot in `imageRefs` with its stored original. */
function storedItem(id, content) {
  const texts = [];
  const imageRefs = [];
  let metadata = '';
  for (const part of content) {
    if (part.type === 'image') {
      const line = metadata || `[Image: ${part.mimeType}]`;
      if (!metadata) texts.push(line);
      imageRefs.push({ line, ref: String(imageRefs.length + 1).repeat(64) });
      metadata = '';
      continue;
    }
    texts.push(part.text);
    metadata = IMAGE_METADATA_LINE.test(part.text) ? part.text.trimEnd().split('\n').pop().trim() : '';
  }
  return {
    type: 'userMessage',
    id: 'itm_0123456789abcdef0123456789abcdef',
    clientSubmissionId: id,
    content: [{ type: 'text', text: texts.join('\n') }],
    details: { imageRefs },
    meta: { at: 1 },
  };
}

/** Shows the pending bubble, then the stored row in its place, as the transcript does when the row lands. `cards`: the
 *  stored row's image cards in order, each its hover name and the sent image whose picture it shows (index in the
 *  content), null for none. */
async function swap(t, draft, attachments, cards) {
  // The host answers only later, as a real read does: nothing it returns can stand in for the swap.
  window.mixdogDesktop = { readAttachmentThumbnail: () => new Promise(() => {}) };
  const { pending, content, options } = await sendThroughComposer(draft, attachments);
  const stored = rowOf(storedItem(options.id, content));
  assert.equal(stored.id, pending.id, 'the stored row stands under the submission id');
  const pictures = content.filter((part) => part.type === 'image').map((part) => `data:${part.mimeType};base64,${part.data}`);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(() => act(async () => root.unmount()));
  const render = (item) =>
    act(async () =>
      root.render(
        React.createElement(MarkdownSessionContext.Provider, { value: 's1' }, React.createElement(TranscriptRow, { item }))
      )
    );
  const thumbnails = () => [...host.querySelectorAll('.message-attachments img')];
  await render(pending);
  const before = thumbnails();
  assert.deepEqual(
    before.map((img) => img.getAttribute('src')),
    pictures,
    'the pending bubble shows the images in the order they were sent'
  );
  await render(stored);
  const shown = [...host.querySelectorAll('.message-attachments .attachment-card')].map((card) => {
    const img = card.querySelector('img');
    return [card.getAttribute('data-tooltip'), img ? pictures.indexOf(img.getAttribute('src')) : null];
  });
  assert.deepEqual(shown, cards, "each card shows its own image's picture; a line no image stands behind shows none");
  const after = thumbnails();
  pictures.forEach((picture, index) => {
    const img = after.find((element) => element.getAttribute('src') === picture);
    assert.equal(img, before[index], `image ${index + 1} is the same element, not decoded again`);
  });
  return { host };
}

for (const count of [1, 3]) {
  test(`${count} sent image(s): the stored row keeps each thumbnail element and picture of the pending bubble`, async (t) => {
    const attachments = Array.from({ length: count }, (_, index) => image(index + 1));
    const cards = attachments.map((_, index) => [`shot-${index + 1}.png`, index]);
    const { host } = await swap(t, 'what is this?', attachments, cards);
    assert.equal(host.querySelector('.message-body')?.textContent.trim(), 'what is this?');
  });
}

test('images whose chips are not in id order keep their cards in the order they were sent', async (t) => {
  await swap(t, 'what is this?', [image(3), image(1), image(2)], [
    ['shot-3.png', 0],
    ['shot-1.png', 1],
    ['shot-2.png', 2],
  ]);
});

test('images with and without a metadata line each keep their own picture', async (t) => {
  await swap(t, 'what is this?', [image(1), image(2, false), image(3), image(4, false)], [
    ['shot-1.png', 0],
    ['[Image: image/png]', 1],
    ['shot-3.png', 2],
    ['[Image: image/png]', 3],
  ]);
});

test('an [Image: …] line the user typed takes no picture; each sent image keeps its own', async (t) => {
  await swap(t, 'see\n[Image: source: notes.png, 5x5]\nwhat is this?', [image(1), image(2)], [
    ['notes.png', null],
    ['shot-1.png', 0],
    ['shot-2.png', 1],
  ]);
});

test('a typed line that ends the text draws the image sent without one, as the core takes it', async (t) => {
  await swap(t, 'what is this?\n[Image: source: typed.png, 5x5]', [image(1, false), image(2)], [
    ['typed.png', 0],
    ['shot-2.png', 1],
  ]);
});
