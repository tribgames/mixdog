import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  clearAttachmentBufferCache,
  materializePromptSubmission,
  readAttachmentTextWithin,
} from '../../../../attachments/store.mjs';
import { restoreTranscriptItems } from './restore.mjs';
import { createUserTextRestore, restoredUserText } from './user-text.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// What the desktop composer sends with a pin and a pick (visualizeFeedbackPrompt).
const feedbackBlock = (note) =>
  [
    '<visualize_feedback>',
    'The user left this feedback in the visualize panel. Pins are numbered; the image labelled "visualize pin N" is the crop of pin N.',
    'pin 1 · input',
    `  note: ${note.split('\n').join('\n    ')}`,
    '  tab: v8 "검증" · pane 1 (html) · file: design/mockups/_vz2/index.html',
    '  selector: body > label > input',
    '  html: <input type="password" value="[redacted]">',
    `  styles: ${'display: inline-block; '.repeat(30)}`,
    '  box: x 64, y 240, 177×21 (CSS px, page coordinates)',
    '  crop: image "visualize pin 1"',
    'pin 2 · home.png region',
    '  note: Crop tighter',
    '  tab: v2 "Shots" · pane 1 (image) · file: shots/home.png',
    "  region: x 10%, y 20%, 30%×40% of the pane's visible view",
    '  crop: none',
    'choices:',
    '  - tab: v8 "검증" · file: design/mockups/_vz2/index.html · group: "layout" → choice: "airy" ("2안 · 여유 있게")',
    '  - tab: v9 "a · group: \\"x\\"" · file: o.html · group: (none) → choice: "b"',
    '</visualize_feedback>',
  ].join('\n');

const livePrompt = (note) => [
  { type: 'text', text: '핀과 선택 함께 전송' },
  { type: 'text', text: feedbackBlock(note) },
  { type: 'text', text: '[Image: visualize pin 1 · input, 177x21]' },
  { type: 'image', data: PNG, mimeType: 'image/png' },
];

const LIVE_LINES = [
  '핀과 선택 함께 전송',
  '📌 1 · input — 재로드 후에도 남는지 확인 두 줄',
  '📌 2 · home.png region — Crop tighter',
  '☑ layout: 2안 · 여유 있게, b',
];

function withDataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-user-text-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('a stored visualize feedback prompt restores as the lines the live bubble showed', (t) => {
  const dir = withDataDir(t);
  const { prompt } = materializePromptSubmission(livePrompt('재로드 후에도\n남는지 확인 두 줄'));
  // Intake moved the long block and the crop into the attachment store.
  assert.ok(prompt[1].attachmentRef && prompt[1].text === undefined);
  assert.ok(prompt[3].attachmentRef && prompt[3].data === undefined);
  const [item] = restoreTranscriptItems([{ role: 'user', content: prompt }], { sessionId: 's' });
  assert.equal(item.kind, 'user');
  assert.equal(item.text, [...LIVE_LINES, '[Image: visualize pin 1 · input, 177x21]'].join('\n'));
  assert.doesNotMatch(item.text, /\[image: image\/png\]/);

  // Inline (a short block intake keeps in place) restores the same way.
  const inline = restoredUserText(livePrompt('재로드 후에도\n남는지 확인 두 줄'));
  assert.equal(inline, [...LIVE_LINES, '[Image: visualize pin 1 · input, 177x21]'].join('\n'));
  // So does the single-string form a text-only message takes.
  assert.equal(
    restoredUserText(`Pick one\n\n${feedbackBlock('x')}`),
    ['Pick one', '', '📌 1 · input — x', '📌 2 · home.png region — Crop tighter', '☑ layout: 2안 · 여유 있게, b'].join(
      '\n'
    )
  );

  // A blob gone from the store drops the block, as any lost text did; never raw JSON.
  rmSync(join(dir, 'prompt-attachments'), { recursive: true, force: true });
  clearAttachmentBufferCache();
  assert.equal(
    restoredUserText(prompt),
    ['핀과 선택 함께 전송', '[Image: visualize pin 1 · input, 177x21]'].join('\n')
  );
});

test('stored image parts never restore as a raw part marker', (t) => {
  withDataDir(t);
  const { prompt } = materializePromptSubmission([
    { type: 'text', text: 'look' },
    { type: 'text', text: '[Image: source: shot.png, 640x480, displayed at 640x480]' },
    { type: 'image', data: PNG, mimeType: 'image/png' },
    { type: 'image', data: PNG, mimeType: 'image/jpeg' },
  ]);
  assert.equal(
    restoredUserText(prompt),
    ['look', '[Image: source: shot.png, 640x480, displayed at 640x480]', '[Image: image/jpeg]'].join('\n')
  );
});

test('the feedback cap holds on the stored blob, not on the size the reference claims', (t) => {
  const dir = withDataDir(t);
  // A feedback-shaped blob over 128 KiB whose reference claims 100 bytes.
  const { prompt } = materializePromptSubmission(livePrompt(`big ${'y'.repeat(200 * 1024)}`));
  const big = prompt[1];
  assert.ok(big.attachmentRef && big.sizeBytes > 128 * 1024);
  const forged = [prompt[0], { ...big, sizeBytes: 100 }, prompt[2], prompt[3]];
  clearAttachmentBufferCache();
  assert.equal(
    restoredUserText(forged),
    ['핀과 선택 함께 전송', '[Image: visualize pin 1 · input, 177x21]'].join('\n')
  );
  assert.equal(readAttachmentTextWithin(big, 128 * 1024), null, 'a larger blob is rejected, not decoded');

  // Within the cap the bounded read returns the blob's exact text.
  const { prompt: small } = materializePromptSubmission(livePrompt('x'));
  assert.equal(readAttachmentTextWithin(small[1], 128 * 1024), feedbackBlock('x'));
  assert.equal(readAttachmentTextWithin(small[1], 10), null);
  assert.equal(restoredUserText(small).split('\n')[1], '📌 1 · input — x');

  // Bytes that no longer match their content address restore without the block.
  const ref = small[1].attachmentRef;
  writeFileSync(join(dir, 'prompt-attachments', 'sha256', ref.slice(0, 2), ref), feedbackBlock('z'));
  clearAttachmentBufferCache();
  assert.throws(() => readAttachmentTextWithin(small[1], 128 * 1024), /integrity/);
  assert.equal(restoredUserText(small), ['핀과 선택 함께 전송', '[Image: visualize pin 1 · input, 177x21]'].join('\n'));
});

test('other stored long text is not read and restores as before', (t) => {
  withDataDir(t);
  const { prompt } = materializePromptSubmission([
    { type: 'text', text: 'short' },
    { type: 'text', text: 'x'.repeat(2000) },
  ]);
  assert.ok(prompt[1].attachmentRef);
  assert.equal(restoredUserText(prompt), 'short');
});

test('a stored pasted text and an attached text file restore as the chip tokens the live bubble drew', (t) => {
  withDataDir(t);
  const paste = Array.from({ length: 12 }, (_, line) => `line ${line + 1}`).join('\n');
  const { prompt } = materializePromptSubmission('see\n[Pasted text #4 +12 lines]\n[File #7: main.ts]', {
    pastedTexts: {
      4: { id: 4, text: paste, filename: 'Pasted text · 12 lines', source: 'paste' },
      7: { id: 7, text: 'export const a = 1;\n', filename: 'main.ts', source: 'file' },
    },
  });
  assert.ok(prompt.some((part) => part.textKind === 'paste' && part.attachmentRef));
  assert.equal(restoredUserText(prompt).replace(/\n+/g, '\n'), 'see\n[Pasted text #1 +12 lines]\n[File #2: main.ts]');
});

test('legacy pastes without a line count in their name: read once per load, within one byte budget', (t) => {
  const dir = withDataDir(t);
  const body = Array.from({ length: 20 }, (_, line) => `row ${line + 1}`).join('\n');
  const legacy = (word) =>
    materializePromptSubmission(`${word}\n[Pasted text #1 +20 lines]`, {
      // Stored before the name carried the count.
      pastedTexts: { 1: { id: 1, text: body, filename: 'pasted-text.txt', source: 'paste' } },
    }).prompt;
  const [a, b, c] = [legacy('a'), legacy('b'), legacy('c')];
  const size = Buffer.byteLength(body);
  // Budget for two reads. Message a's text and image refs share one read, so
  // b still gets its count; c is past the budget and shows the plain chip.
  const load = createUserTextRestore({ readBudgetBytes: size * 2 });
  assert.equal(load.text(a).replace(/\n+/g, '\n'), 'a\n[Pasted text #1 +20 lines]');
  assert.deepEqual(load.imageRefs(a), []);
  assert.equal(load.text(a).replace(/\n+/g, '\n'), 'a\n[Pasted text #1 +20 lines]');
  assert.equal(load.text(b).replace(/\n+/g, '\n'), 'b\n[Pasted text #1 +20 lines]');
  assert.equal(load.text(c).replace(/\n+/g, '\n'), 'c\n[Pasted text #1]');
  // A read that fails its integrity check still counts against the cap.
  const tamperedBody = `${body}\nrow 21`;
  const tampered = materializePromptSubmission('t\n[Pasted text #1 +21 lines]', {
    pastedTexts: { 1: { id: 1, text: tamperedBody, filename: 'pasted-text.txt', source: 'paste' } },
  }).prompt;
  const ref = tampered.find((part) => part.attachmentRef).attachmentRef;
  writeFileSync(join(dir, 'prompt-attachments', 'sha256', ref.slice(0, 2), ref), `${tamperedBody}!`);
  clearAttachmentBufferCache();
  const strict = createUserTextRestore({ readBudgetBytes: size * 2 + 64 });
  assert.equal(strict.text(tampered).replace(/\n+/g, '\n'), 't\n[Pasted text #1]');
  assert.equal(strict.text(b).replace(/\n+/g, '\n'), 'b\n[Pasted text #1]', 'the failed read used the budget');
  // A whole transcript load counts them within the default budget.
  const items = restoreTranscriptItems([{ role: 'user', content: a }]);
  assert.equal(items[0].text.replace(/\n+/g, '\n'), 'a\n[Pasted text #1 +20 lines]');
});

test('a message the model read inside its running turn restores with its read mark', () => {
  const [typed, steered] = restoreTranscriptItems(
    [
      { role: 'user', content: 'start' },
      { role: 'user', content: 'also add a summary', meta: { source: 'steering', submissionIds: ['s1'] } },
    ],
    { sessionId: 's' }
  );
  assert.equal(typed.steered, undefined, 'the prompt that opened the turn carries no mark');
  assert.equal(steered.kind, 'user');
  assert.equal(steered.text, 'also add a summary');
  assert.equal(steered.steered, true);
});

test('a tweaks section restores as the live icon line, after pins and picks', () => {
  const block = [
    '<visualize_feedback>',
    'The user left this feedback in the visualize panel.',
    'tweaks (the user adjusted these in the panel; make them the new defaults):',
    '  - tab: v1 "Card" · pane 1 · file: a.html',
    '    card-radius (--card-radius): 24px (was 16px)',
    '    density (data-density): compact (was cozy)',
    '  - tab: v2 "Nav" · pane 1 · file: b.html',
    '    accent (--accent): #2f6fed (was #3b82f6)',
    '</visualize_feedback>',
  ].join('\n');
  assert.equal(
    restoredUserText(`Tune\n\n${block}`),
    'Tune\n\n🎚 card-radius: 24px (was 16px), density: compact (was cozy); accent: #2f6fed (was #3b82f6)'
  );
});

test('a prompt whose only text was offloaded restores it; beside other text it stays out', (t) => {
  const dir = withDataDir(t);
  for (const size of [941, 22 * 1024]) {
    const body = `마케터가 전달드립니다. ${'가'.repeat(Math.ceil(size / 3))}`;
    const { prompt } = materializePromptSubmission([{ type: 'text', text: body }]);
    assert.ok(prompt[0].attachmentRef && prompt[0].text === undefined, `${size} B offloaded`);
    const [item] = restoreTranscriptItems(
      [{ role: 'user', content: prompt, meta: { transcript: { sender: 'lead', fromAgent: 'agent-1' } } }],
      { sessionId: 's' }
    );
    assert.equal(item.text, body);
    assert.equal(item.fromAgent, 'agent-1');
  }
  // A blob gone from the store drops the row as before.
  const { prompt } = materializePromptSubmission([{ type: 'text', text: 'x'.repeat(3000) }]);
  rmSync(join(dir, 'prompt-attachments'), { recursive: true, force: true });
  clearAttachmentBufferCache();
  assert.deepEqual(restoreTranscriptItems([{ role: 'user', content: prompt }], { sessionId: 's' }), []);
});
test('a long offloaded prompt with an image restores its text in place, not just the image label', (t) => {
  withDataDir(t);
  const body = `긴 프롬프트 ${'가'.repeat(2000)}`;
  const { prompt } = materializePromptSubmission([
    { type: 'text', text: body },
    { type: 'image', data: PNG, mimeType: 'image/png' },
  ]);
  assert.ok(prompt[0].attachmentRef);
  assert.equal(restoredUserText(prompt), `${body}\n[Image: image/png]`);
});
