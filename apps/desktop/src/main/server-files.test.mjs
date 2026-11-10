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
