import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localPageUrl } from './local-page-server';

const projectPageUrl = (root, rel) => localPageUrl(root, rel, { scope: 'project', authorize: async () => {} });

function get(url, path, headers = {}) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, headers }, (response) => {
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
