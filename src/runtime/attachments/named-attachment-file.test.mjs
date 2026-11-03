// A phone-attached file must be usable on the PC as a normal file: the store
// keeps the bare content-addressed blob, and a named copy carries the original
// name and a matching extension (what a site's file chooser filters on).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, utimesSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';

const dataDir = makeTempDirSync('named-attachment-file');
process.env.MIXDOG_DATA_DIR = dataDir;

const { attachmentsForIntake, collectPromptAttachments, materializePromptSubmission, namedAttachmentFile } =
  await import('./store.mjs');
const { attachmentFileName } = await import('./attachment-file-name.mjs');
const { attachedFilesNote, mediaPartToReference } = await import('./attachment-reference.mjs');
const require_transcript_metadata = await import('../shared/transcript-metadata.mjs');
const { restoredUserText } = await import('../agent/orchestrator/session/transcript-restore/user-text.mjs');

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

function phoneSend() {
  const intake = materializePromptSubmission(
    [
      { type: 'text', text: 'see [Pasted text #1 +3 lines]' },
      { type: 'image', data: JPEG.toString('base64'), mimeType: 'image/jpeg' },
      { type: 'file', data: Buffer.from('%PDF-1.7\nbody').toString('base64'), mimeType: 'application/pdf' },
    ],
    {
      pastedImages: {
        2: {
          id: 2,
          type: 'image',
          mediaType: 'image/jpeg',
          filename: 'KakaoTalk_20261103_195007703.jpg',
          content: JPEG.toString('base64'),
        },
      },
      pastedTexts: { 1: { id: 1, text: 'pasted '.repeat(200), source: 'paste', filename: 'Pasted text #1' } },
    }
  );
  return { intake, attachments: attachmentsForIntake(intake.prompt, intake.options) };
}

test('an attached image is copied under its original name; the blob stays content-addressed', () => {
  const { intake, attachments } = phoneSend();
  const note = attachedFilesNote(intake.prompt, intake.options, attachments);
  const [photo] = note.attachmentReference.files.filter((file) => file.mimeType === 'image/jpeg');
  assert.equal(basename(photo.path), 'KakaoTalk_20261103_195007703.jpg');
  assert.deepEqual(readFileSync(photo.path), JPEG);
  assert.ok(note.text.includes(photo.path));
  const blob = join(dataDir, 'prompt-attachments', 'sha256', photo.attachmentRef.slice(0, 2), photo.attachmentRef);
  assert.deepEqual(readFileSync(blob), JPEG);
  // Sending the same photo again reuses the copy.
  assert.equal(
    namedAttachmentFile(photo.attachmentRef, { filename: photo.name, mimeType: photo.mimeType }),
    photo.path
  );
});

test('a document without a name still gets a typed file, and a paste is not listed as a file', () => {
  const { intake, attachments } = phoneSend();
  const note = attachedFilesNote(intake.prompt, intake.options, attachments);
  const names = note.attachmentReference.files.map((file) => basename(file.path)).sort();
  assert.deepEqual(names, ['KakaoTalk_20261103_195007703.jpg', 'attachment.pdf']);
  assert.equal(attachedFilesNote('plain', {}, []), null);
});

test('the note is model-facing only: the restored bubble does not show it', () => {
  const { intake, attachments } = phoneSend();
  const note = attachedFilesNote(intake.prompt, intake.options, attachments);
  assert.equal(restoredUserText([...intake.prompt, note]), restoredUserText(intake.prompt));
});

test('a by-reference image names the same copy the note gave, not the bare blob', () => {
  const { intake, attachments } = phoneSend();
  const note = attachedFilesNote(intake.prompt, intake.options, attachments);
  const photo = note.attachmentReference.files.find((file) => file.mimeType === 'image/jpeg');
  const imagePart = intake.prompt.find((part) => part.type === 'image');
  const reference = mediaPartToReference(imagePart);
  assert.ok(reference.text.includes(photo.path));
  assert.equal(reference.attachmentReference.attachmentRef, photo.attachmentRef);
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

test('the PC file is the original picked bytes in their own format; the model keeps the resized blob', async () => {
  const { stageOriginal } = await import('../../tui/session/session-api/media.mjs');
  const originalRef = await stageOriginal(ORIGINAL.toString('base64'));
  const { intake, attachments } = resizedSend(originalRef);
  const note = attachedFilesNote(intake.prompt, intake.options, attachments);
  const [file] = note.attachmentReference.files;
  assert.equal(basename(file.path), 'IMG_0042.heic');
  assert.deepEqual(readFileSync(file.path), ORIGINAL);
  assert.deepEqual(
    readFileSync(namedBlob(file.attachmentRef)),
    JPEG,
    'the content-addressed blob stays the resized image'
  );
  // The census keeps the original blob through the message record that names it.
  assert.equal(attachments[0].original.attachmentRef, originalRef);
  // A later note with no original given never touches the original's file.
  const other = namedAttachmentFile(file.attachmentRef, { filename: 'IMG_0042.heic', mimeType: 'image/webp' });
  assert.notEqual(other, file.path);
  assert.deepEqual(readFileSync(file.path), ORIGINAL);
});

test('two originals that resize to the same bytes and share a name keep separate files', async () => {
  const { stageOriginal } = await import('../../tui/session/session-api/media.mjs');
  const first = Buffer.concat([ORIGINAL, Buffer.from('exif A')]);
  const second = Buffer.concat([ORIGINAL, Buffer.from('exif B')]);
  const paths = [];
  for (const bytes of [first, second]) {
    const { intake, attachments } = resizedSend(await stageOriginal(bytes.toString('base64')));
    const note = attachedFilesNote(intake.prompt, intake.options, attachments);
    paths.push(note.attachmentReference.files[0].path);
  }
  assert.notEqual(paths[0], paths[1]);
  assert.equal(basename(paths[0]), basename(paths[1]));
  assert.deepEqual(readFileSync(paths[0]), first);
  assert.deepEqual(readFileSync(paths[1]), second);
});

test('a message record keeps the picked file referenced', () => {
  const { normalizeMessageAttachments } = require_transcript_metadata;
  const ref = 'c'.repeat(64);
  const [kept] = normalizeMessageAttachments([
    { id: 'd'.repeat(64), name: 'a.jpg', original: { attachmentRef: ref, mimeType: 'image/heic' } },
  ]);
  assert.deepEqual(kept.original, { attachmentRef: ref, mimeType: 'image/heic' });
  assert.equal(
    'original' in normalizeMessageAttachments([{ id: 'd'.repeat(64), original: { attachmentRef: 'x' } }])[0],
    false
  );
});

test('staged originals are bounded: quota with oldest-first eviction, retention, claims', async () => {
  const { stageOriginalAttachment, claimStagedOriginals } = await import('./staged-originals.mjs');
  const { attachmentFilePath } = await import('./store.mjs');
  const blob = (n) => Buffer.alloc(100, n);
  const opts = { maxBytes: 250, ttlMs: 1000 };
  const a = (await stageOriginalAttachment(blob(1), { ...opts, now: 1 })).attachmentRef;
  const b = (await stageOriginalAttachment(blob(2), { ...opts, now: 2 })).attachmentRef;
  // The third does not fit beside both: the oldest is evicted, from disk too.
  const c = (await stageOriginalAttachment(blob(3), { ...opts, now: 3 })).attachmentRef;
  assert.equal(existsSync(attachmentFilePath(a)), false);
  assert.equal(existsSync(attachmentFilePath(b)), true);
  assert.equal(existsSync(attachmentFilePath(c)), true);
  // One bigger than the whole quota fails cleanly.
  await assert.rejects(stageOriginalAttachment(Buffer.alloc(300, 9), { ...opts, now: 4 }), /quota/);
  // A claimed original is no longer staged: later pressure cannot evict it.
  await claimStagedOriginals([b]);
  const d = (await stageOriginalAttachment(blob(4), { ...opts, now: 5 })).attachmentRef;
  await stageOriginalAttachment(blob(5), { ...opts, now: 6 });
  assert.equal(existsSync(attachmentFilePath(b)), true, 'claimed');
  assert.equal(existsSync(attachmentFilePath(c)), false, 'oldest unclaimed evicted');
  // Unclaimed ones expire after the retention.
  await stageOriginalAttachment(blob(6), { ...opts, now: 5000 });
  assert.equal(existsSync(attachmentFilePath(d)), false, 'expired');
  // Bytes a message already stores are not the stager's to evict.
  const stored = materializePromptSubmission([
    { type: 'file', data: blob(7).toString('base64'), mimeType: 'text/plain' },
  ]).prompt[0].attachmentRef;
  await stageOriginalAttachment(blob(7), { ...opts, now: 6000 });
  await stageOriginalAttachment(blob(8), { ...opts, now: 20000 });
  await stageOriginalAttachment(blob(9), { ...opts, now: 20001 });
  await stageOriginalAttachment(blob(10), { ...opts, now: 20002 });
  assert.equal(existsSync(attachmentFilePath(stored)), true);
});

test('a missing original falls back to the resized copy under the same name', () => {
  const { intake, attachments } = resizedSend('f'.repeat(64));
  const note = attachedFilesNote(intake.prompt, intake.options, attachments);
  const [file] = note.attachmentReference.files;
  assert.equal(basename(file.path), 'IMG_0042.heic.jpg');
  assert.deepEqual(readFileSync(file.path), JPEG);
});

function namedBlob(ref) {
  return join(dataDir, 'prompt-attachments', 'sha256', ref.slice(0, 2), ref);
}

test('concurrent stagers in separate processes neither exceed the cap nor lose entries', async () => {
  const { spawn } = await import('node:child_process');
  const { readdirSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const dir = makeTempDirSync('staged-concurrent');
  const moduleUrl = pathToFileURL(join(import.meta.dirname, 'staged-originals.mjs')).href;
  const script = `
    const { stageOriginalAttachment } = await import(${JSON.stringify(moduleUrl)});
    const seed = Number(process.argv[1]);
    for (let i = 0; i < 8; i++) {
      await stageOriginalAttachment(Buffer.alloc(100, seed * 20 + i + 1), { maxBytes: 450, ttlMs: 3_600_000 });
    }`;
  await Promise.all(
    [1, 2, 3].map(
      (seed) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', script, String(seed)], {
            env: { ...process.env, MIXDOG_DATA_DIR: dir },
            stdio: ['ignore', 'ignore', 'inherit'],
          });
          child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`stager exited ${code}`))));
        })
    )
  );
  const root = join(dir, 'prompt-attachments');
  const index = JSON.parse(readFileSync(join(root, 'staged-originals.json'), 'utf8'));
  const blobs = readdirSync(join(root, 'sha256')).flatMap((prefix) => readdirSync(join(root, 'sha256', prefix)));
  assert.ok(index.reduce((sum, entry) => sum + entry.size, 0) <= 450, 'cap held');
  // No entry lost and none orphaned: the index and the disk list the same blobs.
  assert.deepEqual(blobs.sort(), index.map((entry) => entry.ref).sort());
  assert.ok(index.length >= 1);
});

test('a claim is never undone by a later eviction, and a lost original leaves the resized copy', async () => {
  const { stageOriginalAttachment, claimStagedOriginals } = await import('./staged-originals.mjs');
  const { attachmentFilePath } = await import('./store.mjs');
  const opts = { maxBytes: 250 };
  const a = (await stageOriginalAttachment(Buffer.alloc(100, 31), { ...opts, now: 1 })).attachmentRef;
  const b = (await stageOriginalAttachment(Buffer.alloc(100, 32), { ...opts, now: 2 })).attachmentRef;
  assert.deepEqual([...(await claimStagedOriginals([a]))], [a]);
  await stageOriginalAttachment(Buffer.alloc(100, 33), { ...opts, now: 3 });
  await stageOriginalAttachment(Buffer.alloc(100, 34), { ...opts, now: 4 });
  assert.equal(existsSync(attachmentFilePath(a)), true, 'claimed blob survives the evictions');
  assert.equal(existsSync(attachmentFilePath(b)), false);
  // Claiming one that was evicted claims nothing: the message drops its record.
  assert.equal((await claimStagedOriginals([b])).size, 0);
});

test('a contended staging lock never blocks the event loop: staging waits asynchronously, a claim gives up at once', async () => {
  const { stageOriginalAttachment, claimStagedOriginals } = await import('./staged-originals.mjs');
  const { holdStagedLock } = await import('./staged-lock-test-support.mjs');
  const holder = await holdStagedLock(dataDir, 1500);
  try {
    // A zero-delay timer set before the call fires while staging waits.
    const started = Date.now();
    let timerAt = null;
    setTimeout(() => {
      timerAt = Date.now() - started;
    }, 0);
    await assert.rejects(stageOriginalAttachment(Buffer.alloc(10, 41), { lockTimeoutMs: 400 }));
    assert.ok(timerAt !== null && timerAt < 150, `timer ran after ${timerAt} ms`);
    // The send path's claim is one synchronous try: nothing claimed, no wait.
    const claimStarted = Date.now();
    assert.equal(claimStagedOriginals(['e'.repeat(64)]).size, 0);
    assert.ok(Date.now() - claimStarted < 150, 'the claim does not wait');
  } finally {
    await holder.release();
  }
});
test('a crash between recording and publishing is reconciled by the next transaction', async () => {
  const { stageOriginalAttachment, pruneStagedOriginals } = await import('./staged-originals.mjs');
  const { attachmentFilePath } = await import('./store.mjs');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const root = join(dataDir, 'prompt-attachments');
  mkdirSync(root, { recursive: true });
  // The state a crash leaves after the entry was recorded but before the blob
  // was published: two intents with no blob, taking all the accounted room.
  const phantom = (ch) => ({ ref: ch.repeat(64), size: 120, at: Date.now() });
  writeFileSync(join(root, 'staged-originals.json'), JSON.stringify([phantom('1'), phantom('2')]));
  assert.deepEqual(await pruneStagedOriginals(), [], 'entries without a blob are dropped');
  writeFileSync(join(root, 'staged-originals.json'), JSON.stringify([phantom('3'), phantom('4')]));
  // Staging fits again at once: nothing real was evicted, nothing phantom counts.
  const real = (await stageOriginalAttachment(Buffer.alloc(200, 51), { maxBytes: 250 })).attachmentRef;
  assert.equal(existsSync(attachmentFilePath(real)), true);
  const index = JSON.parse(readFileSync(join(root, 'staged-originals.json'), 'utf8'));
  assert.deepEqual(
    index.map((entry) => entry.ref),
    [real]
  );
  // And the crash after publishing (recorded, then the process died) simply
  // leaves a tracked entry: it expires like any other.
  await pruneStagedOriginals({ now: Date.now() + 3 * 3_600_000 });
  assert.equal(existsSync(attachmentFilePath(real)), false);
});

test('the census sweeps a named copy together with its unreferenced blob', async () => {
  const { attachments } = phoneSend();
  const photo = attachments.find((entry) => entry.kind === 'image');
  const copy = namedAttachmentFile(photo.attachmentRef, { filename: photo.name, mimeType: photo.mimeType });
  const blob = join(dataDir, 'prompt-attachments', 'sha256', photo.attachmentRef.slice(0, 2), photo.attachmentRef);
  const old = new Date(Date.now() - 120_000);
  utimesSync(blob, old, old);
  await collectPromptAttachments({ now: Date.now(), minAgeMs: 60_000 });
  assert.equal(existsSync(blob), false);
  assert.equal(existsSync(copy), false);
  assert.equal(existsSync(dirname(copy)), false);
});
