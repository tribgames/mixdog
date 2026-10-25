// Downloads by the path a session shows: a paired device downloads any file
// (or a folder as an on-demand zip) the desktop could open — absolute, or
// relative to the session's folder — whether or not the session references it.
// Only the desktop's project boundary holds: a project path may not leave the
// project through a link.
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';

import { FILE_DOWNLOAD_RANGE_MAX_BYTES, fileDownloadErrorReason } from '../shared/file-downloads.ts';
import { createFileDownloadService } from './file-downloads.ts';
import { createRemoteMethods } from './remote-methods.ts';

const PHONE = { deviceId: 'phone' };
const slash = (path) => path.replace(/\\/g, '/');

function fixture(t) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'session-grants-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = join(base, 'project');
  const outside = join(base, 'outside');
  const task = join(base, 'task');
  for (const dir of [
    project,
    outside,
    task,
    join(outside, 'report'),
    join(outside, 'report', 'sub'),
    join(outside, 'report', '.git'),
  ]) {
    mkdirSync(dir);
  }
  writeFileSync(join(outside, 'shell-out.txt'), 'from a shell');
  writeFileSync(join(outside, 'shot.png'), 'png');
  writeFileSync(join(outside, 'spaced name.txt'), 'with spaces');
  writeFileSync(join(outside, 'page.html'), '<p>page</p>');
  writeFileSync(join(outside, 'secret.txt'), 'never referenced');
  writeFileSync(join(outside, 'other-session.txt'), 'belongs to s2');
  writeFileSync(join(outside, 'prompted.txt'), 'only the user typed it');
  writeFileSync(join(outside, 'report', 'a.txt'), 'A');
  writeFileSync(join(outside, 'report', 'sub', 'b.txt'), 'B');
  writeFileSync(join(outside, 'report', '.git', 'config'), 'git internals');
  let links = true;
  try {
    symlinkSync(join(outside, 'secret.txt'), join(outside, 'report', 'link.txt'));
    symlinkSync(join(outside, 'secret.txt'), join(outside, 'alias.txt'));
  } catch {
    links = false; // symlinks need a privilege on some hosts: those cases skip
  }
  const sessions = [
    { id: 's1', cwd: project, projectPath: project, classification: 'project' },
    { id: 's2', cwd: task, projectPath: null, classification: 'task' },
  ];
  const tool = (id, name, extra) => ({ id, kind: 'tool', name, ...extra });
  const transcripts = new Map([
    [
      's1',
      {
        items: [
          { id: 'u1', kind: 'user', text: slash(join(outside, 'prompted.txt')) },
          tool('t1', 'shell', { result: `wrote ${slash(join(outside, 'shell-out.txt'))}` }),
          tool('t2', 'screenshot', { result: JSON.stringify({ ok: true, output: join(outside, 'shot.png') }) }),
          tool('t3', 'shell', { result: JSON.stringify({ ok: true, output: join(outside, 'spaced name.txt') }) }),
          tool('t4', 'shell', { result: `${slash(join(outside, 'report'))}/` }),
          tool('t5', 'shell', { result: slash(join(outside, 'page.html')) }),
          tool('t6', 'shell', { result: slash(join(outside, 'alias.txt')) }),
          { id: 'a1', kind: 'assistant', text: 'done', streaming: false },
        ],
      },
    ],
    ['s2', { items: [tool('x1', 'shell', { result: slash(join(outside, 'other-session.txt')) })] }],
  ]);
  const host = {
    listSessions: async () => sessions,
    readSessionTranscript: async (id) => transcripts.get(id) ?? null,
    projectDirectory: async (path) => path,
    invokeCapability: async () => null,
  };
  return { base, project, outside, host, sessions, transcripts, links };
}

async function download(service, source, size = 4096) {
  const grant = await service.authorize(PHONE, { source, purpose: 'save' });
  const transfer = await service.begin(PHONE, grant.grantId);
  const chunk = await service.readRange(
    PHONE,
    transfer.transferId,
    0,
    Math.min(size, FILE_DOWNLOAD_RANGE_MAX_BYTES),
    transfer.version
  );
  await service.finish(PHONE, transfer.transferId);
  return { grant, bytes: Buffer.from(chunk.data, 'base64') };
}

const refusedAs = async (promise, reason) => {
  const error = await promise.then(
    () => null,
    (failure) => failure
  );
  assert.ok(error, `expected a ${reason} refusal`);
  assert.equal(fileDownloadErrorReason(error), reason, String(error?.message));
  return error;
};

test('files a session references or its tools produced download from outside every project', async (t) => {
  const { host, outside } = fixture(t);
  const service = createFileDownloadService({ host });
  for (const [path, text] of [
    [join(outside, 'shell-out.txt'), 'from a shell'],
    [join(outside, 'shot.png'), 'png'],
    [join(outside, 'spaced name.txt'), 'with spaces'],
  ]) {
    const { grant, bytes } = await download(service, { kind: 'session', sessionId: 's1', path });
    assert.equal(bytes.toString(), text);
    assert.equal(grant.name, path.split(/[\\/]/).at(-1));
  }
});

test('a path no reply or tool references downloads, as the desktop opens it', async (t) => {
  const { host, outside, project } = fixture(t);
  const service = createFileDownloadService({ host });
  const read = async (path) => (await download(service, { kind: 'session', sessionId: 's1', path })).bytes.toString();
  // Before parity each was refused as `not-linked`.
  assert.equal(await read(join(outside, 'secret.txt')), 'never referenced');
  assert.equal(await read(join(outside, 'prompted.txt')), 'only the user typed it');
  assert.equal(await read(`${join(outside, 'report')}/../secret.txt`), 'never referenced');
  // Relative to the session's folder.
  assert.equal(await read('../outside/secret.txt'), 'never referenced');
  assert.equal(await read(join(project, '..', 'outside', 'shell-out.txt', '..', 'secret.txt')), 'never referenced');
  assert.equal(await read(join(outside, 'report', 'a.txt')), 'A');
  // What is not a file on this PC still is not.
  const ask = (path) =>
    service.authorize(PHONE, { source: { kind: 'session', sessionId: 's1', path }, purpose: 'save' });
  await refusedAs(ask(join(outside, 'missing.txt')), 'not-found');
  await refusedAs(ask(join(outside, 'report')), 'not-a-file');
  await refusedAs(ask('//server/share/file.txt'), 'not-a-file');
});

test('a name that is a symlink downloads what it leads to', async (t) => {
  const { host, outside, links } = fixture(t);
  if (!links) return t.skip('symlinks are unavailable');
  const service = createFileDownloadService({ host });
  // Before parity: refused as `not-linked`.
  const { bytes } = await download(service, { kind: 'session', sessionId: 's1', path: join(outside, 'alias.txt') });
  assert.equal(bytes.toString(), 'never referenced');
});

test("a session's download is not limited to the files that session references", async (t) => {
  const { host, outside } = fixture(t);
  const service = createFileDownloadService({ host });
  const other = join(outside, 'other-session.txt');
  for (const sessionId of ['s1', 's2']) {
    // Before parity s1 was refused as `not-linked`.
    const { bytes } = await download(service, { kind: 'session', sessionId, path: other });
    assert.equal(bytes.toString(), 'belongs to s2', sessionId);
  }
  // The conversation the request names must exist.
  await refusedAs(
    service.authorize(PHONE, { source: { kind: 'session', sessionId: 'nope', path: other }, purpose: 'save' }),
    'unavailable'
  );
});

test('a folder zips on demand whole, git internals included', async (t) => {
  const { host, outside } = fixture(t);
  const service = createFileDownloadService({ host });
  const grant = await service.authorize(PHONE, {
    source: { kind: 'folder', sessionId: 's1', path: join(outside, 'report') },
    purpose: 'save',
  });
  assert.equal(grant.name, 'report.zip');
  assert.equal(grant.mime, 'application/zip');
  assert.deepEqual(grant.leftOut, { ignored: 0, secret: 0 });
  const transfer = await service.begin(PHONE, grant.grantId);
  const chunk = await service.readRange(PHONE, transfer.transferId, 0, transfer.size, transfer.version);
  const zip = await JSZip.loadAsync(Buffer.from(chunk.data, 'base64'));
  // Before parity `.git/config` was left out. A link out of the folder is not
  // part of it (zip-folder.ts).
  assert.deepEqual(Object.keys(zip.files).sort(), ['.git/config', 'a.txt', 'sub/b.txt']);
  assert.equal(await zip.file('.git/config').async('string'), 'git internals');
  await service.finish(PHONE, transfer.transferId);
  // Any folder of any session; a file is no folder.
  const folder = (sessionId, path) =>
    service.authorize(PHONE, { source: { kind: 'folder', sessionId, path }, purpose: 'save' });
  assert.equal((await folder('s1', join(outside, 'report', 'sub'))).name, 'sub.zip');
  assert.equal((await folder('s2', join(outside, 'report'))).name, 'report.zip');
  await refusedAs(folder('s1', join(outside, 'shell-out.txt')), 'not-a-file');
});

function junction(target, path) {
  try {
    symlinkSync(target, path, 'junction');
    return true;
  } catch {
    return false; // the OS refuses links: those cases skip
  }
}

const askFolder = (service, path) =>
  service.authorize(PHONE, { source: { kind: 'folder', sessionId: 's1', path }, purpose: 'save' });

test('a folder reached through an ancestor junction outside the project zips', async (t) => {
  const { host, base, outside } = fixture(t);
  const hop = join(base, 'hop');
  if (!junction(outside, hop)) return t.skip('links are unavailable');
  const service = createFileDownloadService({ host });
  // Before parity: refused as `not-linked` (reached through a link).
  assert.equal((await askFolder(service, join(hop, 'report'))).name, 'report.zip');
});

test('a referenced folder inside the project may not leave it through an ancestor junction', async (t) => {
  const { host, project, outside, transcripts } = fixture(t);
  const hop = join(project, 'hop');
  if (!junction(outside, hop)) return t.skip('links are unavailable');
  const via = join(hop, 'report');
  transcripts.get('s1').items.push({ id: 't9', kind: 'tool', name: 'shell', result: `${slash(via)}/` });
  const service = createFileDownloadService({ host });
  await refusedAs(askFolder(service, via), 'outside-project');
});

test('a referenced folder inside the project zips', async (t) => {
  const { host, project, transcripts } = fixture(t);
  mkdirSync(join(project, 'docs'));
  writeFileSync(join(project, 'docs', 'readme.md'), 'hi');
  transcripts
    .get('s1')
    .items.push({ id: 't9', kind: 'tool', name: 'shell', result: `${slash(join(project, 'docs'))}/` });
  const grant = await createFileDownloadService({ host }).authorize(PHONE, {
    source: { kind: 'folder', sessionId: 's1', path: join(project, 'docs') },
    purpose: 'save',
  });
  assert.equal(grant.name, 'docs.zip');
});

test('an Explorer folder of the conversation project zips whole, a secret-bearing file included', async (t) => {
  const { host, base } = fixture(t);
  const project = join(base, 'project');
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src', 'app.ts'), 'code');
  writeFileSync(join(project, 'src', '.env'), 'TOKEN=1');
  const service = createFileDownloadService({ host });
  const grant = await service.authorize(PHONE, {
    source: { kind: 'folder', sessionId: 's1', path: join(project, 'src') },
    purpose: 'save',
  });
  assert.equal(grant.name, 'src.zip');
  // Before parity `.env` was left out (`secret: 1`).
  assert.deepEqual(grant.leftOut, { ignored: 0, secret: 0 });
  const transfer = await service.begin(PHONE, grant.grantId);
  const chunk = await service.readRange(PHONE, transfer.transferId, 0, transfer.size, transfer.version);
  const zip = await JSZip.loadAsync(Buffer.from(chunk.data, 'base64'));
  assert.equal(await zip.file('app.ts').async('string'), 'code');
  assert.equal(await zip.file('.env').async('string'), 'TOKEN=1');
  await service.finish(PHONE, transfer.transferId);
  // A folder outside the project that nothing references zips too.
  assert.equal((await askFolder(service, join(base, 'task'))).name, 'task.zip');
});

test('temporary folder zips are bounded per device without breaking a transfer in flight', async (t) => {
  const { host, outside } = fixture(t);
  const temp = realpathSync.native(mkdtempSync(join(tmpdir(), 'download-cap-')));
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  Object.assign(process.env, { TMPDIR: temp, TEMP: temp, TMP: temp });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(temp, { recursive: true, force: true });
  });
  const service = createFileDownloadService({ host });
  t.after(() => service.revokeAll());
  const records = () => readdirSync(temp).filter((name) => name.startsWith('mixdog-download-'));
  const report = join(outside, 'report');
  const first = await askFolder(service, report);
  const transfer = await service.begin(PHONE, first.grantId);
  for (let index = 0; index < 12; index += 1) await askFolder(service, report);
  for (let attempt = 0; attempt < 200 && records().length > 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(records().length <= 8, `${records().length} temporary records remain`);
  const chunk = await service.readRange(PHONE, transfer.transferId, 0, transfer.size, transfer.version);
  assert.equal((await JSZip.loadAsync(Buffer.from(chunk.data, 'base64'))).files['a.txt'].dir, false);
  await service.finish(PHONE, transfer.transferId);
});

test('a folder over the size cap says so instead of zipping', async (t) => {
  const { host, outside, transcripts } = fixture(t);
  writeFileSync(join(outside, 'report', 'big.bin'), Buffer.alloc(65 * 1024 * 1024));
  const service = createFileDownloadService({ host });
  const error = await refusedAs(
    service.authorize(PHONE, {
      source: { kind: 'folder', sessionId: 's1', path: join(outside, 'report') },
      purpose: 'save',
    }),
    'folder-too-large'
  );
  assert.ok(transcripts.size);
  // The counted files (`.git/config` among them since parity) and size
  // against the caps, and the way out; no partial zip.
  assert.match(error.message, /has 4 files \(65\.0 MB\)/);
  assert.match(error.message, /limit of 2,000 files and 64\.0 MB/);
  assert.match(error.message, /Pick a subfolder/);
});

test('a folder over the file cap counts only what remains after the exclusions', async (t) => {
  const { host, outside } = fixture(t);
  const many = join(outside, 'report', 'many');
  mkdirSync(many);
  for (let index = 0; index < 2_001; index += 1) writeFileSync(join(many, `f${index}`), '');
  const service = createFileDownloadService({ host });
  const ask = () =>
    service.authorize(PHONE, {
      source: { kind: 'folder', sessionId: 's1', path: join(outside, 'report') },
      purpose: 'save',
    });
  const error = await refusedAs(ask(), 'folder-too-large');
  assert.match(error.message, /has 2,004 files/);
  // The same files under a generated folder are left out, and the zip says so.
  renameSync(many, join(outside, 'report', 'node_modules'));
  const grant = await ask();
  assert.deepEqual(grant.leftOut, { ignored: 2_001, secret: 0 });
});

test('an outside-project HTML page opens through a one-file grant from any session, as on the desktop', async (t) => {
  const { host, outside, base } = fixture(t);
  const html = join(outside, 'page.html');
  const requests = [];
  const methods = createRemoteMethods({
    host: {
      ...host,
      listProjects: async () => [{ path: join(base, 'project'), name: 'project' }],
      invokeDesktopOperation: async (name, args) =>
        name === 'statLocalEntryAbs' ? { absolutePath: args[0], name: 'page.html', dir: false, size: 11 } : null,
    },
    hostRequest: async (method, args) => {
      requests.push([method, args]);
      return 'http://127.0.0.1:9/token/page.html';
    },
    viewedSessionIds: () => ['s1', 's2'],
  });
  const [row] = await methods.resolveLocalPaths([[html], 's1']);
  assert.ok(row.accessToken, 'the page gets a one-file grant');
  assert.equal(
    await methods.localPageUrl([row.projectPath, row.relPath, row.accessToken]),
    'http://127.0.0.1:9/token/page.html'
  );
  // The page server gets exactly the desktop's file-scoped page.
  assert.deepEqual(requests, [['localPageUrl', [outside, 'page.html', 'file']]]);
  // Before parity both were refused: s2 does not reference the page, and
  // nothing references secret.txt.
  const [again] = await methods.resolveLocalPaths([[html], 's2']);
  assert.equal(again.accessToken, row.accessToken);
  assert.ok((await methods.resolveLocalPaths([[join(outside, 'secret.txt')], 's1']))[0].accessToken);
  // A guessed token grants nothing.
  await assert.rejects(methods.localPageUrl([outside, 'secret.txt', 'forged']));
});

test('a path that never answers fails alone after its deadline, leaving no hung call', async (t) => {
  const { host, outside, base } = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const methods = createRemoteMethods({
    host: {
      ...host,
      listProjects: async () => [{ path: join(base, 'project'), name: 'project' }],
      invokeDesktopOperation: () => new Promise(() => {}),
    },
    hostRequest: async () => null,
    viewedSessionIds: () => ['s1'],
  });
  const pending = methods.resolveLocalPaths([[join(outside, 'page.html')], 's1']);
  const settled = assert.rejects(pending, /Timed out|not linked|link/i);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(15_000);
  await settled;
});
