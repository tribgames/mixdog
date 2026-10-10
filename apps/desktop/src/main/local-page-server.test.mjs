import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localPageUrl } from './local-page-server';

// Connects to loopback directly; the Host header carries the page origin.
function get(url, path, headers = {}, hostname = '127.0.0.1') {
  const { host, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, headers: { host, ...headers } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode, type: response.headers['content-type'], body: Buffer.concat(chunks).toString() })
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

test('a page and its web assets are served from an unguessable per-root origin', async (t) => {
  const root = await site(t);
  const url = await localPageUrl(root, 'page.html');
  const { pathname } = new URL(url);
  assert.match(url, /^http:\/\/[0-9a-f]{48}\.localhost:\d+\/page\.html$/);
  const page = await get(url, pathname);
  assert.equal(page.status, 200);
  assert.equal(page.type, 'text/html; charset=utf-8');
  assert.equal(page.body, '<p>한글 페이지</p>');
  assert.equal((await get(url, '/assets/style.css')).status, 200);
  // The same root keeps one origin.
  assert.equal(new URL(await localPageUrl(root, 'assets/../page.html')).origin, new URL(url).origin);
});

test('root-absolute paths resolve under the root, and roots get different origins', async (t) => {
  const root = await site(t);
  const other = await site(t);
  const url = await localPageUrl(root, 'page.html');
  const otherUrl = await localPageUrl(other, 'page.html');
  assert.notEqual(new URL(url).host.split(':')[0], new URL(otherUrl).host.split(':')[0]);
  const asset = await get(url, '/assets/style.css');
  assert.equal(asset.status, 200);
  assert.equal(asset.body, 'p{color:red}');
});

test('a Host other than the root origin is refused', async (t) => {
  const root = await site(t);
  const url = await localPageUrl(root, 'page.html');
  const { host, port } = new URL(url);
  for (const bad of ['evil.example', `127.0.0.1:${port}`, `${host}.evil.example`, `localhost:${port}`, host.replace(':', 'x:')]) {
    assert.equal((await get(url, '/page.html', { host: bad })).status, 403, bad);
  }
});

test('newly supported web asset types carry their content type', async (t) => {
  const root = await site(t);
  await writeFile(join(root, 'app.webmanifest'), '{}');
  await writeFile(join(root, 'notes.md'), '# hi');
  const url = await localPageUrl(root, 'page.html');
  assert.equal((await get(url, '/app.webmanifest')).type, 'application/manifest+json; charset=utf-8');
  assert.equal((await get(url, '/notes.md')).type, 'text/markdown; charset=utf-8');
});

test('the origin is reachable over both IPv4 and IPv6 loopback', async (t) => {
  const root = await site(t);
  const url = await localPageUrl(root, 'page.html');
  assert.equal((await get(url, '/page.html')).status, 200);
  const v6 = await get(url, '/page.html', {}, '::1').catch((error) => (error.code === 'EADDRNOTAVAIL' ? null : Promise.reject(error)));
  if (v6) assert.equal(v6.status, 200);
});

test('nothing outside the root, no dotfiles and no non-web files are served', async (t) => {
  const root = await site(t);
  const url = await localPageUrl(root, 'page.html');
  for (const path of ['/.env', '/.git/config.json', '/app.ts', '/..%2f..%2fpage.html', '/missing.html']) {
    assert.equal((await get(url, path)).status, 404, path);
  }
  // An unknown root token is not found.
  assert.equal((await get(url, '/page.html', { host: new URL(url).host.replace(/^./, (c) => (c === '0' ? '1' : '0')) })).status, 404);
  // A DNS-rebound name pointing at loopback never reaches the files.
  assert.equal((await get(url, '/page.html', { host: 'evil.example' })).status, 403);
  await assert.rejects(localPageUrl(join(root, 'assets'), '../page.html'), /inside its folder/);
});

test('directory links cannot expose hidden or out-of-root files, but public assets still load', async (t) => {
  const root = await site(t);
  const outside = await site(t);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(join(root, '.git'), join(root, 'hidden-link'), linkType);
  await symlink(outside, join(root, 'outside-link'), linkType);
  await symlink(join(root, 'assets'), join(root, 'assets-link'), linkType);
  const url = await localPageUrl(root, 'page.html');

  assert.equal((await get(url, '/hidden-link/config.json')).status, 404);
  assert.equal((await get(url, '/outside-link/page.html')).status, 404);
  const asset = await get(url, '/assets-link/style.css');
  assert.equal(asset.status, 200);
  assert.equal(asset.type, 'text/css; charset=utf-8');
  assert.equal(asset.body, 'p{color:red}');
});

test('a page outside every Project reaches presentation assets on its drive, data only in its own folder', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'mixdog-outside-page-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, 'pages', 'sub'), { recursive: true });
  await mkdir(join(base, 'pages', '.hid'), { recursive: true });
  await mkdir(join(base, 'shared', '.hid'), { recursive: true });
  await writeFile(join(base, 'pages', 'page.html'), '<p>x</p>');
  await writeFile(join(base, 'pages', 'data.json'), '{"a":1}');
  await writeFile(join(base, 'pages', 'sub', 'note.txt'), 'note');
  await writeFile(join(base, 'pages', '.hid', 'x.css'), 'p{}');
  await writeFile(join(base, 'shared', 'style.css'), 'p{color:blue}');
  await writeFile(join(base, 'shared', 'img.png'), 'png');
  await writeFile(join(base, 'shared', 'secret.json'), '{}');
  await writeFile(join(base, 'shared', 'readme.txt'), 'no');
  await writeFile(join(base, 'shared', '.hid', 'x.css'), 'p{}');
  const url = await localPageUrl(join(base, 'pages'), 'page.html', true);
  const dir = new URL(url).pathname.replace(/[^/]+$/, '');
  const page = await get(url, `${dir}page.html`);
  assert.equal(page.status, 200);
  assert.equal((await get(url, `${dir}../shared/style.css`)).body, 'p{color:blue}');
  assert.equal((await get(url, `${dir}../shared/img.png`)).type, 'image/png');
  assert.equal((await get(url, `${dir}data.json`)).status, 200);
  assert.equal((await get(url, `${dir}sub/note.txt`)).type, 'text/plain; charset=utf-8');
  assert.equal((await get(url, `${dir}../shared/secret.json`)).status, 404);
  assert.equal((await get(url, `${dir}../shared/readme.txt`)).status, 404);
  assert.equal((await get(url, `${dir}.hid/x.css`)).status, 404);
  assert.equal((await get(url, `${dir}../shared/.hid/x.css`)).status, 404);
  // A different data folder is a different origin.
  const other = await localPageUrl(join(base, 'shared'), 'style.css', true);
  assert.notEqual(new URL(other).host, new URL(url).host);
});