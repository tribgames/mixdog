// Server-window file lanes: uploads into the server's staging folder, ranged
// previews and downloads, the server trash, and what stays gated.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { DESKTOP_IPC } from '../shared/contract.ts';
import { connectionFeatureGate } from './connections/feature-gates.ts';
import { registerServerFileIpc } from './ipc-server-files.ts';
import {
  createServerDownloads,
  createServerFilePreviews,
  localDownloadName,
  ServerFileGrants,
  serverByteStream,
  uploadServerBytes,
} from './server-file-access.ts';
import {
  createServerFileOperations,
  SERVER_UPLOAD_CHUNK_BYTES,
  SERVER_UPLOAD_MAX_BYTES,
  sessionRecordsReferencing,
} from './server-file-operations.ts';

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-server-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userData = join(root, 'user-data');
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  const ops = createServerFileOperations({ userDataPath: userData, ...options });
  t.after(() => ops.dispose());
  // What main's invokeDesktopOperation reaches: the daemon's operations.
  const invoke = async (name, args) => {
    if (name === 'statProjectFileIn') {
      const { statProjectFileIn } = await import('./project-files.ts');
      return statProjectFileIn(args[0], args[1]);
    }
    if (name === 'statLocalEntryAbs') {
      const { statLocalEntryAbs } = await import('./local-files.ts');
      return statLocalEntryAbs(args[0]);
    }
    assert.ok(ops.handles(name), name);
    return ops.invoke(name, args);
  };
  return { root, userData, project, ops, invoke };
}

/** One whole upload straight through the daemon's operations. (Its paths are
 *  this test machine's; the PC-side client, which only accepts POSIX server
 *  paths, is covered against a hostile daemon double below.) */
async function stage(f, payload, name, scope) {
  const { uploadId } = await f.ops.invoke('serverUploadBegin', [name, payload.length, scope]);
  await f.ops.invoke('serverUploadChunk', [uploadId, 0, payload.toString('base64')]);
  return f.ops.invoke('serverUploadCommit', [uploadId]);
}

function bytes(length, seed = 7) {
  const out = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) out[index] = (index * 31 + seed) & 0xff;
  return out;
}

test('an upload lands in the session staging folder chunk by chunk', async (t) => {
  const f = fixture(t);
  const payload = bytes(SERVER_UPLOAD_CHUNK_BYTES * 2 + 123);
  const begun = await f.ops.invoke('serverUploadBegin', ['photo.png', payload.length, 'session-1']);
  assert.equal(begun.chunkBytes, SERVER_UPLOAD_CHUNK_BYTES);
  const chunk = (offset) =>
    payload.subarray(offset, Math.min(payload.length, offset + SERVER_UPLOAD_CHUNK_BYTES)).toString('base64');
  assert.deepEqual(await f.ops.invoke('serverUploadChunk', [begun.uploadId, 0, chunk(0)]), {
    received: SERVER_UPLOAD_CHUNK_BYTES,
  });
  // A retried chunk is acknowledged without being written twice.
  assert.deepEqual(await f.ops.invoke('serverUploadChunk', [begun.uploadId, 0, chunk(0)]), {
    received: SERVER_UPLOAD_CHUNK_BYTES,
  });
  await assert.rejects(
    f.ops.invoke('serverUploadChunk', [begun.uploadId, SERVER_UPLOAD_CHUNK_BYTES * 2, chunk(0)]),
    /out of order/
  );
  await assert.rejects(f.ops.invoke('serverUploadCommit', [begun.uploadId]), /incomplete/);
  for (let offset = SERVER_UPLOAD_CHUNK_BYTES; offset < payload.length; offset += SERVER_UPLOAD_CHUNK_BYTES) {
    await f.ops.invoke('serverUploadChunk', [begun.uploadId, offset, chunk(offset)]);
  }
  const done = await f.ops.invoke('serverUploadCommit', [begun.uploadId]);
  assert.equal(done.absolutePath, join(f.userData, 'attachments', 'session-1', 'photo.png'));
  assert.equal(done.size, payload.length);
  assert.ok(readFileSync(done.absolutePath).equals(payload));
  // The same name again never overwrites the first upload.
  const again = await stage(f, bytes(10), 'photo.png', 'session-1');
  assert.equal(again.name, 'photo (2).png');
  assert.deepEqual(readdirSync(join(f.userData, 'attachments', 'session-1')).sort(), ['photo (2).png', 'photo.png']);
});

test('an upload is held to its size limit and its declared size', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.ops.invoke('serverUploadBegin', ['big.bin', SERVER_UPLOAD_MAX_BYTES + 1, 's']), /size/);
  await assert.rejects(f.ops.invoke('serverUploadBegin', ['x', 10, '../escape']), /scope/);
  const begun = await f.ops.invoke('serverUploadBegin', ['small.bin', 4, 's']);
  await assert.rejects(
    f.ops.invoke('serverUploadChunk', [begun.uploadId, 0, bytes(5).toString('base64')]),
    /larger than it declared/
  );
  // The oversized upload is discarded with its partial file.
  await assert.rejects(f.ops.invoke('serverUploadCommit', [begun.uploadId]), /gone/);
  assert.deepEqual(readdirSync(join(f.userData, 'attachments', 's')), []);
});

test('a cancelled or idle upload removes its partial file', async (t) => {
  const f = fixture(t, { idleMs: 30 });
  const cancelled = await f.ops.invoke('serverUploadBegin', ['a.zip', 100, 's']);
  await f.ops.invoke('serverUploadChunk', [cancelled.uploadId, 0, bytes(50).toString('base64')]);
  assert.equal(await f.ops.invoke('serverUploadAbort', [cancelled.uploadId]), true);
  await assert.rejects(
    f.ops.invoke('serverUploadChunk', [cancelled.uploadId, 50, bytes(50).toString('base64')]),
    /gone/
  );
  const idle = await f.ops.invoke('serverUploadBegin', ['b.zip', 100, 's']);
  await delay(80);
  await assert.rejects(f.ops.invoke('serverUploadCommit', [idle.uploadId]), /gone/);
  assert.deepEqual(readdirSync(join(f.userData, 'attachments', 's')), []);
});

test('deleting a session removes its staging folder, never one still uploading', async (t) => {
  const f = fixture(t);
  await stage(f, bytes(10), 'a.png', 'sess_one');
  const pending = await f.ops.invoke('serverUploadBegin', ['b.png', 10, 'sess_two']);
  assert.equal(await f.ops.removeSessionUploads('sess_one'), true);
  assert.equal(existsSync(join(f.userData, 'attachments', 'sess_one')), false);
  // Busy, unknown and empty ids remove nothing.
  assert.equal(await f.ops.removeSessionUploads('sess_two'), false);
  assert.equal(await f.ops.removeSessionUploads('sess_none'), false);
  assert.equal(await f.ops.removeSessionUploads(''), false);
  assert.ok(existsSync(join(f.userData, 'attachments', 'sess_two')));
  await f.ops.invoke('serverUploadAbort', [pending.uploadId]);
});

test('the age sweep removes only old staging folders no live session owns or references', async (t) => {
  const day = 24 * 60 * 60 * 1000;
  const nowMs = Date.parse('2026-03-01T00:00:00Z');
  const f = fixture(t, { now: () => new Date(nowMs), idleMs: 1_000 });
  const staging = join(f.userData, 'attachments');
  const age = (path, days) => utimesSync(path, (nowMs - days * day) / 1000, (nowMs - days * day) / 1000);
  const folder = (scope, days, files = ['f.png']) => {
    const dir = join(staging, scope);
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      writeFileSync(join(dir, file), 'x');
      age(join(dir, file), days);
    }
    age(dir, days);
    return dir;
  };
  folder('sess_live', 90);
  const oldDraft = folder('draft', 40);
  const referencedDraft = folder('draft_kept', 40);
  folder('sess_deleted_recent', 5);
  folder('sess_deleted_old', 31, ['f.png', '.crash.part']);
  const recentWithStalePart = folder('sess_recent', 2, ['f.png', '.crash.part']);
  const asked = [];
  const { removed } = await f.ops.sweepUploads({
    liveSessionIds: ['sess_live'],
    referencedFolders: async (folders) => {
      asked.push(...folders);
      return new Set(folders.filter((dir) => dir === referencedDraft));
    },
  });
  assert.deepEqual(removed.sort(), ['draft', 'sess_deleted_old']);
  assert.deepEqual(readdirSync(staging).sort(), ['draft_kept', 'sess_deleted_recent', 'sess_live', 'sess_recent']);
  // Only folders already past retention are checked for references.
  assert.deepEqual(asked.sort(), [oldDraft, referencedDraft, join(staging, 'sess_deleted_old')].sort());
  // A crashed upload's partial file goes; finished uploads stay.
  assert.deepEqual(readdirSync(recentWithStalePart), ['f.png']);
});

test('stored session records decide which staging folders are still referenced', async (t) => {
  const f = fixture(t);
  const sessions = join(f.root, 'data', 'sessions');
  mkdirSync(sessions, { recursive: true });
  const kept = join(f.userData, 'attachments', 'draft_a');
  const free = join(f.userData, 'attachments', 'draft_b');
  writeFileSync(join(sessions, 's1.json'), JSON.stringify({ messages: [{ content: `see ${kept}/photo.png` }] }));
  writeFileSync(join(sessions, 's2.json'), JSON.stringify({ messages: [{ content: `${free}x/other` }] }));
  assert.deepEqual([...(await sessionRecordsReferencing(sessions, [kept, free]))], [kept]);
  assert.deepEqual([...(await sessionRecordsReferencing(join(f.root, 'missing'), [kept]))], []);
});

test('a ranged read stays inside the project it names', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.project, 'clip.mp4'), bytes(1000));
  writeFileSync(join(f.root, 'secret.txt'), 'outside');
  const range = await f.ops.invoke('serverFileReadRange', [f.project, 'clip.mp4', 990, 100]);
  assert.equal(range.size, 1000);
  assert.ok(Buffer.from(range.data, 'base64').equals(bytes(1000).subarray(990)));
  await assert.rejects(f.ops.invoke('serverFileReadRange', [f.project, '../secret.txt', 0, 10]), /outside/);
});

test('delete moves to the server trash, or deletes only when asked to', async (t) => {
  const f = fixture(t);
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(f.root, 'xdg');
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
  });
  writeFileSync(join(f.project, 'old.log'), 'x');
  writeFileSync(join(f.project, 'gone.log'), 'y');
  assert.equal((await f.ops.invoke('serverTrashInfo', [f.project])).available, true);
  const trashed = await f.ops.invoke('serverTrashEntry', [f.project, 'old.log', false]);
  assert.equal(trashed.mode, 'trash');
  assert.equal(readFileSync(trashed.trashPath, 'utf8'), 'x');
  assert.match(
    readFileSync(join(f.root, 'xdg', 'Trash', 'info', 'old.log.trashinfo'), 'utf8'),
    /^\[Trash Info\]\nPath=/
  );
  assert.equal(existsSync(join(f.project, 'old.log')), false);
  assert.deepEqual(await f.ops.invoke('serverTrashEntry', [f.project, 'gone.log', true]), { mode: 'deleted' });
  assert.equal(existsSync(join(f.project, 'gone.log')), false);
  await assert.rejects(f.ops.invoke('serverTrashEntry', [f.project, '', false]), /project folder itself/);
});

test('server paths resolve to their project, or to a one-file grant', async () => {
  const invoke = async (_name, [path]) => ({ name: path.split('/').pop(), dir: path.endsWith('/dir'), size: 3 });
  const grants = new ServerFileGrants(invoke, async () => [{ path: '/srv/repo' }, { path: '/srv/repo/sub' }]);
  const [inProject, outside, folder] = await grants.describe(['/srv/repo/sub/a.png', '/tmp/out.pdf', '/srv/dir']);
  assert.deepEqual(inProject, {
    absolutePath: '/srv/repo/sub/a.png',
    name: 'a.png',
    dir: false,
    size: 3,
    projectPath: '/srv/repo/sub',
    relPath: 'a.png',
  });
  assert.equal(outside.projectPath, '/tmp');
  assert.equal(outside.relPath, 'out.pdf');
  assert.deepEqual(grants.requireGrant(outside.accessToken, '/tmp', 'out.pdf'), {
    root: '/tmp',
    rel: 'out.pdf',
    absolute: '/tmp/out.pdf',
  });
  assert.throws(() => grants.requireGrant(outside.accessToken, '/tmp', 'other.pdf'), /does not match/);
  assert.throws(() => grants.requireGrant('nope', '/tmp', 'out.pdf'), /unavailable/);
  assert.equal(folder.dir, true);
  await assert.rejects(grants.describe(['relative/path']), /absolute/);
});

test('describing a granted server file again keeps its token, so repeated link checks never evict it', async () => {
  const invoke = async (_name, [path]) => ({ name: path.split('/').pop(), dir: false, size: 3 });
  const grants = new ServerFileGrants(invoke, async () => []);
  const [opened] = await grants.describe(['/tmp/open.txt']);
  for (let index = 0; index < 1_200; index++) await grants.describe(['/tmp/mentioned.txt']);
  assert.equal(grants.requireGrant(opened.accessToken, '/tmp', 'open.txt').absolute, '/tmp/open.txt');
  const [again] = await grants.describe(['/tmp/open.txt']);
  assert.equal(again.accessToken, opened.accessToken);
});

test('a server preview URL streams the requested byte range over the connection', async (t) => {
  const f = fixture(t);
  const payload = bytes(5 * 1024 * 1024 + 17);
  writeFileSync(join(f.project, 'movie.mp4'), payload);
  const handlers = new Map();
  const session = {
    protocol: {
      handle: (scheme, handler) => handlers.set(scheme, handler),
      unhandle: (scheme) => handlers.delete(scheme),
      isProtocolHandled: (scheme) => handlers.has(scheme),
    },
  };
  const previews = createServerFilePreviews({ session, invoke: f.invoke });
  assert.equal(previews.register(f.project, 'notes.bin', 'v1'), null, 'no in-app preview for this type');
  const preview = previews.register(f.project, 'movie.mp4', 'v1');
  assert.equal(preview.kind, 'video');
  assert.match(preview.url, /^mixdog-media:\/\/preview\/[0-9a-f-]{36}\/movie\.mp4$/);
  const handler = handlers.get('mixdog-media');
  const full = await handler(new Request(preview.url));
  assert.equal(full.status, 200);
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(payload));
  const start = 4 * 1024 * 1024 - 5;
  const ranged = await handler(new Request(preview.url, { headers: { range: `bytes=${start}-` } }));
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes ${start}-${payload.length - 1}/${payload.length}`);
  assert.ok(Buffer.from(await ranged.arrayBuffer()).equals(payload.subarray(start)));
  assert.equal((await handler(new Request('mixdog-media://preview/unknown/x.png'))).status, 404);
  previews.dispose();
  assert.equal(handlers.size, 0);
});

test('download to this PC copies the server file step by step, capped and cancellable', async (t) => {
  const f = fixture(t);
  const downloadsDir = join(f.root, 'downloads');
  const payload = bytes(9 * 1024 * 1024 + 3);
  writeFileSync(join(f.project, 'report.pdf'), payload);
  writeFileSync(join(f.project, 'huge.iso'), bytes(2000));
  const downloads = createServerDownloads({
    invoke: f.invoke,
    downloadsDir: () => downloadsDir,
    maxBytes: 10 * 1024 * 1024,
  });
  t.after(() => downloads.dispose());
  const begun = await downloads.begin(f.project, 'report.pdf');
  assert.equal(begun.size, payload.length);
  const progress = [];
  for (;;) {
    const step = await downloads.step(begun.downloadId);
    progress.push(step.received);
    if (step.done) break;
  }
  assert.deepEqual(progress, [4 * 1024 * 1024, 8 * 1024 * 1024, payload.length]);
  const { path } = await downloads.finish(begun.downloadId);
  assert.equal(path, join(downloadsDir, 'report.pdf'));
  assert.ok(readFileSync(path).equals(payload));
  assert.equal(downloads.requireDownloaded(path), path);
  assert.throws(() => downloads.requireDownloaded(join(f.project, 'report.pdf')), /Only a file downloaded/);
  // The same name again gets its own file.
  const second = await downloads.begin(f.project, 'report.pdf');
  while (!(await downloads.step(second.downloadId)).done);
  assert.equal((await downloads.finish(second.downloadId)).path, join(downloadsDir, 'report (2).pdf'));
  // Cancel leaves nothing behind.
  const cancelled = await downloads.begin(f.project, 'report.pdf');
  await downloads.step(cancelled.downloadId);
  assert.equal(await downloads.abort(cancelled.downloadId), true);
  assert.deepEqual(readdirSync(downloadsDir).sort(), ['report (2).pdf', 'report.pdf']);
  const capped = createServerDownloads({ invoke: f.invoke, downloadsDir: () => downloadsDir, maxBytes: 1000 });
  await assert.rejects(capped.begin(f.project, 'huge.iso'), /download limit/);
});

test('the upload channels forward chunks and hand back a granted server entry', async () => {
  const handlers = new Map();
  const calls = [];
  const staged = '/root/.mixdog-remote/user-data/attachments/draft/shot.png';
  const invoke = async (name, args) => {
    calls.push([name, ...args]);
    if (name === 'serverUploadBegin') {
      return { uploadId: 'u1', chunkBytes: SERVER_UPLOAD_CHUNK_BYTES, maxBytes: SERVER_UPLOAD_MAX_BYTES };
    }
    if (name === 'serverUploadCommit') return { absolutePath: staged, name: 'shot.png', dir: false, size: 3000 };
    return { received: 3000 };
  };
  const grants = new ServerFileGrants(invoke, async () => []);
  registerServerFileIpc({
    handle: (channel, listener) => handlers.set(channel, listener),
    server: { grants },
    invokeDesktopOperation: invoke,
    fileTarget: async () => ({ root: '/srv', rel: 'x' }),
    projectDirectory: async (project) => project,
    shell: { openPath: async () => '' },
  });
  const call = async (channel, ...args) => handlers.get(channel)({}, ...args);
  const payload = bytes(3000);
  await call(DESKTOP_IPC.serverUploadBegin, 'shot.png', payload.length, 'draft');
  await assert.rejects(call(DESKTOP_IPC.serverUploadChunk, 'u1', 0, 'not bytes'), /chunk is invalid/);
  await assert.rejects(
    call(DESKTOP_IPC.serverUploadChunk, 'u1', 0, new Uint8Array(SERVER_UPLOAD_CHUNK_BYTES + 1)),
    /chunk is invalid/
  );
  await call(DESKTOP_IPC.serverUploadChunk, 'u1', 0, new Uint8Array(payload));
  assert.deepEqual(calls[1], ['serverUploadChunk', 'u1', 0, payload.toString('base64')]);
  const entry = await call(DESKTOP_IPC.serverUploadCommit, 'u1');
  assert.equal(entry.projectPath, '/root/.mixdog-remote/user-data/attachments/draft');
  assert.equal(entry.relPath, 'shot.png');
  assert.equal(grants.requireGrant(entry.accessToken, entry.projectPath, entry.relPath).absolute, staged);
});

// ── The server is untrusted ─────────────────────────────────────────────────

/** A daemon double: `answers[name]` is a value or a function of the args. */
function hostile(answers) {
  const calls = [];
  const invoke = async (name, args) => {
    calls.push([name, ...args]);
    const answer = answers[name];
    return typeof answer === 'function' ? answer(...args) : answer;
  };
  return { invoke, calls };
}

async function drain(stream) {
  const reader = stream.getReader();
  for (;;) if ((await reader.read()).done) return;
}

test('a preview read never accepts more bytes, or other bytes, than it asked for', async () => {
  const oversize = hostile({
    serverFileReadRange: (_root, _rel, offset) => ({
      data: bytes(1024).toString('base64'),
      offset,
      size: 2048,
      mtimeMs: 1,
    }),
  });
  await assert.rejects(
    drain(serverByteStream(oversize.invoke, '/srv', 'a.png', 0, 0)),
    /invalid response: a chunk longer than the 1 bytes requested/
  );
  // Decoded bytes are checked too, not just the base64 length.
  const padded = hostile({
    serverFileReadRange: (_root, _rel, offset) => ({ data: bytes(2).toString('base64'), offset, size: 9, mtimeMs: 1 }),
  });
  await assert.rejects(drain(serverByteStream(padded.invoke, '/srv', 'a.png', 0, 0)), /longer than the 1 bytes/);
  for (const data of ['not base64!', 42, null, 'QUJD=']) {
    const bad = hostile({ serverFileReadRange: (_r, _p, offset) => ({ data, offset, size: 9, mtimeMs: 1 }) });
    await assert.rejects(drain(serverByteStream(bad.invoke, '/srv', 'a.png', 0, 3)), /not base64/, String(data));
  }
  const shifted = hostile({
    serverFileReadRange: () => ({ data: bytes(4).toString('base64'), offset: 100, size: 9, mtimeMs: 1 }),
  });
  await assert.rejects(drain(serverByteStream(shifted.invoke, '/srv', 'a.png', 0, 3)), /offset 100, not 0/);
  const stuck = hostile({ serverFileReadRange: (_r, _p, offset) => ({ data: '', offset, size: 9, mtimeMs: 1 }) });
  await assert.rejects(drain(serverByteStream(stuck.invoke, '/srv', 'a.png', 0, 3)), /changed while it was read/);
});

test('a preview refuses a server file size that is not a non-negative integer', async () => {
  const handlers = new Map();
  const session = {
    protocol: {
      handle: (scheme, handler) => handlers.set(scheme, handler),
      unhandle: (scheme) => handlers.delete(scheme),
      isProtocolHandled: (scheme) => handlers.has(scheme),
    },
  };
  for (const size of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '10', undefined, 2 ** 60]) {
    const server = hostile({ statProjectFileIn: { size, mtimeMs: 1 }, serverFileReadRange: () => assert.fail('read') });
    const previews = createServerFilePreviews({ session, invoke: server.invoke });
    const { url } = previews.register('/srv', 'a.png', 'v1');
    const response = await handlers.get('mixdog-media')(new Request(url));
    assert.equal(response.status, 502, String(size));
    assert.match(await response.text(), /invalid response: the file size/);
    previews.dispose();
  }
});

test('a download validates the server size and every chunk before writing', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-server-download-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const downloadsDir = join(root, 'downloads');
  for (const info of [
    { size: -1, mtimeMs: 1 },
    { size: 1.5, mtimeMs: 1 },
    { size: Number.POSITIVE_INFINITY, mtimeMs: 1 },
    { size: Number.NaN, mtimeMs: 1 },
    { size: '10', mtimeMs: 1 },
    { size: 10, mtimeMs: Number.NaN },
    { size: 10 },
    null,
  ]) {
    const server = hostile({ statProjectFileIn: info });
    const downloads = createServerDownloads({ invoke: server.invoke, downloadsDir: () => downloadsDir });
    await assert.rejects(downloads.begin('/srv', 'a.bin'), /invalid response/, JSON.stringify(info));
  }
  assert.equal(existsSync(downloadsDir), false, 'nothing is created for a bad size');
  // Within the cap only; the cap is checked on the validated integer.
  const huge = hostile({ statProjectFileIn: { size: 2 ** 40, mtimeMs: 1 } });
  await assert.rejects(
    createServerDownloads({ invoke: huge.invoke, downloadsDir: () => downloadsDir }).begin('/srv', 'a.bin'),
    /download limit/
  );

  const cases = [
    [(offset) => ({ data: bytes(11).toString('base64'), offset, size: 10, mtimeMs: 1 }), /longer than the 10 bytes/],
    [(offset) => ({ data: bytes(4).toString('base64'), offset: offset + 1, size: 10, mtimeMs: 1 }), /offset 1, not 0/],
    [(offset) => ({ data: bytes(4).toString('base64'), offset, size: -5, mtimeMs: 1 }), /the file size/],
    [(offset) => ({ data: '', offset, size: 10, mtimeMs: 1 }), /changed while it was downloading/],
    [
      (offset) => ({ data: bytes(4).toString('base64'), offset, size: 11, mtimeMs: 1 }),
      /changed while it was downloading/,
    ],
  ];
  for (const [answer, error] of cases) {
    const server = hostile({
      statProjectFileIn: { size: 10, mtimeMs: 1 },
      serverFileReadRange: (_r, _p, offset) => answer(offset),
    });
    const downloads = createServerDownloads({ invoke: server.invoke, downloadsDir: () => downloadsDir });
    const begun = await downloads.begin('/srv', 'a.bin');
    await assert.rejects(downloads.step(begun.downloadId), error);
    await assert.rejects(downloads.step(begun.downloadId), /download is gone/);
    assert.deepEqual(readdirSync(downloadsDir), [], 'the partial file is removed');
  }
});

test('a download name from a server path can never leave the download folder', async (t) => {
  for (const [name, expected] of [
    ['..', 'download'],
    ['.', 'download'],
    ['../../evil.sh', '_.._evil.sh'],
    ['..\\..\\evil.bat', '_.._evil.bat'],
    ['C:\\Windows\\x.dll', 'C_Windows_x.dll'],
    ['.bashrc', 'bashrc'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['report.pdf', 'report.pdf'],
  ]) {
    assert.equal(localDownloadName(name), expected, name);
  }
  const root = mkdtempSync(join(tmpdir(), 'mixdog-server-download-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const downloadsDir = join(root, 'downloads');
  const server = hostile({
    statProjectFileIn: { size: 3, mtimeMs: 1 },
    serverFileReadRange: (_r, _p, offset) => ({ data: bytes(3).toString('base64'), offset, size: 3, mtimeMs: 1 }),
  });
  const downloads = createServerDownloads({ invoke: server.invoke, downloadsDir: () => downloadsDir });
  const begun = await downloads.begin('/srv', '..\\..\\evil.bat');
  while (!(await downloads.step(begun.downloadId)).done);
  assert.equal((await downloads.finish(begun.downloadId)).path, join(downloadsDir, '_.._evil.bat'));
  assert.deepEqual(readdirSync(root), ['downloads']);
});

test('an upload refuses server chunk sizes, acknowledgements and entries that do not match', async () => {
  const payload = bytes(10);
  const begin = (extra = {}) => ({ uploadId: 'u1', chunkBytes: 4, maxBytes: SERVER_UPLOAD_MAX_BYTES, ...extra });
  const ack = (_id, offset, data) => ({ received: offset + Buffer.from(data, 'base64').length });
  const entry = { absolutePath: '/srv/up/a.bin', name: 'a.bin', dir: false, size: 10 };
  const aborted = (calls) => calls.some(([name]) => name === 'serverUploadAbort');

  for (const chunkBytes of [0, -1, 1.5, Number.NaN, '4', SERVER_UPLOAD_CHUNK_BYTES + 1]) {
    const server = hostile({ serverUploadBegin: begin({ chunkBytes }) });
    await assert.rejects(
      uploadServerBytes(server.invoke, payload, 'a.bin', 's'),
      /the upload chunk size/,
      String(chunkBytes)
    );
    assert.ok(aborted(server.calls), 'aborted on the server');
    assert.equal(server.calls.filter(([name]) => name === 'serverUploadChunk').length, 0);
  }
  for (const uploadId of ['', '../x', 'a'.repeat(65), 7]) {
    const server = hostile({ serverUploadBegin: begin({ uploadId }) });
    await assert.rejects(uploadServerBytes(server.invoke, payload, 'a.bin', 's'), /upload id is malformed/);
  }
  // An acknowledgement that does not advance by exactly the chunk fails at once.
  for (const received of [0, 3, 5, -1, 'x']) {
    const server = hostile({ serverUploadBegin: begin(), serverUploadChunk: { received } });
    await assert.rejects(uploadServerBytes(server.invoke, payload, 'a.bin', 's'), /invalid response/, String(received));
    assert.equal(server.calls.filter(([name]) => name === 'serverUploadChunk').length, 1);
    assert.ok(aborted(server.calls));
  }
  for (const committed of [
    { ...entry, size: 11 },
    { ...entry, dir: true },
    { ...entry, absolutePath: 'relative/a.bin' },
    { ...entry, absolutePath: '/' },
    null,
  ]) {
    const server = hostile({ serverUploadBegin: begin(), serverUploadChunk: ack, serverUploadCommit: committed });
    await assert.rejects(
      uploadServerBytes(server.invoke, payload, 'a.bin', 's'),
      /invalid response/,
      JSON.stringify(committed)
    );
    assert.ok(aborted(server.calls));
  }
  // The entry's name comes from its path, never from the server.
  const server = hostile({
    serverUploadBegin: begin(),
    serverUploadChunk: ack,
    serverUploadCommit: { ...entry, name: '../../evil' },
  });
  assert.deepEqual(await uploadServerBytes(server.invoke, payload, 'a.bin', 's'), {
    absolutePath: '/srv/up/a.bin',
    name: 'a.bin',
    dir: false,
    size: 10,
  });
  assert.deepEqual(
    server.calls.filter(([name]) => name === 'serverUploadChunk').map(([, , offset]) => offset),
    [0, 4, 8]
  );
});

test('the upload channels abort an upload whose server answers do not match', async () => {
  const handlers = new Map();
  let received = 0;
  const server = hostile({
    serverUploadBegin: { uploadId: 'u1', chunkBytes: SERVER_UPLOAD_CHUNK_BYTES, maxBytes: SERVER_UPLOAD_MAX_BYTES },
    serverUploadChunk: () => ({ received }),
    serverUploadCommit: { absolutePath: '/srv/a.bin', name: 'a.bin', dir: false, size: 99 },
    serverUploadAbort: true,
  });
  registerServerFileIpc({
    handle: (channel, listener) => handlers.set(channel, listener),
    server: { grants: new ServerFileGrants(server.invoke, async () => []) },
    invokeDesktopOperation: server.invoke,
    fileTarget: async () => ({ root: '/srv', rel: 'x' }),
    projectDirectory: async (project) => project,
    shell: { openPath: async () => '' },
  });
  const call = async (channel, ...args) => handlers.get(channel)({}, ...args);
  await assert.rejects(call(DESKTOP_IPC.serverUploadChunk, 'u1', 0, new Uint8Array(4)), /upload is gone/);
  await call(DESKTOP_IPC.serverUploadBegin, 'a.bin', 8, 's');
  await assert.rejects(call(DESKTOP_IPC.serverUploadChunk, 'u1', 8, new Uint8Array(4)), /offset is invalid/);
  // No progress: the server acknowledged nothing.
  await assert.rejects(call(DESKTOP_IPC.serverUploadChunk, 'u1', 0, new Uint8Array(4)), /0 bytes acknowledged/);
  assert.deepEqual(server.calls.at(-1), ['serverUploadAbort', 'u1']);
  await assert.rejects(call(DESKTOP_IPC.serverUploadChunk, 'u1', 0, new Uint8Array(4)), /upload is gone/);
  // A committed size other than the declared one.
  await call(DESKTOP_IPC.serverUploadBegin, 'a.bin', 8, 's');
  received = 4;
  assert.deepEqual(await call(DESKTOP_IPC.serverUploadChunk, 'u1', 0, new Uint8Array(4)), { received: 4 });
  received = 8;
  await call(DESKTOP_IPC.serverUploadChunk, 'u1', 4, new Uint8Array(4));
  await assert.rejects(call(DESKTOP_IPC.serverUploadCommit, 'u1'), /the uploaded size 99/);
  assert.deepEqual(server.calls.at(-1), ['serverUploadAbort', 'u1']);
  // A malformed begin answer is refused before the renderer sees it.
  const bad = hostile({ serverUploadBegin: { uploadId: 'u2', chunkBytes: 0, maxBytes: 1 } });
  handlers.clear();
  registerServerFileIpc({
    handle: (channel, listener) => handlers.set(channel, listener),
    server: { grants: new ServerFileGrants(bad.invoke, async () => []) },
    invokeDesktopOperation: bad.invoke,
    fileTarget: async () => ({ root: '/srv', rel: 'x' }),
    projectDirectory: async (project) => project,
    shell: { openPath: async () => '' },
  });
  await assert.rejects(call(DESKTOP_IPC.serverUploadBegin, 'a.bin', 8, 's'), /the upload chunk size/);
  assert.deepEqual(bad.calls.at(-1), ['serverUploadAbort', 'u2']);
});

test('described server entries take their name from the path and validated metadata', async () => {
  const grants = (info) => new ServerFileGrants(hostile({ statLocalEntryAbs: info }).invoke, async () => []);
  const [row] = await grants({ name: '../../evil', dir: false, size: 3 }).describe(['/tmp/a.png']);
  assert.equal(row.name, 'a.png');
  for (const info of [{ dir: 'no', size: 3 }, { dir: false, size: -3 }, { dir: false, size: 1.5 }, null]) {
    await assert.rejects(grants(info).describe(['/tmp/a.png']), /invalid response/, JSON.stringify(info));
  }
});

test('a server window keeps refusing only what hands a file to this PC', () => {
  for (const channel of [
    DESKTOP_IPC.resolveLocalPaths,
    DESKTOP_IPC.readLocalFile,
    DESKTOP_IPC.stageAttachmentFile,
    DESKTOP_IPC.previewProjectFile,
    DESKTOP_IPC.previewDocumentFile,
    DESKTOP_IPC.trashProjectEntry,
    DESKTOP_IPC.serverUploadBegin,
    DESKTOP_IPC.serverDownloadBegin,
  ]) {
    assert.equal(connectionFeatureGate('ssh', channel), null, channel);
  }
  for (const channel of [DESKTOP_IPC.openFilePath, DESKTOP_IPC.revealFile, DESKTOP_IPC.chooseFiles]) {
    assert.match(connectionFeatureGate('ssh', channel).message, /not available in a server window\. \S/, channel);
    assert.equal(connectionFeatureGate('local', channel), null, channel);
  }
});
