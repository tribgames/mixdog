// Session-scoped grants: a paired device may open/download files OUTSIDE every
// project when THIS session's transcript references them or its tools produced
// them (sessionReferencedPaths), and folders as an on-demand zip — never a
// path of another session, an unreferenced path, a traversal or a symlink to
// an unreferenced target.
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
import { sensitivePolicy } from './remote-sensitive-paths.ts';
import { createLinkProvenance, referencedPathFor, sessionReferencedPaths } from './transcript-file-links.ts';

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
          tool('t4', 'shell', { result: slash(join(outside, 'report')) + '/' }),
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

test('an unreferenced path, a user-typed path, a traversal and a sibling are refused', async (t) => {
  const { host, outside, project } = fixture(t);
  const service = createFileDownloadService({ host });
  const ask = (path) =>
    service.authorize(PHONE, { source: { kind: 'session', sessionId: 's1', path }, purpose: 'save' });
  await refusedAs(ask(join(outside, 'secret.txt')), 'not-linked');
  await refusedAs(ask(join(outside, 'prompted.txt')), 'not-linked');
  // Traversal out of a referenced name, and a relative guess from the session folder.
  await refusedAs(ask(`${join(outside, 'report')}/../secret.txt`), 'not-linked');
  await refusedAs(ask('../outside/secret.txt'), 'not-linked');
  await refusedAs(ask(join(project, '..', 'outside', 'shell-out.txt', '..', 'secret.txt')), 'not-linked');
  // A file inside a referenced folder is not itself referenced.
  await refusedAs(ask(join(outside, 'report', 'a.txt')), 'not-linked');
  await refusedAs(ask('/etc/passwd'), 'not-linked');
});

test('a referenced name that is a symlink to an unreferenced file is refused', async (t) => {
  const { host, outside, links } = fixture(t);
  if (!links) return t.skip('symlinks are unavailable');
  const service = createFileDownloadService({ host });
  await refusedAs(
    service.authorize(PHONE, {
      source: { kind: 'session', sessionId: 's1', path: join(outside, 'alias.txt') },
      purpose: 'save',
    }),
    'not-linked'
  );
});

test("one session's grant never reaches another session's files", async (t) => {
  const { host, outside } = fixture(t);
  const service = createFileDownloadService({ host });
  const other = join(outside, 'other-session.txt');
  assert.equal(
    (await download(service, { kind: 'session', sessionId: 's2', path: other })).bytes.toString(),
    'belongs to s2'
  );
  await refusedAs(
    service.authorize(PHONE, { source: { kind: 'session', sessionId: 's1', path: other }, purpose: 'save' }),
    'not-linked'
  );
  await refusedAs(
    service.authorize(PHONE, { source: { kind: 'session', sessionId: 'nope', path: other }, purpose: 'save' }),
    'unavailable'
  );
});

test('a referenced folder zips on demand without links or git internals', async (t) => {
  const { host, outside } = fixture(t);
  const service = createFileDownloadService({ host });
  const grant = await service.authorize(PHONE, {
    source: { kind: 'folder', sessionId: 's1', path: join(outside, 'report') },
    purpose: 'save',
  });
  assert.equal(grant.name, 'report.zip');
  assert.equal(grant.mime, 'application/zip');
  const transfer = await service.begin(PHONE, grant.grantId);
  const chunk = await service.readRange(PHONE, transfer.transferId, 0, transfer.size, transfer.version);
  const zip = await JSZip.loadAsync(Buffer.from(chunk.data, 'base64'));
  assert.deepEqual(Object.keys(zip.files).sort(), ['a.txt', 'sub/b.txt']);
  assert.equal(await zip.file('sub/b.txt').async('string'), 'B');
  await service.finish(PHONE, transfer.transferId);
  // Not referenced, a file, or another session's: refused.
  const folder = (sessionId, path) =>
    service.authorize(PHONE, { source: { kind: 'folder', sessionId, path }, purpose: 'save' });
  await refusedAs(folder('s1', join(outside, 'report', 'sub')), 'not-linked');
  await refusedAs(folder('s2', join(outside, 'report')), 'not-linked');
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

test('a referenced folder reached through an ancestor junction outside the project is refused', async (t) => {
  const { host, base, outside, transcripts } = fixture(t);
  const hop = join(base, 'hop');
  if (!junction(outside, hop)) return t.skip('links are unavailable');
  const via = join(hop, 'report');
  transcripts.get('s1').items.push({ id: 't9', kind: 'tool', name: 'shell', result: `${slash(via)}/` });
  const service = createFileDownloadService({ host });
  await refusedAs(askFolder(service, via), 'not-linked');
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

test('an Explorer folder of the conversation project zips without a reply naming it, minus secrets', async (t) => {
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
  assert.deepEqual(grant.leftOut, { ignored: 0, secret: 1 });
  const transfer = await service.begin(PHONE, grant.grantId);
  const chunk = await service.readRange(PHONE, transfer.transferId, 0, transfer.size, transfer.version);
  const zip = await JSZip.loadAsync(Buffer.from(chunk.data, 'base64'));
  assert.equal(await zip.file('app.ts').async('string'), 'code');
  assert.equal(zip.file('.env'), null);
  await service.finish(PHONE, transfer.transferId);
  // A folder outside the project that nothing references is still refused.
  await refusedAs(askFolder(service, join(base, 'task')), 'not-linked');
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
  // The counted files and size against the caps, and the way out; no partial zip.
  assert.match(error.message, /has 3 files \(65\.0 MB\)/);
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
  assert.match(error.message, /has 2,003 files/);
  // The same files under a generated folder are left out, and the zip says so.
  renameSync(many, join(outside, 'report', 'node_modules'));
  const grant = await ask();
  assert.deepEqual(grant.leftOut, { ignored: 2_001, secret: 0 });
});

test('the referenced set covers tool rows, ignores prompts, and matches exactly', (t) => {
  const { host, outside, project, transcripts } = fixture(t);
  const snapshot = transcripts.get('s1');
  const paths = sessionReferencedPaths(snapshot, project);
  assert.ok(paths.some((path) => path.endsWith('shell-out.txt')));
  assert.ok(!paths.some((path) => path.endsWith('prompted.txt')));
  assert.equal(referencedPathFor(snapshot, project, join(outside, 'secret.txt')), null);
  assert.equal(referencedPathFor(snapshot, project, `${join(outside, 'shell-out.txt')}\0`), null);
  assert.ok(host);
});

test('an outside-project HTML page opens through a session-scoped preview grant, never across sessions', async (t) => {
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
  assert.ok(row.accessToken, 'the referenced page gets a session grant');
  assert.equal(
    await methods.localPageUrl([row.projectPath, row.relPath, row.accessToken]),
    'http://127.0.0.1:9/token/page.html'
  );
  // The page server also gets the deny policy it applies to every asset.
  assert.deepEqual(requests, [['localPageUrl', [outside, 'page.html', 'file', sensitivePolicy()]]]);
  // The same file asked in the name of a session that does not reference it.
  await assert.rejects(methods.resolveLocalPaths([[html], 's2']), /not linked|NOT_LINKED|link/i);
  await assert.rejects(methods.resolveLocalPaths([[join(outside, 'secret.txt')], 's1']));
  // A guessed token grants nothing.
  await assert.rejects(methods.localPageUrl([outside, 'secret.txt', 'forged']));
  assert.ok(createLinkProvenance);
});
