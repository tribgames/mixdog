// The script of the phone's attachment and local-file calls (list 1 unit D: `attachmentOpen`, `readAttachmentThumbnail`,
// `resolveLocalPaths`, `readLocalFile`, `projectRecovery`). One script drives the Node recording (record-phone-attachments.mjs:
// Node's relay methods over b6f10295a's own host code) and the replay of the phone's router and adapters against a built mixdogd;
// both play it with `play`, so the two traces are made of the same steps.
//
// The world is the same folder on both sides: a registered project, files outside it, the PC's temp folder (where an opened
// attachment is staged), the attachment store (`<data>/prompt-attachments/sha256/<2>/<ref>`, one layout for Node and the core), one
// stored conversation whose user row names attachments (written by Node's session store; the core converts the same files at its
// start) and two interrupted workspace-edit recovery records (written by the product's own `beginProjectRecovery`, then published as
// a crashed edit leaves them).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export const ROOT = 'D:\\mixdog-build\\tmp\\ph-attachments';
/** The modification time every file of the world starts with. */
const EPOCH_MS = Date.UTC(2026, 0, 2, 3, 4, 5);
/** Node's `Date.now()` while a call runs and while the recovery records are written (their `createdAt`). */
export const FIXED_NOW_MS = Date.UTC(2026, 5, 7, 8, 9, 10);
export const SESSION_ID = 'sess_phone_attach';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([1, 0, 1, 0, 0, 0, 0, 0x3b])]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([12, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(4)]);
const PDF = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'latin1');
const NOTES = Buffer.from('# Notes\n\nOpened from the phone.\n');
/** A PNG signature padded to `size` bytes: an image by its bytes, of an exact size. */
const pngOfSize = (size, fill) => Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(size - 8, fill)]);
/** `REMOTE_ORIGINAL_MAX_BYTES` (attachment-thumbnail.ts): a thumbnail of at most this many bytes is handed over whole. */
const THUMBNAIL_MAX = 2 * 1024 * 1024;

/** Every blob of the attachment store, by name. `gone` is named by the conversation but not stored. */
export const BLOBS = {
  png: PNG,
  jpeg: JPEG,
  gif: GIF,
  webp: WEBP,
  pdf: PDF,
  notes: NOTES,
  stray: Buffer.from('stored, but no message names it\n'),
  limit: pngOfSize(THUMBNAIL_MAX, 1),
  over: pngOfSize(THUMBNAIL_MAX + 1, 2),
};
export const REFS = Object.fromEntries(Object.entries(BLOBS).map(([name, bytes]) => [name, sha256(bytes)]));
REFS.gone = sha256(Buffer.from('never stored'));
const STORED = Object.keys(BLOBS);

/** The conversation's messages: the user row's attachment records (`meta.transcript.attachments`, transcript-metadata.mjs), each
 *  id its content hash. Every stored blob is named, so neither store's sweep removes one; `stray` is named by another conversation. */
export function conversation() {
  const record = (name, kind, label, mimeType) => ({ id: REFS[name], attachmentRef: REFS[name], kind, name: label, mimeType, size: BLOBS[name]?.length ?? 12 });
  return {
    [SESSION_ID]: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'look at these' }],
        meta: {
          transcript: {
            attachments: [
              record('pdf', 'file', 'report', 'application/pdf'),
              record('notes', 'file', 'notes.md', 'text/markdown'),
              record('png', 'image', 'shot.png', 'image/png'),
              record('jpeg', 'image', 'photo.jpg', 'image/jpeg'),
              record('gif', 'image', 'anim.gif', 'image/gif'),
              record('webp', 'image', 'pic.webp', 'image/webp'),
              record('limit', 'image', 'limit.png', 'image/png'),
              record('over', 'image', 'over.png', 'image/png'),
              { id: REFS.gone, attachmentRef: REFS.gone, kind: 'file', name: 'gone.txt', mimeType: 'text/plain', size: 12 },
            ],
          },
        },
      },
      { role: 'assistant', content: 'got them' },
    ],
    sess_phone_other: [
      { role: 'user', content: [{ type: 'text', text: 'another' }], meta: { transcript: { attachments: [record('stray', 'file', 'stray.txt', 'text/plain')] } } },
      { role: 'assistant', content: 'ok' },
    ],
  };
}

export function attachmentsWorld(root = ROOT) {
  const project = join(root, 'proj');
  const outside = join(root, 'outside');
  const files = {
    [join(project, 'a.txt')]: Buffer.from('in the project\n'),
    [join(project, 'sub', 'deep.txt')]: Buffer.from('deep\n'),
    [join(project, 'edited.txt')]: Buffer.from('after the interrupted edit\n'),
    [join(project, 'dropped.txt')]: Buffer.from('dropped after edit\n'),
    [join(outside, 'note.txt')]: Buffer.from('a note outside every project\n'),
    [join(outside, 'photo.png')]: PNG,
    [join(outside, 'data.json')]: Buffer.from('{"a":1}\n'),
    [join(outside, 'noext')]: Buffer.from('no extension\n'),
    [join(outside, 'large.bin')]: Buffer.alloc(1024 * 1024 + 3, 0x61),
    [join(outside, 'limit.bin')]: Buffer.alloc(20 * 1024 * 1024, 0x62),
    [join(outside, 'huge.bin')]: Buffer.alloc(20 * 1024 * 1024 + 1, 0x63),
  };
  return {
    root,
    project,
    outside,
    userData: join(root, 'userdata'),
    data: join(root, 'data'),
    temp: join(root, 'temp'),
    /** Makes the folder anew; every file gets the same modification time. The attachment store is written into `dataDir`. */
    build(dataDir) {
      rmSync(root, { recursive: true, force: true });
      for (const dir of [this.userData, this.temp, join(outside, 'folder')]) mkdirSync(dir, { recursive: true });
      for (const [path, data] of Object.entries(files)) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, data);
        utimesSync(path, EPOCH_MS / 1000, EPOCH_MS / 1000);
      }
      for (const name of STORED) {
        const file = join(dataDir, 'prompt-attachments', 'sha256', REFS[name].slice(0, 2), REFS[name]);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, BLOBS[name]);
      }
    },
  };
}

/** The recovery records an interrupted workspace edit leaves (project-files.ts writes them through `beginProjectRecovery` before its
 *  first byte and publishes them with `releaseRecoveryDirectory`; a crash in between leaves them, named by their id alone). Written by
 *  the product's own store module into `userData/editor-recovery/<digest of the root>/`, on the virtual clock. Returns their ids. */
export async function seedRecovery(store, userData, root) {
  const real = Date.now;
  try {
    const ids = [];
    for (const [rel, before, after] of [
      ['edited.txt', 'before the interrupted edit\n', 'after the interrupted edit\n'],
      ['dropped.txt', 'dropped before edit\n', 'dropped after edit\n'],
    ]) {
      const destination = realpathSync(join(root, rel));
      // A second apart, newest first in a listing: records of one instant are listed by their random ids.
      Date.now = () => FIXED_NOW_MS + ids.length * 1000;
      const prepared = [{ relPath: rel, destination, parent: store.recoveryIdentity(dirname(destination)), mode: statSync(destination).mode, before: Buffer.from(before), after: Buffer.from(after) }];
      const { id, directory } = await store.beginProjectRecovery(userData, root, prepared);
      await store.releaseRecoveryDirectory(directory);
      ids.push(id);
    }
    return ids;
  } finally {
    Date.now = real;
  }
}

/** A recovery store's records, as the user can tell them apart: each entry's name with the record ids as `$record<n>`, and the size and
 *  hash of each payload (`<n>.before`/`<n>.after`). `manifest.json` and `state.json` are named only: they hold the record's id and the
 *  file identities of the world they were written in, which differ between any two worlds. */
export function recoveryStoreOf(dir, ids) {
  if (!existsSync(dir)) return [];
  const named = (name) => ids.reduce((text, id, index) => text.replaceAll(id, `$record${index}`), name);
  const rows = [];
  for (const record of readdirSync(dir).sort()) {
    const path = join(dir, record);
    if (!statSync(path).isDirectory()) {
      rows.push({ entry: named(record) });
      continue;
    }
    for (const file of readdirSync(path).sort()) {
      const bytes = readFileSync(join(path, file));
      rows.push(/^\d+\.(before|after)$/.test(file) ? { entry: `${named(record)}/${file}`, size: bytes.length, sha256: sha256(bytes) } : { entry: `${named(record)}/${file}` });
    }
  }
  return rows.sort((a, b) => (a.entry < b.entry ? -1 : 1));
}

const call = (name, params, as) => ({ op: 'call', name, params, ...(as ? { as } : {}) });
/** The value an earlier call answered (`as`), at `path`. */
const answer = (as, ...path) => ({ $answer: as, path });

export function attachmentsScript(world = attachmentsWorld()) {
  const { project: P, outside: O, root } = world;
  const many = Array.from({ length: 101 }, (_, index) => join(O, `n${index}.txt`));
  return {
    world,
    ops: [
      call('addProject', [P]),
      // ── resolveLocalPaths: a project file, a file outside every project (a one-file grant), a folder ──
      call('resolveLocalPaths', [[join(P, 'a.txt')]]),
      call('resolveLocalPaths', [[join(O, 'note.txt')]], 'note'),
      call('resolveLocalPaths', [[join(P, 'sub')]]),
      call('resolveLocalPaths', [[join(O, 'note.txt'), join(P, 'a.txt'), join(O, 'photo.png'), join(P, 'sub', 'deep.txt'), join(O, 'folder'), `${join(P, 'sub')}\\..\\a.txt`]]),
      // The same file again keeps its grant; the conversation the page names (its second argument) narrows nothing.
      call('resolveLocalPaths', [[join(O, 'note.txt')]]),
      call('resolveLocalPaths', [[join(O, 'note.txt')], SESSION_ID]),
      // The grant opens that file and no other through the file calls.
      call('readProjectFile', [answer('note', 0, 'projectPath'), answer('note', 0, 'relPath'), answer('note', 0, 'accessToken')]),
      call('readProjectFile', [answer('note', 0, 'projectPath'), 'photo.png', answer('note', 0, 'accessToken')]),
      call('statProjectFile', [answer('note', 0, 'projectPath'), answer('note', 0, 'relPath'), answer('note', 0, 'accessToken')]),
      call('resolveLocalPaths', [[join(O, 'missing.txt')]]),
      call('resolveLocalPaths', [[join(O, 'note.txt'), 'relative.txt']]),
      call('resolveLocalPaths', [[]]),
      call('resolveLocalPaths', [many]),
      call('resolveLocalPaths', [join(O, 'note.txt')]),
      call('resolveLocalPaths', [['relative.txt']]),
      call('resolveLocalPaths', [[5]]),
      call('resolveLocalPaths', [['   ']]),
      call('resolveLocalPaths', [[`${root}\\a\u0000b`]]),
      // ── readLocalFile ──
      call('readLocalFile', [join(O, 'note.txt')]),
      call('readLocalFile', [join(O, 'photo.png')]),
      call('readLocalFile', [join(O, 'data.json')]),
      call('readLocalFile', [join(O, 'noext')]),
      call('readLocalFile', [` ${join(P, 'a.txt')} `]),
      call('readLocalFile', [join(O, 'large.bin')]),
      call('readLocalFile', [join(O, 'limit.bin')]),
      call('readLocalFile', [join(O, 'huge.bin')]),
      call('readLocalFile', [join(O, 'folder')]),
      call('readLocalFile', [join(O, 'missing.txt')]),
      call('readLocalFile', ['relative.txt']),
      call('readLocalFile', [7]),
      call('readLocalFile', ['']),
      // ── readAttachmentThumbnail: an image's own bytes up to 2 MiB, anything else null ──
      call('readAttachmentThumbnail', [REFS.png]),
      call('readAttachmentThumbnail', [REFS.jpeg]),
      call('readAttachmentThumbnail', [REFS.gif]),
      call('readAttachmentThumbnail', [REFS.webp]),
      call('readAttachmentThumbnail', [REFS.limit]),
      call('readAttachmentThumbnail', [REFS.over]),
      call('readAttachmentThumbnail', [REFS.pdf]),
      call('readAttachmentThumbnail', [REFS.gone]),
      call('readAttachmentThumbnail', [REFS.png.toUpperCase()]),
      call('readAttachmentThumbnail', ['not-a-ref']),
      call('readAttachmentThumbnail', [null]),
      // ── attachmentOpen: staged as a named temp file, opened through a one-file grant of that conversation ──
      call('attachmentOpen', [SESSION_ID, REFS.pdf]),
      call('attachmentOpen', [SESSION_ID, REFS.notes], 'notes'),
      call('readProjectFile', [answer('notes', 'projectPath'), answer('notes', 'relPath'), answer('notes', 'accessToken')]),
      call('attachmentOpen', [SESSION_ID, REFS.png], 'png'),
      call('previewProjectFileRange', [answer('png', 'projectPath'), answer('png', 'relPath'), answer('png', 'accessToken'), 0, 64]),
      // Opened again: staged again, under the same grant.
      call('attachmentOpen', [SESSION_ID, REFS.notes]),
      call('attachmentOpen', [SESSION_ID, REFS.gone]),
      call('attachmentOpen', [SESSION_ID, REFS.stray]),
      call('attachmentOpen', ['sess_phone_other', REFS.stray]),
      call('attachmentOpen', ['sess_phone_unknown', REFS.pdf]),
      call('attachmentOpen', [SESSION_ID, 'a1']),
      call('attachmentOpen', [SESSION_ID, REFS.pdf.toUpperCase()]),
      call('attachmentOpen', [SESSION_ID, null]),
      call('attachmentOpen', ['bad id!', REFS.pdf]),
      call('attachmentOpen', [5, REFS.pdf]),
      // ── projectRecovery: the records of an interrupted edit, inspected, restored and discarded ──
      call('projectRecovery', [P, { action: 'list' }]),
      call('projectRecovery', [P, { action: 'inspect', id: { $record: 0 } }], 'r0'),
      call('projectRecovery', [P, { action: 'inspect', id: { $record: 1 } }], 'r1'),
      // A revision of another record is not this one's.
      call('projectRecovery', [P, { action: 'restore', id: { $record: 0 }, revision: answer('r1', 'detail', 'revision') }]),
      call('projectRecovery', [P, { action: 'restore', id: { $record: 0 }, revision: answer('r0', 'detail', 'revision') }]),
      call('readProjectFile', [P, 'edited.txt', null]),
      call('projectRecovery', [P, { action: 'list' }]),
      call('projectRecovery', [P, { action: 'discard', id: { $record: 1 }, revision: answer('r1', 'detail', 'revision') }]),
      call('readProjectFile', [P, 'dropped.txt', null]),
      call('projectRecovery', [P, { action: 'list' }]),
      call('projectRecovery', [P, { action: 'inspect', id: { $record: 1 } }]),
      call('projectRecovery', [P, { action: 'inspect', id: '00000000-0000-4000-8000-000000000000' }]),
      call('projectRecovery', [join(root, 'unregistered'), { action: 'list' }]),
      call('projectRecovery', [P, { action: 'inspect', id: 'not-an-id' }]),
      call('projectRecovery', [P, { action: 'restore', id: { $record: 0 }, revision: 'stale' }]),
      call('projectRecovery', [P, { action: 'rewind' }]),
      call('projectRecovery', [P, null]),
      call('projectRecovery', [7, { action: 'list' }]),
    ],
  };
}

/** The file calls of the script whose answer carries the file's `mtimeMs`; their first two params name the file. */
const FILE_CALLS = new Set(['readProjectFile', 'statProjectFile', 'previewProjectFileRange']);

/** Values too large to hold in the recording are held as their length and hash (`limit.bin` read whole, a 2 MiB thumbnail). */
const HELD_WHOLE_MAX = 64 * 1024;

/**
 * Plays the ops against a driver and returns the trace. `driver.call(name, params)` answers `{ frame }`; `records` are the ids the
 * world's recovery records got. What one world names by a value of its own is named by its place: a grant's token by the order it was
 * first answered (`$grant<n>`), a record by its seeding order (`$record<n>`), an inspected record's revision by the order it was first
 * answered (`$revision<n>`).
 */
export async function play(script, driver, records) {
  const steps = [];
  const answers = new Map();
  const tokens = [];
  const revisions = [];
  const resolve = (value) => {
    if (Array.isArray(value)) return value.map(resolve);
    if (!value || typeof value !== 'object') return value;
    if (value.$record !== undefined) return records[value.$record];
    if (value.$answer !== undefined) return value.path.reduce((at, key) => at?.[key], answers.get(value.$answer));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
  };
  const placed = (value) => {
    if (typeof value === 'string') {
      if (value.length > HELD_WHOLE_MAX) return { $length: value.length, $sha256: sha256(value) };
      let text = value;
      records.forEach((id, index) => (text = text.replaceAll(id, `$record${index}`)));
      tokens.forEach((token, index) => (text = text.replaceAll(token, `$grant${index}`)));
      revisions.forEach((revision, index) => (text = text.replaceAll(revision, `$revision${index}`)));
      return text;
    }
    if (Array.isArray(value)) return value.map(placed);
    if (!value || typeof value !== 'object') return value;
    if (typeof value.accessToken === 'string' && !tokens.includes(value.accessToken)) tokens.push(value.accessToken);
    if (typeof value.revision === 'string' && /^[a-f0-9]{64}$/.test(value.revision) && !revisions.includes(value.revision)) revisions.push(value.revision);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, placed(item)]));
  };
  for (const op of script.ops) {
    const params = resolve(op.params);
    const { frame } = await driver.call(op.name, params);
    if (op.as && frame.ok) answers.set(op.as, frame.value);
    // A file call answers the file's modification time, which the OS stamps when a staged attachment or a restore writes it. Each side
    // proves the answer is its own file's time on disk right after the call; the answer then holds `{ $fileMtime: true }`.
    if (FILE_CALLS.has(op.name) && frame.ok && typeof frame.value?.mtimeMs === 'number') {
      const onDisk = statSync(join(params[0], params[1])).mtimeMs;
      if (frame.value.mtimeMs !== onDisk) throw new Error(`${op.name} answered mtime ${frame.value.mtimeMs}, the file has ${onDisk}`);
      frame.value.mtimeMs = { $fileMtime: true };
    }
    steps.push({ call: op.name, params: placed(params), frame: placed(frame) });
  }
  return { steps };
}

/** A folder's files, whole: path, size and content hash. */
export function treeOf(dir) {
  const rows = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(at, entry.name);
      const rel = relative(dir, path).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        rows.push({ path: rel, dir: true });
        walk(path);
      } else {
        const bytes = readFileSync(path);
        rows.push({ path: rel, size: bytes.length, sha256: sha256(bytes) });
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return rows;
}

/** The world's state after the script: the project, the files outside it and the staged attachments in the PC's temp folder. */
export function worldState(world, recoveryDir, records) {
  return {
    project: treeOf(world.project),
    outside: treeOf(world.outside),
    staged: treeOf(join(world.temp, 'mixdog-attachments')),
    recovery: recoveryStoreOf(recoveryDir, records),
  };
}
