// Every attachment kind the composer accepts shows as its thumbnail / chip in
// the user bubble, never also as placeholder words ("[Image]", "[File: …]"),
// and never goes missing: in the pending bubble of this pane, the inline
// bubble of a message sent behind a running turn, the settled row, a reloaded
// transcript and a group room's row. The phone renders the same row.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { installTestDom } from './test-support/test-dom.mjs';

// The attachment cards read the desktop bridge off `window`.
const { restore } = installTestDom(null);
after(restore);

const [
  { TranscriptRow },
  { buildSubmissionContent },
  { desktopPromptDisplayText, pendingPromptImages, pendingPromptTranscriptItems, steerPromptItems },
  { pastedTextFields },
  { makeQueueEntry },
  { promptContentImageMeta },
  { restoredUserText, restoredUserImageRefs },
  { materializePromptSubmission },
] = await Promise.all([
  import('./transcript-row.tsx'),
  import('./use-composer-submission.ts'),
  import('./conversation-prompt-items.ts'),
  import('./composer-support.tsx'),
  import('../../../../src/tui/session/session-flow/queue/entry-shape.mjs'),
  import('../../../../src/tui/session/queue-helpers.mjs'),
  import('../../../../src/runtime/agent/orchestrator/session/transcript-restore/user-text.mjs'),
  import('../../../../src/runtime/attachments/store.mjs'),
]);

const PNG = Buffer.from('png bytes').toString('base64');
const PDF = Buffer.from('%PDF-1.4 pdf bytes').toString('base64');
const DOCX = Buffer.from('PK docx bytes').toString('base64');

const image = (id, name = 'Pasted image', mimeType = 'image/png') => ({
  id,
  name,
  kind: 'image',
  mimeType,
  data: PNG,
  token: '',
});
const pdf = (id, name = 'report.pdf') => ({
  id,
  name,
  kind: 'pdf',
  mimeType: 'application/pdf',
  data: PDF,
  token: `[PDF #${id}: ${name}]`,
  chipOnly: true,
});
const office = (id, name = 'plan.docx') => ({
  id,
  name,
  kind: 'office',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  data: DOCX,
  token: `[File #${id}: ${name}]`,
  chipOnly: true,
});
const textFile = (id, name = 'main.ts') => ({
  id,
  name,
  kind: 'text',
  mimeType: 'text/plain',
  data: 'export const answer = 42;\n',
  token: `[File #${id}: ${name}]`,
  source: 'file',
  chipOnly: true,
});
const pastedText = (id) => ({
  id,
  ...pastedTextFields(id, Array.from({ length: 30 }, (_, line) => `line ${line + 1}`).join('\n')),
  kind: 'text',
  mimeType: 'text/plain',
  source: 'paste',
  chipOnly: true,
});

// What the composer sends for each kind. Video, audio and other files it
// cannot inline, and folders, go in as their path (words the user can edit);
// a voice recording is dictated into the draft as text.
const CASES = [
  { kind: 'pasted image', draft: '', attachments: [image(1)], cards: ['image'], text: '' },
  { kind: 'image file', draft: '', attachments: [image(1, 'photo.jpg', 'image/jpeg')], cards: ['image'], text: '' },
  {
    kind: 'several pasted images',
    draft: '',
    attachments: [image(1), image(2), image(3)],
    cards: ['image', 'image', 'image'],
    text: '',
  },
  { kind: 'PDF', draft: '', attachments: [pdf(1)], cards: ['pdf'], text: '' },
  { kind: 'office document', draft: '', attachments: [office(1)], cards: ['office'], text: '' },
  { kind: 'text / code file', draft: '', attachments: [textFile(1)], cards: ['text'], text: '' },
  { kind: 'pasted text', draft: '', attachments: [pastedText(1)], cards: ['pasted'], text: '' },
  { kind: 'video (path)', draft: 'C:\\clips\\demo.mp4', attachments: [], cards: [], text: 'C:\\clips\\demo.mp4' },
  { kind: 'audio (path)', draft: 'C:\\audio\\memo.m4a', attachments: [], cards: [], text: 'C:\\audio\\memo.m4a' },
  { kind: 'folder (path)', draft: 'C:\\Project\\app', attachments: [], cards: [], text: 'C:\\Project\\app' },
  {
    kind: 'voice recording (dictated)',
    draft: '회의 내용을 요약하세요',
    attachments: [],
    cards: [],
    text: '회의 내용을 요약하세요',
  },
  {
    kind: 'mixed attachments',
    draft: '',
    attachments: [image(1), pdf(2), office(3), textFile(4), pastedText(5)],
    cards: ['image', 'pasted', 'pdf', 'office', 'text'],
    text: '',
  },
  { kind: 'image plus text', draft: 'what is this?', attachments: [image(1)], cards: ['image'], text: 'what is this?' },
  {
    kind: 'files plus text',
    draft: 'review these',
    attachments: [pdf(1), textFile(2)],
    cards: ['pdf', 'text'],
    text: 'review these',
  },
];

/** What the composer submits (`use-composer-submission.ts` send). */
function submission({ draft, attachments }, id) {
  const built = buildSubmissionContent(draft, attachments);
  const displayText = built.expandedText.trim();
  const options = {
    id,
    ...(displayText ? { displayText } : {}),
    ...(Object.keys(built.pastedImages).length ? { pastedImages: built.pastedImages } : {}),
    ...(Object.keys(built.pastedTexts).length ? { pastedTexts: built.pastedTexts } : {}),
  };
  return { content: built.content, options };
}

function rowsOf(c) {
  const id = `sub_${c.kind.replace(/\W+/g, '_')}`;
  const { content, options } = submission(c, id);
  const images = pendingPromptImages(options);
  const optimistic = {
    id,
    kind: 'user',
    text: desktopPromptDisplayText(content, options),
    pending: true,
    accepted: false,
    submittedAt: 1,
    settledUserBaseline: 0,
    ...(images.length ? { images } : {}),
  };
  // The session runtime's queue entry for a message sent behind the turn.
  const entry = makeQueueEntry(content, options, () => id);
  const stored = materializePromptSubmission(content, options).prompt;
  const reloadRefs = restoredUserImageRefs(stored);
  const roomImages = promptContentImageMeta(content, options.pastedImages);
  return {
    pending: pendingPromptTranscriptItems([optimistic], []),
    'pending behind the turn (this pane)': steerPromptItems([], [{ ...optimistic, queuedBehindTurn: true }]),
    'pending behind the turn (session queue)': steerPromptItems([entry], []),
    settled: [{ kind: 'user', id, text: entry.text, ...(entry.images ? { images: entry.images } : {}) }],
    reload: [
      {
        kind: 'user',
        id: 'restored',
        text: restoredUserText(stored),
        ...(reloadRefs.length ? { imageRefs: reloadRefs } : {}),
      },
    ],
    // agent-rooms.ts send: the row's words are the prompt's text parts.
    'group room': [
      {
        kind: 'user',
        id,
        text: (typeof content === 'string' ? [content] : content.filter((part) => part.type === 'text'))
          .map((part) => (typeof part === 'string' ? part : part.text))
          .join('\n')
          .trim(),
        room: { kind: 'user' },
        ...(roomImages ? { images: roomImages } : {}),
      },
    ],
  };
}

const PLACEHOLDER = /\[(?:Image|File|PDF|Video|Audio|Pasted text)\b[^\]]*\]|Attached prompt/;
const visibleText = (html) =>
  html
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&');

test('a restored paste whose line count was not worked out still shows as its chip', () => {
  const html = renderToStaticMarkup(
    React.createElement(TranscriptRow, { item: { kind: 'user', id: 'r1', text: 'see\n[Pasted text #1]' } })
  );
  assert.deepEqual(
    [...html.matchAll(/class="attachment-card (\w+)/g)].map((match) => match[1]),
    ['pasted']
  );
  assert.doesNotMatch(visibleText(html), PLACEHOLDER);
  assert.doesNotMatch(visibleText(html), /undefined|NaN/);
});

test('a sent paste with its text on hand shows the original inline, in place; without it the card stays', async () => {
  const { registerSentAttachments } = await import('./attachment-menu.ts');
  const token = '[Pasted text #1 +2 lines]';
  registerSentAttachments('inline-1', [
    { token, kind: 'text', name: 'Pasted text · 2 lines', mimeType: 'text/plain', data: 'alpha\nbeta', paste: true },
  ]);
  const text = `before\n${token}\nafter`;
  const inline = renderToStaticMarkup(
    React.createElement(TranscriptRow, { item: { kind: 'user', id: 'inline-1', text } })
  );
  assert.doesNotMatch(inline, /class="attachment-card/);
  assert.match(visibleText(inline).replace(/\s+/g, ' '), /before alpha beta after/);
  assert.doesNotMatch(visibleText(inline), PLACEHOLDER);
  const card = renderToStaticMarkup(
    React.createElement(TranscriptRow, { item: { kind: 'user', id: 'inline-missing', text } })
  );
  assert.deepEqual(
    [...card.matchAll(/class="attachment-card (\w+)/g)].map((match) => match[1]),
    ['pasted']
  );
});

for (const c of CASES) {
  test(`${c.kind}: chips only, no placeholder words, nothing dropped`, () => {
    for (const [state, rows] of Object.entries(rowsOf(c))) {
      const where = `${c.kind} / ${state}`;
      assert.equal(rows.length, 1, `${where}: the bubble is kept`);
      const html = renderToStaticMarkup(React.createElement(TranscriptRow, { item: rows[0] }));
      assert.match(html, /<article class="message user/, `${where}: the row renders`);
      const cards = [...html.matchAll(/class="attachment-card (\w+)/g)].map((match) => match[1]);
      assert.deepEqual(cards.sort(), [...c.cards].sort(), `${where}: every attachment as its card`);
      const body = /<div class="message-body"[^>]*>([\s\S]*?)<\/div>/.exec(html);
      if (c.text) assert.equal(visibleText(body?.[1] ?? '').trim(), c.text, `${where}: the words`);
      else assert.equal(body, null, `${where}: no text bubble`);
      assert.doesNotMatch(visibleText(html), PLACEHOLDER, `${where}: no placeholder text`);
    }
  });
}
