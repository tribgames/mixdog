// Attachments by id: the bytes live once in the attachment store, a message
// names them by content hash, and the host serves an id (preview grant or
// download grant) only when THIS session's transcript names it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import test from 'node:test';

import { fileDownloadErrorReason } from '../shared/file-downloads.ts';
import { readSessionAttachment } from './session-attachments.ts';
import { sessionAttachments } from './transcript-file-links.ts';

import { makeTempDirSync, redirectSystemTemp } from '../../../../scripts/lib/scoped-temp.mjs';

redirectSystemTemp('tmp-root');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PHONE = { deviceId: 'phone' };

function fixture(t) {
  const temp = makeTempDirSync('session-attachments');
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const pdf = Buffer.from('%PDF-1.7\nspec body');
  const note = Buffer.from('notes '.repeat(200));
  const shot = Buffer.from('png bytes');
  const old = Buffer.from('legacy image bytes');
  const secret = Buffer.from('another session attachment');
  const archived = Buffer.from('image pasted before a compaction');
  const store = new Map([pdf, note, shot, old, secret, archived].map((bytes) => [sha(bytes), bytes]));
  const record = (bytes, kind, name, mimeType) => ({
    id: sha(bytes),
    attachmentRef: sha(bytes),
    kind,
    name,
    mimeType,
    size: bytes.length,
  });
  const transcripts = new Map([
    [
      's1',
      {
        items: [
          {
            id: 'u1',
            kind: 'user',
            text: 'hello',
            attachments: [
              record(pdf, 'file', 'spec.pdf', 'application/pdf'),
              record(note, 'text', 'notes.md', 'text/markdown'),
              record(shot, 'image', 'shot.png', 'image/png'),
            ],
          },
          // A message sent before attachments were recorded: its image still has its own ref.
          {
            id: 'u0',
            kind: 'user',
            text: 'old',
            images: [{ id: 1, name: 'old.png', mimeType: 'image/png', attachmentRef: sha(old) }],
          },
          // Only user rows name attachments: an assistant or tool row printing a hash grants nothing.
          { id: 'a1', kind: 'assistant', text: sha(secret), attachments: [record(secret, 'file', 'x.bin', 'x/y')] },
          { id: 't1', kind: 'tool', name: 'shell', result: sha(secret) },
        ],
      },
    ],
    [
      's2',
      {
        items: [
          {
            id: 'u2',
            kind: 'user',
            text: 'other',
            attachments: [record(secret, 'file', 'secret.bin', 'application/octet-stream')],
          },
        ],
      },
    ],
  ]);
  // The whole stored conversation: the window above plus the rows a
  // compaction moved into the archive, which the window no longer holds.
  const histories = new Map([
    [
      's1',
      {
        items: [
          {
            id: 'arch1_0_1',
            kind: 'user',
            archived: true,
            attachments: [record(archived, 'image', 'image.png', 'image/png')],
            images: [{ id: 1, name: 'image.png', mimeType: 'image/png', attachmentRef: sha(archived) }],
          },
          // Printing a hash in an archived reply grants nothing either.
          { id: 'arch1_1_1', kind: 'assistant', archived: true, attachments: [record(secret, 'file', 'x.bin', 'x/y')] },
        ],
      },
    ],
  ]);
  const host = {
    readSessionTranscript: async (id) => transcripts.get(id) ?? null,
    readSessionHistory: async (id) => histories.get(id) ?? null,
    readAttachmentImage: async (ref) => store.get(ref)?.toString('base64') ?? null,
    listSessions: async () => [
      { id: 's1', cwd: temp, projectPath: null, classification: 'task' },
      { id: 's2', cwd: temp, projectPath: null, classification: 'task' },
    ],
    projectDirectory: async (path) => path,
    invokeCapability: async () => null,
  };
  return {
    temp,
    host,
    ids: {
      pdf: sha(pdf),
      note: sha(note),
      shot: sha(shot),
      old: sha(old),
      secret: sha(secret),
      archived: sha(archived),
    },
    store,
    pdf,
    note,
  };
}

const refusedAs = async (promise, reason) => {
  const error = await promise.then(
    () => null,
    (failure) => failure
  );
  assert.ok(error, `expected a ${reason} refusal`);
  assert.equal(fileDownloadErrorReason(error), reason, String(error?.message));
};

test('a session names its attachments from user rows only, legacy images included', (t) => {
  const { host, ids } = fixture(t);
  return host.readSessionTranscript('s1').then((snapshot) => {
    const found = sessionAttachments(snapshot);
    assert.deepEqual([...found.keys()].sort(), [ids.pdf, ids.note, ids.shot, ids.old].sort());
    assert.equal(found.get(ids.pdf).name, 'spec.pdf');
    assert.equal(found.get(ids.old).kind, 'image');
    assert.equal(found.has(ids.secret), false);
    assert.equal(
      sessionAttachments({ items: [{ kind: 'user', attachments: [{ id: '../x' }, { id: 'a'.repeat(63) }] }] }).size,
      0
    );
  });
});

test('an attachment reads by id for its own session and for no other', async (t) => {
  const { host, ids, pdf } = fixture(t);
  const { meta, bytes } = await readSessionAttachment(host, 's1', ids.pdf);
  assert.equal(meta.name, 'spec.pdf');
  assert.deepEqual(bytes, pdf);
  // Another session's id, an id nothing names, a printed hash, a malformed id.
  await refusedAs(readSessionAttachment(host, 's1', ids.secret), 'not-linked');
  await refusedAs(readSessionAttachment(host, 's2', ids.pdf), 'not-linked');
  await refusedAs(readSessionAttachment(host, 'missing', ids.pdf), 'not-linked');
  await refusedAs(readSessionAttachment(host, 's1', sha(Buffer.from('guess'))), 'not-linked');
  await assert.rejects(readSessionAttachment(host, 's1', '../../etc/passwd'), TypeError);
  // The legacy image resolves by its own ref.
  assert.equal((await readSessionAttachment(host, 's1', ids.old)).meta.kind, 'image');
});

test("an attachment only the compacted history names opens; another session's id is still refused", async (t) => {
  const { host, ids } = fixture(t);
  // The transcript window the host holds does not name it (a chip of rows paged in earlier shows it).
  assert.equal(sessionAttachments(await host.readSessionTranscript('s1')).has(ids.archived), false);
  const { meta, bytes } = await readSessionAttachment(host, 's1', ids.archived);
  assert.equal(meta.name, 'image.png');
  assert.equal(bytes.toString(), 'image pasted before a compaction');
  // The history belongs to s1 alone, and only its user rows grant an id.
  await refusedAs(readSessionAttachment(host, 's2', ids.archived), 'not-linked');
  await refusedAs(readSessionAttachment(host, 's1', ids.secret), 'not-linked');
  await refusedAs(readSessionAttachment(host, 's1', sha(Buffer.from('guess'))), 'not-linked');
  await refusedAs(readSessionAttachment(host, 'missing', ids.archived), 'not-linked');
  // A host that cannot read the stored history serves the window alone.
  const windowOnly = { ...host, readSessionHistory: undefined };
  await refusedAs(readSessionAttachment(windowOnly, 's1', ids.archived), 'not-linked');
  assert.equal((await readSessionAttachment(windowOnly, 's1', ids.pdf)).meta.name, 'spec.pdf');
});

test('a named attachment the store no longer holds, or holds corrupted, is not served', async (t) => {
  const { host, ids, store } = fixture(t);
  store.delete(ids.note);
  await refusedAs(readSessionAttachment(host, 's1', ids.note), 'not-found');
  store.set(ids.pdf, Buffer.from('tampered'));
  await refusedAs(readSessionAttachment(host, 's1', ids.pdf), 'changed');
});
