import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { localPageUrl, localVirtualPageUrl, revokeLocalPagesFor } from './local-page-server';
import { openedFileAuthorizationTestHooks } from './opened-file-authorization.ts';
import { sensitivePolicy } from './remote-sensitive-paths.ts';
import { sandboxStorageShimScript } from '../shared/sandbox-storage-shim';

const projectPageUrl = (root, rel) => localPageUrl(root, rel, { scope: 'project', authorize: async () => {} });

function get(url, path, headers = {}) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          type: response.headers['content-type'],
          length: response.headers['content-length'],
          csp: response.headers['content-security-policy'],
          body: Buffer.concat(chunks).toString(),
        })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

async function site(t) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-local-page-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'page.html'), '<p>한글 페이지</p>');
  await writeFile(join(root, 'assets', 'style.css'), 'p{color:red}');
  await writeFile(join(root, '.env'), 'SECRET=1');
  await writeFile(join(root, '.git', 'config.json'), '{}');
  await writeFile(join(root, 'app.ts'), 'export {}');
  return root;
}

test('a page and its relative web assets are served from an unguessable loopback prefix', async (t) => {
  const root = await site(t);
  const url = await projectPageUrl(root, 'page.html');
  const { pathname } = new URL(url);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32}\/page\.html$/);
  const page = await get(url, pathname);
  assert.equal(page.status, 200);
  assert.equal(page.type, 'text/html; charset=utf-8');
  assert.equal(page.body, '<p>한글 페이지</p>');
  const prefix = pathname.slice(0, pathname.lastIndexOf('/'));
  assert.equal((await get(url, `${prefix}/assets/style.css`)).status, 200);
  // A fresh invocation gets independent authority, even for the same page.
  const another = await projectPageUrl(root, 'assets/../page.html');
  assert.notEqual(new URL(another).pathname, pathname);
  assert.equal((await get(another, new URL(another).pathname)).body, page.body);
});

test('newly supported web asset types carry their content type', async (t) => {
  const root = await site(t);
  await writeFile(join(root, 'app.webmanifest'), '{}');
  await writeFile(join(root, 'notes.md'), '# hi');
  await writeFile(join(root, 'model.glb'), 'glb');
  const url = await projectPageUrl(root, 'page.html');
  const { pathname } = new URL(url);
  const prefix = pathname.slice(0, pathname.lastIndexOf('/'));
  assert.equal((await get(url, `${prefix}/app.webmanifest`)).type, 'application/manifest+json; charset=utf-8');
  assert.equal((await get(url, `${prefix}/notes.md`)).type, 'text/markdown; charset=utf-8');
  assert.equal((await get(url, `${prefix}/model.glb`)).type, 'model/gltf-binary');
});

test('nothing outside the root, no dotfiles and no non-web files are served', async (t) => {
  const root = await site(t);
  const url = await projectPageUrl(root, 'page.html');
  const { pathname } = new URL(url);
  const prefix = pathname.slice(0, pathname.lastIndexOf('/'));
  for (const path of [
    `${prefix}/.env`,
    `${prefix}/.git/config.json`,
    `${prefix}/app.ts`,
    `${prefix}/..%2f..%2fpage.html`,
    `${prefix}/missing.html`,
    '/wrong-token/page.html',
  ]) {
    assert.equal((await get(url, path)).status, 404, path);
  }
  // A DNS-rebound name pointing at loopback never reaches the files.
  assert.equal((await get(url, pathname, { host: 'evil.example' })).status, 403);
  await assert.rejects(projectPageUrl(join(root, 'assets'), '../page.html'), /inside its folder/);
});

test('directory links cannot expose hidden or out-of-root files, but public assets still load', async (t) => {
  const root = await site(t);
  const outside = await site(t);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(join(root, '.git'), join(root, 'hidden-link'), linkType);
  await symlink(outside, join(root, 'outside-link'), linkType);
  await symlink(join(root, 'assets'), join(root, 'assets-link'), linkType);
  const url = await projectPageUrl(root, 'page.html');
  const { pathname } = new URL(url);
  const prefix = pathname.slice(0, pathname.lastIndexOf('/'));

  assert.equal((await get(url, `${prefix}/hidden-link/config.json`)).status, 404);
  assert.equal((await get(url, `${prefix}/outside-link/page.html`)).status, 404);
  const asset = await get(url, `${prefix}/assets-link/style.css`);
  assert.equal(asset.status, 200);
  assert.equal(asset.type, 'text/css; charset=utf-8');
  assert.equal(asset.body, 'p{color:red}');
});

test('a selected page outside every Project serves only that page, never its neighbors', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'mixdog-outside-page-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, 'pages'), { recursive: true });
  await mkdir(join(base, 'shared'), { recursive: true });
  await writeFile(join(base, 'pages', 'page.html'), '<p>x</p>');
  await writeFile(join(base, 'pages', 'data.json'), '{"a":1}');
  await writeFile(join(base, 'shared', 'style.css'), 'p{color:blue}');
  const url = await localPageUrl(join(base, 'pages'), 'page.html', { scope: 'file', authorize: async () => {} });
  const { pathname } = new URL(url);
  const dir = pathname.replace(/[^/]+$/, '');
  assert.equal((await get(url, pathname)).status, 200);
  assert.equal((await get(url, `${dir}data.json`)).status, 404);
  assert.equal((await get(url, `${dir}../shared/style.css`)).status, 404);
});

test('a sandboxed single-file page carries the storage shim first, with a matching Content-Length', async (t) => {
  const root = await site(t);
  await writeFile(
    join(root, 'tabs.html'),
    '<!doctype html><html><head><title>탭</title></head><body><script>run()</script></body></html>'
  );
  const url = await localPageUrl(root, 'tabs.html', { scope: 'file', authorize: async () => {} });
  const { pathname } = new URL(url);
  const page = await get(url, pathname);
  assert.equal(page.status, 200);
  assert.equal(page.csp, 'sandbox allow-scripts');
  assert.ok(page.body.includes(sandboxStorageShimScript()));
  assert.ok(page.body.indexOf(sandboxStorageShimScript()) < page.body.indexOf('run()'));
  assert.ok(page.body.includes('<title>탭</title>'));
  assert.equal(Number(page.length), Buffer.byteLength(page.body));
});

test('a lease revoked while its page is being read gets no content', async (t) => {
  const root = await site(t);
  const owner = {};
  const url = await localPageUrl(root, 'page.html', { scope: 'file', authorize: async () => {}, owner });
  const { pathname } = new URL(url);
  const fsp = await import('node:fs/promises');
  const original = fsp.readFile;
  let reads = 0;
  fsp.default.readFile = async (...args) => {
    const data = await original(...args);
    reads += 1;
    revokeLocalPagesFor(owner);
    return data;
  };
  syncBuiltinESMExports();
  t.after(() => {
    fsp.default.readFile = original;
    syncBuiltinESMExports();
  });
  const page = await get(url, pathname);
  assert.equal(reads, 1);
  assert.equal(page.status, 404);
  assert.doesNotMatch(page.body, /한글/);
});

test('a project-scope page is served unchanged, without the storage shim', async (t) => {
  const root = await site(t);
  const url = await projectPageUrl(root, 'page.html');
  const page = await get(url, new URL(url).pathname);
  assert.equal(page.body, '<p>한글 페이지</p>');
  assert.equal(page.csp, undefined);
  assert.equal(Number(page.length), Buffer.byteLength(page.body));
});

test("a paired device's page cannot load a secret-bearing sub-asset, by name or through a link", async (t) => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'mixdog-remote-page-')));
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'mixdog-remote-page-out-')));
  t.after(async () => {
    openedFileAuthorizationTestHooks.beforeOpen = undefined;
    await rm(project, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  });
  for (const dir of ['site', 'site/media', '.ssh', 'private']) await mkdir(join(project, dir), { recursive: true });
  await writeFile(join(project, 'site', 'index.html'), '<link href="app.css"><img src="../private/logo.png">');
  await writeFile(join(project, 'site', 'app.css'), 'p{}');
  await writeFile(join(project, 'site', 'media', 'clip.mp4'), 'clip');
  await writeFile(join(project, '.env'), 'TOKEN=1');
  await writeFile(join(project, '.ssh', 'id_rsa'), 'key');
  await writeFile(join(project, 'private', 'data.json'), '{"token":1}');
  await writeFile(join(project, 'private', 'logo.png'), 'png');
  await writeFile(join(elsewhere, 'clip.mp4'), 'outside');
  let links = true;
  try {
    await symlink(join(project, 'private'), join(project, 'site', 'brand'), 'junction');
  } catch {
    links = false;
  }
  // The authorizing process's deny list names `private` (a registered
  // private root) — the page server's own process never registered it.
  const remote = { ...sensitivePolicy(), registered: [[join(project, 'private'), []]] };
  const asset = (url, rel) => get(url, `${new URL(url).pathname.replace(/[^/]+\/index\.html$/, '')}${rel}`);
  const desktopUrl = await projectPageUrl(project, 'site/index.html');
  const remoteUrl = await localPageUrl(project, 'site/index.html', {
    scope: 'project',
    authorize: async () => {},
    remote,
  });
  // The desktop's own lease is unchanged: it serves what the page references.
  assert.equal((await asset(desktopUrl, 'private/logo.png')).status, 200);
  assert.equal((await asset(remoteUrl, 'site/index.html')).status, 200);
  assert.equal((await asset(remoteUrl, 'site/app.css')).body, 'p{}');
  // Before the fix the remote lease served these exactly like the desktop's.
  for (const rel of ['.env', '.ssh/id_rsa', 'private/data.json', 'private/logo.png', 'site/../private/logo.png']) {
    assert.equal((await asset(remoteUrl, rel)).status, 404, rel);
  }
  if (links) {
    assert.equal((await asset(desktopUrl, 'site/brand/logo.png')).status, 200);
    assert.equal((await asset(remoteUrl, 'site/brand/logo.png')).status, 404, 'a link onto a secret folder');
  }
  // A folder swapped for a link after the path checks: the opened file decides.
  assert.equal((await asset(remoteUrl, 'site/media/clip.mp4')).body, 'clip');
  openedFileAuthorizationTestHooks.beforeOpen = async () => {
    openedFileAuthorizationTestHooks.beforeOpen = undefined;
    await rm(join(project, 'site', 'media'), { recursive: true, force: true });
    await symlink(elsewhere, join(project, 'site', 'media'), 'junction');
  };
  const swapped = await asset(remoteUrl, 'site/media/clip.mp4');
  assert.equal(swapped.status, 404);
  assert.doesNotMatch(swapped.body, /outside/);
  // A remote lease without a valid policy is never minted.
  await assert.rejects(
    localPageUrl(project, 'site/index.html', { scope: 'project', authorize: async () => {}, remote: {} }),
    /policy is invalid/
  );
});

test('a virtual page gets the shim on its html document only, not on other files', async () => {
  const url = await localVirtualPageUrl(
    {
      'index.html': { type: 'text/html; charset=utf-8', body: Buffer.from('<body><script>x()</script></body>') },
      'app.js': { type: 'text/javascript; charset=utf-8', body: Buffer.from('window.a=1') },
    },
    { authorize: async () => {} }
  );
  const { pathname } = new URL(url);
  const page = await get(url, pathname);
  assert.equal(page.csp, 'sandbox allow-scripts');
  assert.ok(page.body.includes(sandboxStorageShimScript()));
  assert.equal(Number(page.length), Buffer.byteLength(page.body));
  const script = await get(url, pathname.replace('index.html', 'app.js'));
  assert.equal(script.body, 'window.a=1');
});
