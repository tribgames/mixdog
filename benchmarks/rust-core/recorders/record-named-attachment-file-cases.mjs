#!/usr/bin/env node
// Recording of runtime/attachments/named-attachment-file.test.mjs (b6f10295a), the eight cases whose behaviour stays in the product:
// the files a submission names on the PC (the copy under the file's own name), the model-facing note that lists them, the by-reference
// image part, the originals kept behind a resized copy, and the message record that keeps the picked file referenced. Node's own
// intake, note builder and store run unchanged over a fresh data directory; every blob the store then holds is recorded with its bytes
// (base64) so a replay plants the same store.
//
//   node benchmarks/rust-core/recorders/record-named-attachment-file-cases.mjs --tree <export of b6f10295a with node_modules>
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { openSet } from './lib/case-set.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'named-attachment-file-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const set = openSet('named-attachment-file-cases', import.meta.url);
const { attachmentsForIntake, materializePromptSubmission, namedAttachmentFile } = await set.load('src/runtime/attachments/store.mjs');
const { attachedFilesNote, mediaPartToReference } = await set.load('src/runtime/attachments/attachment-reference.mjs');
const { normalizeMessageAttachments } = await set.load('src/runtime/shared/transcript-metadata.mjs');
const { restoredUserText } = await set.load('src/runtime/agent/orchestrator/session/transcript-restore/user-text.mjs');
const { stageOriginal } = await set.load('src/tui/session/session-api/media.mjs');

const JPEG = Buffer.from('\xff\xd8\xff\xe0 photo of a lease', 'latin1');
const ORIGINAL = Buffer.concat([JPEG, Buffer.from(' full-resolution original '.repeat(40))]);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

const phoneInput = {
  parts: [
    { type: 'text', text: 'see [Pasted text #1 +3 lines]' },
    { type: 'image', data: b64(JPEG), mimeType: 'image/jpeg' },
    { type: 'file', data: b64('%PDF-1.7\nbody'), mimeType: 'application/pdf' },
  ],
  side: {
    pastedImages: { 2: { id: 2, type: 'image', mediaType: 'image/jpeg', filename: 'KakaoTalk_20261103_195007703.jpg', content: b64(JPEG) } },
    pastedTexts: { 1: { id: 1, text: 'pasted '.repeat(200), source: 'paste', filename: 'Pasted text #1' } },
  },
};
const resizedInput = (originalRef) => ({
  parts: [{ type: 'text', text: 'look' }, { type: 'image', data: b64(JPEG), mimeType: 'image/jpeg' }],
  side: { pastedImages: { 2: { id: 2, type: 'image', mediaType: 'image/webp', filename: 'IMG_0042.heic', ...(originalRef ? { originalRef, originalMediaType: 'image/heic' } : {}) } } },
});
const send = (input) => {
  const intake = materializePromptSubmission(JSON.parse(JSON.stringify(input.parts)), JSON.parse(JSON.stringify(input.side)));
  return { intake, attachments: attachmentsForIntake(intake.prompt, intake.options) };
};
const blobPath = (ref) => join(dataDir, 'prompt-attachments', 'sha256', ref.slice(0, 2), ref);
/** Every blob the store holds: the bytes a replay plants. */
const blobs = () => {
  const root = join(dataDir, 'prompt-attachments', 'sha256');
  if (!existsSync(root)) return {};
  return Object.fromEntries(readdirSync(root).flatMap((dir) => readdirSync(join(root, dir)).filter((name) => /^[0-9a-f]{64}$/.test(name)).map((name) => [name, readFileSync(join(root, dir, name)).toString('base64')])));
};
const fileOf = (file) => ({ ...file, base64: b64(readFileSync(file.path)), basename: basename(file.path) });

await set.run('an attached image is copied under its original name; the blob stays content-addressed', () => {
  const { intake, attachments } = send(phoneInput);
  const note = attachedFilesNote(intake.prompt, intake.options, attachments);
  const [photo] = note.attachmentReference.files.filter((file) => file.mimeType === 'image/jpeg');
  const reused = namedAttachmentFile(photo.attachmentRef, { filename: photo.name, mimeType: photo.mimeType });
  return {
    input: phoneInput, attachments, note, photo: fileOf(photo), blobBase64: readFileSync(blobPath(photo.attachmentRef)).toString('base64'),
    noteNamesPath: note.text.includes(photo.path), reusedPath: reused, reusedIsThePath: reused === photo.path, blobs: blobs(),
  };
});
await set.run('a document without a name still gets a typed file, and a paste is not listed as a file', () => {
  const { intake, attachments } = send(phoneInput);
  const note = attachedFilesNote(intake.prompt, intake.options, attachments);
  return { input: phoneInput, attachments, note, names: note.attachmentReference.files.map((file) => basename(file.path)).sort(), plain: attachedFilesNote('plain', {}, []), blobs: blobs() };
});
await set.run('the note is model-facing only: the restored bubble does not show it', () => {
  const { intake, attachments } = send(phoneInput);
  const note = attachedFilesNote(intake.prompt, intake.options, attachments);
  return { prompt: intake.prompt, note, withNote: restoredUserText([...intake.prompt, note]), without: restoredUserText(intake.prompt), blobs: blobs() };
});
await set.run('a by-reference image names the same copy the note gave, not the bare blob', () => {
  const { intake, attachments } = send(phoneInput);
  const note = attachedFilesNote(intake.prompt, intake.options, attachments);
  const photo = note.attachmentReference.files.find((file) => file.mimeType === 'image/jpeg');
  const imagePart = intake.prompt.find((part) => part.type === 'image');
  const reference = mediaPartToReference(imagePart);
  return { input: phoneInput, prompt: intake.prompt, attachments, note, imagePart, reference, photoPath: photo.path, referenceNamesPath: reference.text.includes(photo.path), sameRef: reference.attachmentReference.attachmentRef === photo.attachmentRef, blobs: blobs() };
});
await set.run('the PC file is the original picked bytes in their own format; the model keeps the resized blob', async () => {
  const originalRef = await stageOriginal(b64(ORIGINAL));
  const input = resizedInput(originalRef);
  const { intake, attachments } = send(input);
  const note = attachedFilesNote(intake.prompt, intake.options, attachments);
  const [file] = note.attachmentReference.files;
  const blobBytes = readFileSync(blobPath(file.attachmentRef)).toString('base64');
  const other = namedAttachmentFile(file.attachmentRef, { filename: 'IMG_0042.heic', mimeType: 'image/webp' });
  return { originalBase64: b64(ORIGINAL), originalRef, input, attachments, note, file: fileOf(file), blobBase64: blobBytes, originalKept: attachments[0].original.attachmentRef === originalRef, other, otherIsFile: other === file.path, fileAfter: b64(readFileSync(file.path)), blobs: blobs() };
});
await set.run('two originals that resize to the same bytes and share a name keep separate files', async () => {
  const originals = [Buffer.concat([ORIGINAL, Buffer.from('exif A')]), Buffer.concat([ORIGINAL, Buffer.from('exif B')])];
  const sends = [];
  for (const bytes of originals) {
    const originalRef = await stageOriginal(b64(bytes));
    const input = resizedInput(originalRef);
    const { intake, attachments } = send(input);
    const note = attachedFilesNote(intake.prompt, intake.options, attachments);
    sends.push({ originalBase64: b64(bytes), originalRef, input, attachments, note, file: fileOf(note.attachmentReference.files[0]) });
  }
  return { sends, differentPaths: sends[0].file.path !== sends[1].file.path, sameName: sends[0].file.basename === sends[1].file.basename, blobs: blobs() };
});
await set.run('a message record keeps the picked file referenced', () => {
  const ref = 'c'.repeat(64);
  const offered = [{ id: 'd'.repeat(64), name: 'a.jpg', original: { attachmentRef: ref, mimeType: 'image/heic' } }];
  const refused = [{ id: 'd'.repeat(64), original: { attachmentRef: 'x' } }];
  const [kept] = normalizeMessageAttachments(offered);
  const [bare] = normalizeMessageAttachments(refused);
  return { offered, kept, refused, bare, bareHasOriginal: 'original' in bare };
});
await set.run('a missing original falls back to the resized copy under the same name', () => {
  const input = resizedInput('f'.repeat(64));
  const { intake, attachments } = send(input);
  const note = attachedFilesNote(intake.prompt, intake.options, attachments);
  const [file] = note.attachmentReference.files;
  return { input, attachments, note, file: fileOf(file), blobs: blobs() };
});

try {
  await set.finish({
    entry: { runs: 'attachments/store.mjs materializePromptSubmission, attachmentsForIntake, namedAttachmentFile; attachment-reference.mjs attachedFilesNote, mediaPartToReference; transcript-restore/user-text.mjs restoredUserText; shared/transcript-metadata.mjs normalizeMessageAttachments; tui/session/session-api/media.mjs stageOriginal', notRun: 'the other seven tests of the Node file (file names, staging bounds, concurrent stagers, lock, crash, census) are closed by other sets' },
    replay: { entry: 'plant every recorded blob in a fresh store, build the attachment records the intake recorded, run attached_files_note and reference_part_with over StoreFiles, compare the note text, the files object, the copy names and bytes', normalised: {} },
    replaceInText: [[dataDir, '<data>']],
    exclusions: { restoredUserText: 'the restored bubble text is replayed through the stored-message restore row (transcript_rows::restore)', intake: 'materializePromptSubmission is not replayed: its output (attachment records, parts) is the recorded input of the core calls' },
  });
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(0);
