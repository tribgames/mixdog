import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { mkdir, mkdtemp, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import * as pages from './local-page-server.ts';
import { registerProjectFileIpc } from './ipc-project-files.ts';
import { LocalAccessDeniedError } from './local-access-denied.ts';
import { DESKTOP_IPC } from '../shared/contract';

// Exercise the real registrar and HTTP server. Only its existing authority
// boundaries (project registry, selected-file grant, renderer lifecycle) are
// injected. Requests use real temp files; no model, browser or external network.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-preview-permission-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, 'assets'));
  const files = {
    'page.html': '<script>globalThis.previewLoaded = true</script><p>선택한 페이지</p>',
    'other.htm': '<p>another selected page</p>',
    'private.csv': 'private,data',
    'private.json': '{"private":true}',
    'assets/style.css': 'p { color: red; }',
    'assets/app.js': 'globalThis.loaded = true;',
    'assets/app.js.map': '{}',
    'assets/font.woff2': 'font fixture',
    'assets/picture.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    '.hidden.html': 'hidden HTML',
    '.env': 'SECRET=fixture',
  };
  for (const [path, body] of Object.entries(files)) await writeFile(join(root, path), body);
  return { root, files };
}

function get(url, path = new URL(url).pathname, { method = 'GET', headers = {} } = {}) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

const pathFor = (url, path) => `/${new URL(url).pathname.split('/')[1]}/${path}`;
function owner() {
  const sender = new EventEmitter();
  sender.closed = false;
  sender.isDestroyed = () => sender.closed;
  sender.close = () => { sender.closed = true; sender.emit('destroyed'); };
  return sender;
}

function harness(t, root) {
  const handlers = new Map();
  const sender = owner();
  t.after(() => sender.close());
  const authority = { project: root, granted: join(root, 'page.html'), projectCalls: 0, grantCalls: 0 };
  registerProjectFileIpc({
    app: {}, shell: {},
    handle: (name, run) => handlers.set(name, run),
    invokeDesktopOperation: async () => { throw new Error('preview must not dispatch a file mutation'); },
    host: {
      async projectDirectory(path) {
        authority.projectCalls++;
        if (authority.projectError) throw authority.projectError;
        if (path !== root || !authority.project) throw new LocalAccessDeniedError('project is not registered');
        return authority.project;
      },
    },
    async grantedFile(token, project, rel) {
      authority.grantCalls++;
      if (authority.grantError) throw authority.grantError;
      if (token !== 'selected-secret-token' || project !== root || rel !== basename(authority.granted || '')) {
        throw new LocalAccessDeniedError('private grant diagnostic');
      }
      return { root: dirname(authority.granted), rel: basename(authority.granted), absolute: authority.granted };
    },
  });
  return {
    authority, sender,
    url: (token, rel = 'page.html', from = sender) =>
      handlers.get(DESKTOP_IPC.localPageUrl)({ sender: from }, root, rel, token, { scope: 'project' }),
  };
}

function direct(t, root, rel = 'page.html', options = {}) {
  const identity = options.owner ?? {};
  t.after(() => pages.revokeLocalPagesFor?.(identity));
  return pages.localPageUrl(root, rel, { scope: 'file', authorize: async () => {}, owner: identity, ...options });
}

test('selected-file IPC serves only the selected HTML, never neighboring assets or data', async (t) => {
  const { root, files } = await fixture(t);
  const h = harness(t, root);
  const url = await h.url('selected-secret-token');
  const response = await get(url);
  assert.equal(response.status, 200);
  assert.equal(response.body, files['page.html']);
  assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(h.authority.projectCalls, 0, 'a selected grant must not ask for broader project authority');
  assert.ok(!url.includes('selected-secret-token'));
  for (const path of Object.keys(files).filter((file) => file !== 'page.html')) {
    assert.equal((await get(url, pathFor(url, path))).status, 404, path);
  }
});

test('registered-project IPC retains relative styles, scripts, fonts, media and data', async (t) => {
  const { root, files } = await fixture(t);
  const h = harness(t, root);
  const url = await h.url(undefined);
  for (const path of Object.keys(files).filter((file) => !file.startsWith('.'))) {
    const response = await get(url, pathFor(url, path));
    assert.equal(response.status, 200, path);
    assert.equal(response.body, files[path], path);
  }
  assert.equal(h.authority.grantCalls, 0);
  assert.equal((await get(url)).headers['content-security-policy'], undefined);
});

for (const projectFirst of [false, true]) {
  test(`file and project URLs do not share or widen authority (project first: ${projectFirst})`, async (t) => {
    const { root } = await fixture(t);
    const h = harness(t, root);
    const urls = [];
    for (const token of projectFirst ? [undefined, 'selected-secret-token'] : ['selected-secret-token', undefined]) {
      urls.push(await h.url(token));
    }
    const [file, project] = projectFirst ? urls.reverse() : urls;
    assert.notEqual(file, project);
    assert.equal((await get(project, pathFor(project, 'private.csv'))).status, 200);
    assert.equal((await get(file, pathFor(file, 'private.csv'))).status, 404);
  });
}

test('two individually selected pages never share their file allowlists', async (t) => {
  const { root } = await fixture(t);
  const first = await direct(t, root);
  const second = await direct(t, root, 'other.htm');
  assert.notEqual(new URL(first).pathname.split('/')[1], new URL(second).pathname.split('/')[1]);
  assert.equal((await get(first, pathFor(first, 'other.htm'))).status, 404);
  assert.equal((await get(second, pathFor(second, 'page.html'))).status, 404);
  assert.equal((await get(second)).status, 200);
});

test('selected HTML uses an opaque script-enabled sandbox and non-caching headers', async (t) => {
  const { root } = await fixture(t);
  const response = await get(await direct(t, root));
  assert.equal(response.headers['content-security-policy'], 'sandbox allow-scripts');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
});

test('invalid or expired file tokens never fall back to a registered project', async (t) => {
  const { root } = await fixture(t);
  const h = harness(t, root);
  for (const token of ['wrong', 123, {}, null, ' '.repeat(4)]) await assert.rejects(h.url(token));
  h.authority.granted = null;
  await assert.rejects(h.url('selected-secret-token'));
  assert.equal(h.authority.projectCalls, 0);
});

test('omitting a file token cannot authorize an unregistered parent directory', async (t) => {
  const { root } = await fixture(t);
  const h = harness(t, root);
  h.authority.project = null;
  await assert.rejects(h.url(undefined), /not registered/);
  const url = await h.url('selected-secret-token');
  assert.equal((await get(url)).status, 200);
});

test('selected grant revocation invalidates an issued URL without exposing diagnostic text', async (t) => {
  const { root } = await fixture(t);
  const h = harness(t, root);
  const url = await h.url('selected-secret-token');
  h.authority.granted = null;
  const response = await get(url);
  assert.equal(response.status, 404);
  assert.equal(response.body, '404');
  h.authority.granted = join(root, 'page.html');
  assert.equal((await get(url)).status, 404, 'a failed lease must not revive');
  assert.equal((await get(await h.url('selected-secret-token'))).status, 200);
});

test('project removal revokes its assets and re-registration does not revive that URL', async (t) => {
  const { root } = await fixture(t);
  const h = harness(t, root);
  const url = await h.url(undefined);
  h.authority.project = null;
  assert.equal((await get(url, pathFor(url, 'private.json'))).status, 404);
  h.authority.project = root;
  assert.equal((await get(url)).status, 404);
});

test('a changed project registry root cannot redirect an existing URL', async (t) => {
  const { root } = await fixture(t);
  const other = await fixture(t);
  const h = harness(t, root);
  const url = await h.url(undefined);
  h.authority.project = other.root;
  assert.equal((await get(url)).status, 404);
});

test('closing one renderer revokes its URLs without affecting another owner', async (t) => {
  const { root } = await fixture(t);
  const h = harness(t, root);
  const other = owner();
  t.after(() => other.close());
  const first = await h.url(undefined);
  const second = await h.url('selected-secret-token');
  const independent = await h.url('selected-secret-token', 'page.html', other);
  assert.equal(h.sender.listenerCount('destroyed'), 1);
  h.sender.close();
  assert.equal((await get(first)).status, 404);
  assert.equal((await get(second)).status, 404);
  assert.equal((await get(independent)).status, 200);
  await assert.rejects(h.url(undefined), /owner is closed/);
});

test('lease expiry is absolute rather than extended by HTTP traffic', async (t) => {
  const { root } = await fixture(t);
  const started = Date.now();
  t.mock.method(Date, 'now', () => started);
  const url = await direct(t, root);
  Date.now.mock.mockImplementation(() => started + pages.LOCAL_PAGE_TTL_MS - 1);
  assert.equal((await get(url)).status, 200);
  Date.now.mock.mockImplementation(() => started + pages.LOCAL_PAGE_TTL_MS);
  assert.equal((await get(url)).status, 404);
  assert.equal((await get(await direct(t, root))).status, 200);
});

for (const method of ['GET', 'HEAD']) {
  test(`the bounded lease table refreshes LRU on authorized ${method}, not issuance order`, async (t) => {
    const { root } = await fixture(t);
    const identity = {};
    t.after(() => pages.revokeLocalPagesFor(identity));
    const access = { scope: 'file', owner: identity, authorize: async () => {} };
    const urls = [];
    for (let i = 0; i < pages.MAX_LOCAL_PAGE_LEASES; i++) {
      urls.push(await pages.localPageUrl(root, 'page.html', access));
    }
    assert.equal((await get(urls[0], undefined, { method })).status, 200);
    const newest = await pages.localPageUrl(root, 'page.html', access);
    assert.equal((await get(urls[0])).status, 200, 'a recently used old URL survives');
    assert.equal((await get(urls[1])).status, 404, 'the least recently used URL is evicted');
    assert.equal((await get(newest)).status, 200);
    assert.equal((await get(newest, pathFor(newest, 'private.csv'))).status, 404);
  });
}

test('denied paths and transient authorization errors cannot refresh LRU', async (t) => {
  const { root } = await fixture(t);
  const identity = {};
  t.after(() => pages.revokeLocalPagesFor(identity));
  let busy = false;
  const oldest = await pages.localPageUrl(root, 'page.html', {
    scope: 'file', owner: identity,
    async authorize() { if (busy) throw new Error('temporary daemon failure'); },
  });
  const access = { scope: 'file', owner: identity, authorize: async () => {} };
  for (let i = 1; i < pages.MAX_LOCAL_PAGE_LEASES; i++) await pages.localPageUrl(root, 'page.html', access);
  assert.equal((await get(oldest, pathFor(oldest, 'private.csv'))).status, 404);
  assert.equal((await get(oldest, pathFor(oldest, '%zz'))).status, 400);
  assert.equal((await get(oldest, undefined, { method: 'POST' })).status, 405);
  assert.equal((await get(oldest, undefined, { headers: { host: 'evil.example' } })).status, 403);
  busy = true;
  assert.equal((await get(oldest)).status, 503);
  await pages.localPageUrl(root, 'page.html', access);
  busy = false;
  assert.equal((await get(oldest)).status, 404);
});

for (const cause of ['expiry', 'owner closure', 'capacity eviction']) {
  for (const fails of [false, true]) {
    test(`authorization ${fails ? 'failure' : 'success'} after ${cause} cannot revive the lease`, { timeout: 10000 }, async (t) => {
      const { root } = await fixture(t);
      const identity = {};
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      let pause = false;
      const url = await direct(t, root, 'page.html', {
        owner: identity,
        async authorize() {
          if (pause) {
            entered.resolve();
            await release.promise;
            if (fails) throw new Error('late timeout');
          }
        },
      });
      pause = true;
      const pending = get(url);
      await entered.promise;
      try {
        if (cause === 'expiry') {
          const expired = Date.now() + pages.LOCAL_PAGE_TTL_MS;
          t.mock.method(Date, 'now', () => expired);
        } else if (cause === 'owner closure') pages.revokeLocalPagesFor(identity);
        else {
          for (let i = 0; i < pages.MAX_LOCAL_PAGE_LEASES; i++) {
            await direct(t, root, 'page.html', { owner: identity });
          }
        }
      } finally { release.resolve(); }
      assert.equal((await pending).status, 404);
      assert.equal((await get(url)).status, 404);
    });
  }
}

test('a closed renderer during URL creation cannot publish a usable lease', { timeout: 5000 }, async (t) => {
  const { root } = await fixture(t);
  const h = harness(t, root);
  const pending = h.url('selected-secret-token');
  h.sender.close();
  await assert.rejects(pending, /owner is closed/);
});

test('policy object mutation cannot widen a file lease or replace its authorizer', async (t) => {
  const { root } = await fixture(t);
  let enabled = true;
  const access = { scope: 'file', async authorize() { if (!enabled) throw new LocalAccessDeniedError('revoked'); } };
  const url = await pages.localPageUrl(root, 'page.html', access);
  access.scope = 'project';
  access.authorize = async () => {};
  assert.equal((await get(url, pathFor(url, 'private.json'))).status, 404);
  enabled = false;
  assert.equal((await get(url)).status, 404);
});

test('replacing the selected file in place preserves valid preview access', async (t) => {
  const { root } = await fixture(t);
  const url = await direct(t, root);
  await writeFile(join(root, 'replacement.tmp'), '<p>updated</p>');
  await rename(join(root, 'replacement.tmp'), join(root, 'page.html'));
  assert.equal((await get(url)).body, '<p>updated</p>');
});

test('retargeting a selected directory alias invalidates the pinned preview', async (t) => {
  const { root } = await fixture(t);
  const other = await fixture(t);
  const alias = join(root, 'alias');
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(other.root, alias, kind);
  const url = await direct(t, alias);
  await unlink(alias);
  await symlink(root, alias, kind);
  assert.equal((await get(url)).status, 404);
});

test('a selected page alias is pinned and cannot change to another allowed HTML file', async (t) => {
  const { root } = await fixture(t);
  const alias = join(root, 'alias.html');
  try { await symlink(join(root, 'page.html'), alias, 'file'); }
  catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Windows file symlink privilege unavailable'); return;
  }
  const url = await direct(t, root, 'alias.html');
  await unlink(alias);
  await symlink(join(root, 'other.htm'), alias, 'file');
  assert.equal((await get(url)).status, 404);
});

test('hidden HTML and a visible alias into hidden HTML cannot acquire a lease', async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(direct(t, root, '.hidden.html'), /visible HTML/);
  await mkdir(join(root, '.private'));
  await writeFile(join(root, '.private/page.html'), 'secret');
  await symlink(join(root, '.private'), join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(direct(t, root, 'alias/page.html'), /visible HTML/);
});

test('HEAD, malformed encoding, host checks and denied methods preserve the same boundary', async (t) => {
  const { root } = await fixture(t);
  const url = await direct(t, root);
  const head = await get(url, undefined, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal((await get(url, pathFor(url, 'private.csv'), { method: 'HEAD' })).status, 404);
  assert.equal((await get(url, pathFor(url, '%zz'))).status, 400);
  assert.equal((await get(url, undefined, { method: 'POST' })).status, 405);
  assert.equal((await get(url, undefined, { headers: { host: 'evil.example' } })).status, 403);
  for (const path of ['..%2fprivate.csv', 'assets%2fstyle.css', '%2ehidden.html', 'other.htm']) {
    assert.equal((await get(url, pathFor(url, path))).status, 404, path);
  }
});

test('the server requires explicit permission and only mints HTML preview entries', async (t) => {
  const { root } = await fixture(t);
  for (const access of [undefined, {}, { scope: 'project' }, { scope: 'all', authorize: async () => {} }]) {
    await assert.rejects(pages.localPageUrl(root, 'page.html', access), /explicit local-page permission/);
  }
  await assert.rejects(direct(t, root, 'private.json'), /visible HTML/);
  // No scratch files, copies or rewritten HTML are created by this feature.
  assert.ok(!(await readdir(root)).some((name) => name.includes('preview')));
});

for (const token of ['selected-secret-token', undefined]) {
  test(`${token ? 'file' : 'project'} lookup failures return 503 and preserve the same preview URL`, async (t) => {
    const { root } = await fixture(t);
    const h = harness(t, root);
    const url = await h.url(token);
    const key = token ? 'grantError' : 'projectError';
    for (const error of [
      Object.assign(new Error('private timeout diagnostic'), { code: 'ETIMEDOUT' }),
      Object.assign(new Error('private filesystem diagnostic'), { code: 'EACCES' }),
      // Denial-like prose from an unknown/older producer is not proof.
      new Error('Project is not available.'),
    ]) {
      h.authority[key] = error;
      const response = await get(url);
      assert.equal(response.status, 503);
      assert.equal(response.body, '503');
      assert.equal(response.headers['cache-control'], 'no-store');
      h.authority[key] = null;
      assert.equal((await get(url)).status, 200, 'recovery must not require a new URL');
    }
    if (token) assert.equal(h.authority.projectCalls, 0, 'failure must not widen file authority');
  });
}

test('an explicit denial survives the desktop-service error envelope without parsing its message', async (t) => {
  const { root } = await fixture(t);
  const h = harness(t, root);
  const url = await h.url(undefined);
  const denial = new LocalAccessDeniedError('not for the page to see');
  // The service transports name/message/code, not an Error prototype.
  h.authority.projectError = Object.assign(new Error('changed diagnostic wording'),
    JSON.parse(JSON.stringify({ code: denial.code })));
  assert.equal((await get(url)).status, 404);
  h.authority.projectError = null;
  assert.equal((await get(url)).status, 404, 'a definite denial stays revoked after recovery');
});

test('a transient realpath failure keeps the pinned URL, while later retargeting revokes it', async (t) => {
  const { root } = await fixture(t);
  const other = await fixture(t);
  const alias = join(root, 'alias');
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(other.root, alias, kind);
  const url = await direct(t, alias);
  await unlink(alias);
  assert.equal((await get(url)).status, 503, 'the canonical file exists but its authority lookup is unavailable');
  await symlink(other.root, alias, kind);
  assert.equal((await get(url)).status, 200);
  await unlink(alias);
  await symlink(root, alias, kind);
  assert.equal((await get(url)).status, 404);
  await unlink(alias);
  await symlink(other.root, alias, kind);
  assert.equal((await get(url)).status, 404, 'restoring a denied alias must not revive its old URL');
});

test('a parallel definite denial wins over an older successful authorization', { timeout: 5000 }, async (t) => {
  const { root } = await fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let mode = 'ready';
  const url = await direct(t, root, 'page.html', {
    async authorize() {
      if (mode === 'wait') { entered.resolve(); await release.promise; }
      else if (mode === 'deny') throw new LocalAccessDeniedError('revoked');
    },
  });
  mode = 'wait';
  const pending = get(url);
  await entered.promise;
  try {
    mode = 'deny';
    assert.equal((await get(url)).status, 404);
  } finally { release.resolve(); }
  assert.equal((await pending).status, 404);
  mode = 'ready';
  assert.equal((await get(url)).status, 404);
});
