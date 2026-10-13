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
import { restoredUserText } from './user-text.mjs';

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
    '  region: x 10%, y 20%, 30%×40% of the pane\'s visible view',
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
  assert.equal(
    restoredUserText(small),
    ['핀과 선택 함께 전송', '[Image: visualize pin 1 · input, 177x21]'].join('\n')
  );
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