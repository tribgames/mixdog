import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localPageUrl, localVirtualPageUrl, revokeLocalPagesFor } from './local-page-server';
import { openedFileAuthorizationTestHooks } from './opened-file-authorization';
import { sandboxStorageShimScript } from '../shared/sandbox-storage-shim';

const linkType = process.platform === 'win32' ? 'junction' : 'dir';

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
  await writeFile(join(root, 'model.bin'), 'buffers');
  const url = await projectPageUrl(root, 'page.html');
  const { pathname } = new URL(url);
  const prefix = pathname.slice(0, pathname.lastIndexOf('/'));
  assert.equal((await get(url, `${prefix}/app.webmanifest`)).type, 'application/manifest+json; charset=utf-8');
  assert.equal((await get(url, `${prefix}/notes.md`)).type, 'text/markdown; charset=utf-8');
  assert.equal((await get(url, `${prefix}/model.glb`)).type, 'model/gltf-binary');
  // A .gltf model's separate buffers.
  assert.equal((await get(url, `${prefix}/model.bin`)).type, 'application/octet-stream');
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
  // The page is read through the handle it opened; wrap that read.
  const probe = await open(join(root, 'page.html'));
  const handles = Object.getPrototypeOf(probe);
  await probe.close();
  const original = handles.readFile;
  let reads = 0;
  handles.readFile = async function readFile(...args) {
    const data = await original.apply(this, args);
    reads += 1;
    revokeLocalPagesFor(owner);
    return data;
  };
  t.after(() => {
    handles.readFile = original;
  });
  const page = await get(url, pathname);
  assert.equal(reads, 1);
  assert.equal(page.status, 404);
  assert.doesNotMatch(page.body, /한글/);
});

/** A project with `docs/secret.css` and, outside it, another `secret.css`. */
async function swappable(t) {
  const root = await site(t);
  const outside = await mkdtemp(join(tmpdir(), 'mixdog-local-page-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'secret.css'), 'INSIDE');
  await writeFile(join(outside, 'secret.css'), 'OUTSIDE');
  return { root, outside };
}

/** Replaces the folder `dir` by a link to `outside`. */
async function swapForLink(dir, outside) {
  await rename(dir, `${dir}-moved`);
  await symlink(outside, dir, linkType);
}

test('a folder swapped for a link while the request is authorized cannot serve an outside file', async (t) => {
  const { root, outside } = await swappable(t);
  let swap = false;
  const url = await localPageUrl(root, 'page.html', {
    scope: 'project',
    authorize: async () => {
      if (!swap) return;
      swap = false;
      // Windows refuses to rename a folder holding an open file, which also
      // stops the swap; elsewhere the swap happens. Either way the file served
      // is the one already open.
      await swapForLink(join(root, 'docs'), outside).catch(() => undefined);
    },
  });
  const { pathname } = new URL(url);
  const prefix = pathname.slice(0, pathname.lastIndexOf('/'));
  swap = true;
  const asset = await get(url, `${prefix}/docs/secret.css`);
  assert.equal(swap, false, 'the folder swap was attempted during authorization');
  assert.equal(asset.status, 200);
  assert.equal(asset.body, 'INSIDE');
});

test('a folder swapped for a link between the containment check and the open serves nothing outside', async (t) => {
  const { root, outside } = await swappable(t);
  const url = await projectPageUrl(root, 'page.html');
  const { pathname } = new URL(url);
  const prefix = pathname.slice(0, pathname.lastIndexOf('/'));
  let swapped = false;
  openedFileAuthorizationTestHooks.beforeOpen = async () => {
    swapped = true;
    await swapForLink(join(root, 'docs'), outside);
  };
  t.after(() => {
    delete openedFileAuthorizationTestHooks.beforeOpen;
  });
  const asset = await get(url, `${prefix}/docs/secret.css`);
  assert.equal(swapped, true, 'the folder was swapped before the open');
  assert.equal(asset.status, 404);
  assert.doesNotMatch(asset.body, /OUTSIDE/);
});

test('a sandboxed page is rewritten from the file it opened, not from what later sits at its path', async (t) => {
  const root = await site(t);
  let swap = false;
  const url = await localPageUrl(root, 'page.html', {
    scope: 'file',
    authorize: async () => {
      if (!swap) return;
      swap = false;
      await rename(join(root, 'page.html'), join(root, 'page-moved.html'));
      await writeFile(join(root, 'page.html'), '<p>REPLACED</p>');
    },
  });
  swap = true;
  const page = await get(url, new URL(url).pathname);
  assert.equal(swap, false, 'the page was replaced during authorization');
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('한글 페이지'));
  assert.doesNotMatch(page.body, /REPLACED/);
  assert.equal(Number(page.length), Buffer.byteLength(page.body));
});

test('a client that disconnects mid-stream gets its file handle closed exactly once', async (t) => {
  const root = await site(t);
  // Far larger than the socket buffers, so the stream is still reading when the client leaves.
  await writeFile(join(root, 'big.css'), Buffer.alloc(32 * 1024 * 1024, 'a'));
  const url = await projectPageUrl(root, 'page.html');
  const { hostname, port, pathname } = new URL(url);
  const prefix = pathname.slice(0, pathname.lastIndexOf('/'));

  const probe = await open(join(root, 'page.html'));
  const handles = Object.getPrototypeOf(probe);
  await probe.close();
  const original = handles.createReadStream;
  let closes = 0;
  let closeSettled;
  const settled = new Promise((resolve) => {
    closeSettled = resolve;
  });
  let served;
  handles.createReadStream = function createReadStream(...args) {
    served = this;
    this.on('close', () => {
      closes += 1;
      closeSettled();
    });
    return original.apply(this, args);
  };
  t.after(() => {
    handles.createReadStream = original;
  });

  await new Promise((resolve) => {
    const req = request({ hostname, port, path: `${prefix}/big.css` }, (response) => {
      response.once('data', () => req.destroy());
    });
    req.on('error', () => {});
    req.on('close', resolve);
    req.end();
  });
  await settled;
  assert.equal(closes, 1);
  assert.equal(served.fd, -1);
});

test('a project-scope page is served unchanged, without the storage shim', async (t) => {
  const root = await site(t);
  const url = await projectPageUrl(root, 'page.html');
  const page = await get(url, new URL(url).pathname);
  assert.equal(page.body, '<p>한글 페이지</p>');
  assert.equal(page.csp, undefined);
  assert.equal(Number(page.length), Buffer.byteLength(page.body));
});

test("a paired device's page lease serves exactly what the desktop's serves", async (t) => {
  const project = await realpath(await mkdtemp(join(tmpdir(), 'mixdog-remote-page-')));
  t.after(() => rm(project, { recursive: true, force: true }));
  for (const dir of ['site', '.ssh', 'private']) await mkdir(join(project, dir), { recursive: true });
  await writeFile(join(project, 'site', 'index.html'), '<link href="app.css"><img src="../private/logo.png">');
  await writeFile(join(project, 'site', 'app.css'), 'p{}');
  await writeFile(join(project, '.env'), 'TOKEN=1');
  await writeFile(join(project, '.ssh', 'id_rsa'), 'key');
  await writeFile(join(project, 'private', 'data.json'), '{"token":1}');
  await writeFile(join(project, 'private', 'logo.png'), 'png');
  let links = true;
  try {
    await symlink(join(project, 'private'), join(project, 'site', 'brand'), 'junction');
  } catch {
    links = false;
  }
  const asset = (url, rel) => get(url, `${new URL(url).pathname.replace(/[^/]+\/index\.html$/, '')}${rel}`);
  const desktopUrl = await projectPageUrl(project, 'site/index.html');
  // The lease the window mints for a paired device's page (index.ts): before
  // parity it carried the remote deny list and refused `private/…` assets.
  const remoteUrl = await localPageUrl(project, 'site/index.html', { scope: 'project', authorize: async () => {} });
  const rels = ['site/index.html', 'site/app.css', 'private/data.json', 'private/logo.png', '.env', '.ssh/id_rsa'];
  if (links) rels.push('site/brand/logo.png');
  for (const rel of rels) {
    const [desktop, remote] = [await asset(desktopUrl, rel), await asset(remoteUrl, rel)];
    assert.deepEqual([remote.status, remote.body], [desktop.status, desktop.body], rel);
  }
  // The desktop's own rules, on both: web assets served, hidden files not.
  assert.equal((await asset(remoteUrl, 'private/logo.png')).status, 200);
  assert.equal((await asset(remoteUrl, '.env')).status, 404);
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
