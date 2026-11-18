// A phone-attached file must be usable on the PC as a normal file: the store
// keeps the bare content-addressed blob, and a named copy carries the original
// name and a matching extension (what a site's file chooser filters on).
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';

const dataDir = makeTempDirSync('named-attachment-file');
process.env.MIXDOG_DATA_DIR = dataDir;

const { attachmentsForIntake, materializePromptSubmission } = await import('./store.mjs');
const { attachmentFileName } = await import('./attachment-file-name.mjs');


const JPEG = Buffer.from('\xff\xd8\xff\xe0 photo of a lease', 'latin1');

test('file names keep the original name, get the extension their type calls for, and stay path-safe', () => {
  assert.equal(
    attachmentFileName('KakaoTalk_20261103_195007703.jpg', 'image/jpeg'),
    'KakaoTalk_20261103_195007703.jpg'
  );
  assert.equal(attachmentFileName('image', 'image/jpeg'), 'image.jpg');
  assert.equal(attachmentFileName('photo.heic', 'image/jpeg'), 'photo.heic.jpg');
  assert.equal(attachmentFileName('계약서 사본', 'application/pdf'), '계약서 사본.pdf');
  assert.equal(attachmentFileName('main.py', 'text/plain'), 'main.py', 'a text type does not rename source files');
  assert.equal(attachmentFileName('..\\..\\evil:name?.png', 'image/png'), 'evil-name-.png');
  assert.equal(attachmentFileName('nul', 'text/plain'), '_nul.txt');
  assert.equal(attachmentFileName('', 'image/png', 'image'), 'image.png');
  // An overlong extension must not push the name past one path component.
  assert.ok(attachmentFileName(`x.${'a'.repeat(190)}`, '').length <= 120);
  const typed = attachmentFileName(`${'b'.repeat(200)}.${'a'.repeat(190)}`, 'image/png');
  assert.ok(typed.length <= 120 && typed.endsWith('.png'));
  assert.ok(attachmentFileName(`${'a'.repeat(300)}.pdf`, 'application/pdf').length <= 120);
  assert.ok(attachmentFileName(`${'a'.repeat(300)}.pdf`, 'application/pdf').endsWith('.pdf'));
});

const ORIGINAL = Buffer.concat([JPEG, Buffer.from(' full-resolution original '.repeat(40))]);

function resizedSend(originalRef) {
  const intake = materializePromptSubmission(
    [
      { type: 'text', text: 'look' },
      { type: 'image', data: JPEG.toString('base64'), mimeType: 'image/jpeg' },
    ],
    {
      pastedImages: {
        2: {
          id: 2,
          type: 'image',
          mediaType: 'image/webp',
          filename: 'IMG_0042.heic',
          ...(originalRef ? { originalRef, originalMediaType: 'image/heic' } : {}),
        },
      },
    }
  );
  return { intake, attachments: attachmentsForIntake(intake.prompt, intake.options) };
}


function namedBlob(ref) {
  return join(dataDir, 'prompt-attachments', 'sha256', ref.slice(0, 2), ref);
}
