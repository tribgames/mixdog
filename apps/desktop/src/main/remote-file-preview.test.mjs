import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  createRemoteFilePreviewMethods,
  REMOTE_PREVIEW_MAX_READ_BYTES,
  remoteFilePreviewTestHooks,
  withAuthorizedFile,
} from './remote-file-preview.ts';
import { createRemoteLocalPageMethods } from './remote-local-page.ts';

import { makeTempDirSync, redirectSystemTemp } from '../../../../scripts/lib/scoped-temp.mjs';

redirectSystemTemp('tmp-root');
const root = makeTempDirSync('remote-preview');
mkdirSync(join(root, '.hidden'));
writeFileSync(join(root, 'clip.mp4'), Buffer.from('0123456789'));
writeFileSync(join(root, 'page.html'), '<p>hi</p>');
// A non-web type (`.bin` is a served glTF buffer asset).
writeFileSync(join(root, 'data.sqlite'), 'secret');
writeFileSync(join(root, '.hidden', 'a.css'), 'x');
const outside = makeTempDirSync('remote-preview-out');
writeFileSync(join(outside, 'pic.png'), Buffer.from('png'));

const grants = {
  grantedIf: (token) => typeof token === 'string' && token.length > 0,
  grantedFile: (token, _project, rel) => {
    if (token !== 'ok' || rel !== 'pic.png') throw new Error('The selected-file permission does not match this path.');
    return { root: outside, rel: 'pic.png', absolute: join(outside, 'pic.png') };
  },
};
const methods = createRemoteFilePreviewMethods({ host: { projectDirectory: async () => root }, grants });

test('metadata describes a previewable file without a URL', async () => {
  const meta = await methods.previewProjectFile([root, 'clip.mp4', null]);
  assert.equal(meta.kind, 'video');
  assert.equal(meta.size, 10);
  assert.equal('url' in meta, false);
  await assert.rejects(methods.previewProjectFile([root, 'data.sqlite', null]), /does not support/);
});

test('ranged reads return the requested window as base64 and clamp at EOF', async () => {
  const mid = await methods.previewProjectFileRange([root, 'clip.mp4', null, 2, 3]);
  assert.equal(Buffer.from(mid.data, 'base64').toString(), '234');
  assert.equal(mid.size, 10);
  const tail = await methods.previewProjectFileRange([root, 'clip.mp4', null, 8, 100]);
  assert.equal(Buffer.from(tail.data, 'base64').toString(), '89');
  const past = await methods.previewProjectFileRange([root, 'clip.mp4', null, 50, 4]);
  assert.equal(past.data, '');
});

test('reads are bounded and validated', async () => {
  await assert.rejects(
    methods.previewProjectFileRange([root, 'clip.mp4', null, 0, REMOTE_PREVIEW_MAX_READ_BYTES + 1]),
    /length/
  );
  await assert.rejects(methods.previewProjectFileRange([root, 'clip.mp4', null, -1, 4]), /offset/);
});

test('paths outside the project, hidden files and non-web files are refused', async () => {
  await assert.rejects(methods.previewProjectFileRange([root, '../x.png', null, 0, 4]), /outside the project/);
  await assert.rejects(methods.previewProjectFileRange([root, '.hidden/a.css', null, 0, 4]), /does not support/);
  await assert.rejects(methods.previewProjectFileRange([root, 'data.sqlite', null, 0, 4]), /does not support/);
  const page = await methods.previewProjectFileRange([root, 'page.html', null, 0, 100]);
  assert.equal(page.mime, 'text/html; charset=utf-8');
});

test('a folder swapped for a link between the checks and the open is judged by where the open file really is', async (t) => {
  const project = realpathSync(makeTempDirSync('remote-preview-race'));
  const elsewhere = realpathSync(makeTempDirSync('remote-preview-race-out'));
  t.after(() => {
    remoteFilePreviewTestHooks.beforeOpen = undefined;
    rmSync(project, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });
  mkdirSync(join(project, 'media'));
  writeFileSync(join(project, 'media', 'clip.mp4'), 'project clip');
  mkdirSync(join(project, '.ssh'));
  writeFileSync(join(project, '.ssh', 'clip.mp4'), 'private key');
  writeFileSync(join(elsewhere, 'clip.mp4'), 'outside bytes');
  const snapshots = [];
  const raced = createRemoteFilePreviewMethods({
    host: { projectDirectory: async () => project },
    grants,
    hostRequest: async (method, args) => snapshots.push([method, args]),
  });
  /** Swaps `media` for a junction to `target` once the path passed its checks. */
  const swapTo = (target) => {
    remoteFilePreviewTestHooks.beforeOpen = () => {
      remoteFilePreviewTestHooks.beforeOpen = undefined;
      rmSync(join(project, 'media'), { recursive: true, force: true });
      symlinkSync(target, join(project, 'media'), 'junction');
    };
  };
  const restore = () => {
    rmSync(join(project, 'media'), { recursive: true, force: true });
    mkdirSync(join(project, 'media'));
    writeFileSync(join(project, 'media', 'clip.mp4'), 'project clip');
  };
  const ok = await raced.previewProjectFileRange([project, 'media/clip.mp4', null, 0, 64]);
  assert.equal(Buffer.from(ok.data, 'base64').toString(), 'project clip');
  // The desktop's project boundary, held at the open: before the fix these
  // read the bytes the swapped-in link led to.
  swapTo(elsewhere);
  await assert.rejects(raced.previewProjectFileRange([project, 'media/clip.mp4', null, 0, 64]), /outside the project/);
  restore();
  swapTo(elsewhere);
  await assert.rejects(raced.previewProjectFile([project, 'media/clip.mp4', null]), /outside the project/);
  restore();
  // A link to another folder of the same project stays inside it: served, as
  // the desktop serves it (before parity: refused as a secret-bearing `.ssh`).
  swapTo(join(project, '.ssh'));
  const inProject = await raced.previewProjectFileRange([project, 'media/clip.mp4', null, 0, 64]);
  assert.equal(Buffer.from(inProject.data, 'base64').toString(), 'private key');
  restore();
  // A snapshot is captured the way the desktop handler captures it: the
  // project file, with its project (before parity: a private copy, alone).
  await raced.captureFileSnapshot([project, 'media/clip.mp4', null]);
  await raced.captureFileSnapshot([outside, 'pic.png', 'ok']);
  assert.deepEqual(snapshots, [
    ['captureFileSnapshot', [project, 'media/clip.mp4', false]],
    ['captureFileSnapshot', [outside, 'pic.png', true]],
  ]);
});

test('a local page is handed to the page server as the desktop handler hands it', async (t) => {
  const project = realpathSync(makeTempDirSync('remote-page'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, 'site'));
  writeFileSync(join(project, 'site', 'index.html'), '<p>site</p>');
  const requests = [];
  const pages = createRemoteLocalPageMethods({
    host: { projectDirectory: async () => project },
    grants,
    hostRequest: async (method, args) => {
      requests.push([method, args]);
      return 'http://127.0.0.1:9/page';
    },
  });
  assert.equal(await pages.localPageUrl([project, 'site/index.html', null]), 'http://127.0.0.1:9/page');
  assert.equal(await pages.localPageUrl([outside, 'pic.png', 'ok']), 'http://127.0.0.1:9/page');
  // Before parity a project page also carried the remote deny policy.
  assert.deepEqual(requests, [
    ['localPageUrl', [project, 'site/index.html', 'project']],
    ['localPageUrl', [outside, 'pic.png', 'file']],
  ]);
  await assert.rejects(pages.localPageUrl([project, '../index.html', null]), /outside the project/);
  assert.equal(requests.length, 2);
});

test('a selected-file grant reads exactly its file and nothing else', async () => {
  const ok = await methods.previewProjectFileRange([resolve(outside), 'pic.png', 'ok', 0, 10]);
  assert.equal(Buffer.from(ok.data, 'base64').toString(), 'png');
  await assert.rejects(methods.previewProjectFileRange([outside, 'other.png', 'ok', 0, 10]), /permission/);
  await assert.rejects(methods.previewProjectFileRange([outside, 'pic.png', 'bad', 0, 10]), /permission/);
});

test('private copies live in one mkdtemp root, never a predictable pid-named folder', async () => {
  const dir = makeTempDirSync('remote-preview-root');
  writeFileSync(join(dir, 'a.txt'), 'one');
  writeFileSync(join(dir, 'b.txt'), 'two');
  try {
    const locate = (name) => withAuthorizedFile(join(dir, name), dir, ({ location }) => location);
    const [first, second] = [await locate('a.txt'), await locate('b.txt')];
    const privateRoot = dirname(dirname(first));
    assert.equal(dirname(dirname(second)), privateRoot);
    assert.equal(dirname(privateRoot), tmpdir());
    assert.match(basename(privateRoot), /^mixdog-authorized-copies-[A-Za-z0-9]{6}$/);
    assert.notEqual(basename(privateRoot), `mixdog-authorized-copies-${process.pid}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent previews of equal content under different names keep their own inputs', async () => {
  const dir = makeTempDirSync('remote-preview-twin');
  const when = new Date(1_700_000_000_000);
  for (const name of ['a.txt', 'b.txt']) {
    writeFileSync(join(dir, name), 'same bytes');
    utimesSync(join(dir, name), when, when);
  }
  try {
    let bStarted;
    const started = new Promise((resolveStarted) => (bStarted = resolveStarted));
    const first = withAuthorizedFile(join(dir, 'a.txt'), dir, async () => {
      await started;
    });
    // b is still using its input after a, which shared a's content and mtime, is done.
    const second = withAuthorizedFile(join(dir, 'b.txt'), dir, async ({ location }) => {
      bStarted();
      await first;
      return existsSync(location);
    });
    assert.equal(await second, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
