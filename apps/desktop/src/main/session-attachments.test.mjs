// Attachments by id: the bytes live once in the attachment store, a message
// names them by content hash, and the host serves an id (preview grant or
// download grant) only when THIS session's transcript names it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { fileDownloadErrorReason } from '../shared/file-downloads.ts';
import { createFileDownloadService } from './file-downloads.ts';
import { createRemoteAttachmentMethods } from './remote-attachments.ts';
import { readSessionAttachment } from './session-attachments.ts';
import { sessionAttachments } from './transcript-file-links.ts';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PHONE = { deviceId: 'phone' };

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'session-attachments-'));
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

test('an attachment only the compacted history names opens; another session\'s id is still refused', async (t) => {
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

test('a paired device opens an attachment through a session-scoped one-file preview grant', async (t) => {
  const { host, ids, temp, pdf } = fixture(t);
  const grants = [];
  const methods = createRemoteAttachmentMethods({
    host,
    grants: { rememberFileGrant: (path, session) => (grants.push([path, session]), 'token-1') },
    temp: () => temp,
  });
  const row = await methods.attachmentOpen(['s1', ids.pdf]);
  assert.equal(row.accessToken, 'token-1');
  assert.equal(row.name, `${ids.pdf.slice(0, 16)}-spec.pdf`);
  assert.equal(row.relPath, basename(row.absolutePath));
  assert.deepEqual(readFileSync(row.absolutePath), pdf);
  assert.deepEqual(grants, [[row.absolutePath, 's1']]);
  // Nothing outside the session's attachments is granted.
  grants.length = 0;
  await assert.rejects(methods.attachmentOpen(['s1', ids.secret]));
  await assert.rejects(methods.attachmentOpen(['s2', ids.pdf]));
  await assert.rejects(methods.attachmentOpen(['s1', '../outside']));
  assert.deepEqual(grants, []);
  // A name-less text attachment still previews by an extension.
  const note = await methods.attachmentOpen(['s1', ids.note]);
  assert.match(note.name, /notes\.md$/);
});

test('the download grant admits only ids this session names, and serves the stored bytes', async (t) => {
  const { host, ids, pdf } = fixture(t);
  const service = createFileDownloadService({ host });
  const grant = await service.authorize(PHONE, {
    source: { kind: 'attachment', sessionId: 's1', attachmentId: ids.pdf },
    purpose: 'save',
  });
  assert.equal(grant.name, 'spec.pdf');
  assert.equal(grant.mime, 'application/pdf');
  const transfer = await service.begin(PHONE, grant.grantId);
  const chunk = await service.readRange(PHONE, transfer.transferId, 0, transfer.size, transfer.version);
  assert.deepEqual(Buffer.from(chunk.data, 'base64'), pdf);
  await service.finish(PHONE, transfer.transferId);
  const ask = (sessionId, attachmentId) =>
    service.authorize(PHONE, { source: { kind: 'attachment', sessionId, attachmentId }, purpose: 'save' });
  await refusedAs(ask('s1', ids.secret), 'not-linked');
  await refusedAs(ask('s2', ids.pdf), 'not-linked');
  await refusedAs(ask('nope', ids.pdf), 'unavailable');
});
