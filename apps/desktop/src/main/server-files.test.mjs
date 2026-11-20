// Server-window file lanes: uploads into the server's staging folder, ranged
// previews and downloads, the server trash, and what stays gated.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_IPC } from '../shared/contract.ts';
import { connectionFeatureGate } from './connections/feature-gates.ts';
import {
  createServerDownloads,
  createServerFilePreviews,
  ServerFileGrants,
  serverByteStream,
  serverCoreInvoke,
} from './server-file-access.ts';

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

function fakeCore(answers) {
  const calls = [];
  return {
    calls,
    core: {
      call: async (method, params) => {
        calls.push([method, params]);
        return answers[method]?.(params);
      },
    },
  };
}

test("a download is this PC's core's: the window's server id and this PC's download folder go with every begin", async () => {
  const { core, calls } = fakeCore({
    'transfer/serverDownload/begin': () => ({ downloadId: 'd1', name: 'a.bin', size: 10 }),
    'transfer/serverDownload/step': () => ({ received: 10, size: 10, done: true }),
    'transfer/serverDownload/finish': () => ({ path: '/dl/a.bin' }),
    'transfer/serverDownload/abort': () => true,
  });
  const downloads = createServerDownloads({
    core: serverCoreInvoke(core),
    serverId: 'srv-1',
    downloadsDir: () => '/dl',
  });
  assert.deepEqual(await downloads.begin('/srv', 'x/a.bin'), { downloadId: 'd1', name: 'a.bin', size: 10 });
  assert.deepEqual(await downloads.step('d1'), { received: 10, size: 10, done: true });
  assert.deepEqual(await downloads.finish('d1'), { path: '/dl/a.bin' });
  assert.equal(await downloads.abort('d1'), true);
  assert.deepEqual(calls, [
    ['transfer/serverDownload/begin', { serverId: 'srv-1', downloadsDir: '/dl', root: '/srv', rel: 'x/a.bin' }],
    ['transfer/serverDownload/step', { downloadId: 'd1' }],
    ['transfer/serverDownload/finish', { downloadId: 'd1' }],
    ['transfer/serverDownload/abort', { downloadId: 'd1' }],
  ]);
});

test('a download the core refuses, or answers wrongly, is an error and holds nothing', async () => {
  const refused = fakeCore({
    'transfer/serverDownload/begin': () => {
      throw new Error('This SSH server is not connected. Connect it from the SSH server dialog.');
    },
  });
  const downloads = createServerDownloads({
    core: serverCoreInvoke(refused.core),
    serverId: 'srv-1',
    downloadsDir: () => '/dl',
  });
  await assert.rejects(downloads.begin('/srv', 'a'), /not connected/);
  for (const answer of [null, 'x', { downloadId: 1, name: 'a', size: 1 }, { downloadId: 'd', name: 'a' }]) {
    const wrong = fakeCore({ 'transfer/serverDownload/begin': () => answer });
    const guarded = createServerDownloads({
      core: serverCoreInvoke(wrong.core),
      serverId: 's',
      downloadsDir: () => '/dl',
    });
    await assert.rejects(guarded.begin('/srv', 'a'), TypeError, JSON.stringify(answer));
    await guarded.dispose();
    assert.deepEqual(
      wrong.calls.map(([method]) => method),
      ['transfer/serverDownload/begin']
    );
  }
  await assert.rejects(
    createServerDownloads({ core: serverCoreInvoke(null), serverId: 's', downloadsDir: () => '/dl' }).begin(
      '/srv',
      'a'
    ),
    /not available/
  );
});

test('closing the window cancels the downloads still open and only those', async () => {
  let next = 0;
  const { core, calls } = fakeCore({
    'transfer/serverDownload/begin': () => ({ downloadId: `d${++next}`, name: 'a', size: 1 }),
    'transfer/serverDownload/finish': () => ({ path: '/dl/a' }),
    'transfer/serverDownload/abort': () => true,
  });
  const downloads = createServerDownloads({ core: serverCoreInvoke(core), serverId: 's', downloadsDir: () => '/dl' });
  await downloads.begin('/srv', 'a');
  await downloads.begin('/srv', 'b');
  await downloads.finish('d1');
  calls.length = 0;
  await downloads.dispose();
  assert.deepEqual(calls, [['transfer/serverDownload/abort', { downloadId: 'd2' }]]);
});

test('only a file the core finished downloading may be opened', async () => {
  const { core, calls } = fakeCore({ 'transfer/serverDownload/check': ({ path }) => path === '/dl/a.bin' });
  const downloads = createServerDownloads({ core: serverCoreInvoke(core), serverId: 's', downloadsDir: () => '/dl' });
  assert.equal(await downloads.requireDownloaded('/dl/a.bin'), '/dl/a.bin');
  await assert.rejects(downloads.requireDownloaded('/dl/other.bin'), /Only a file downloaded from the server/);
  await assert.rejects(downloads.requireDownloaded(42), /Only a file downloaded from the server/);
  assert.equal(calls.length, 2, 'a value that is no path is refused without asking');
});

test('described server entries take their name from the path and validated metadata', async () => {
  const grants = (info) => new ServerFileGrants(hostile({ statLocalEntryAbs: info }).invoke, async () => []);
  const [row] = await grants({ name: '../../evil', dir: false, size: 3 }).describe(['/tmp/a.png']);
  assert.equal(row.name, 'a.png');
  for (const info of [{ dir: 'no', size: 3 }, { dir: false, size: -3 }, { dir: false, size: 1.5 }, null]) {
    await assert.rejects(grants(info).describe(['/tmp/a.png']), /invalid response/, JSON.stringify(info));
  }
});

test('a converted server preview whose file the cache evicted is converted again once, under the same URL', async () => {
  const handlers = new Map();
  const session = {
    protocol: {
      handle: (scheme, handler) => handlers.set(scheme, handler),
      unhandle: (scheme) => handlers.delete(scheme),
      isProtocolHandled: (scheme) => handlers.has(scheme),
    },
  };
  const present = new Set(['/cache/a.pdf']);
  const invoke = async (name, [root, rel]) => {
    assert.equal(name, 'statProjectFileIn');
    if (!present.has(`${root}/${rel}`)) throw new Error('ENOENT');
    return { size: 5, mtimeMs: 1 };
  };
  let conversions = 0;
  const regenerate = async () => {
    conversions += 1;
    await new Promise((done) => setTimeout(done, 20));
    present.add('/cache/b.pdf');
    return { path: '/cache/b.pdf', mtimeMs: 1, size: 5 };
  };
  const previews = createServerFilePreviews({ session, invoke });
  const { url } = previews.register('/cache', 'a.pdf', '1:5', { regenerate });
  const head = (headers) => handlers.get('mixdog-media')(new Request(url, { method: 'HEAD', headers }));
  const before = await head();
  assert.equal(before.status, 200);
  present.delete('/cache/a.pdf');
  const replies = await Promise.all([head(), head(), head()]);
  assert.deepEqual(
    replies.map((reply) => reply.status),
    [200, 200, 200]
  );
  assert.equal(conversions, 1);
  // The regenerated file is another representation: its validator differs, so the old one is neither continued nor revalidated.
  const etag = replies[0].headers.get('etag');
  assert.notEqual(etag, before.headers.get('etag'));
  assert.equal(replies[0].headers.get('cache-control'), 'private, no-cache');
  assert.equal((await head({ range: 'bytes=1-2', 'if-range': before.headers.get('etag') })).status, 200);
  assert.equal((await head({ range: 'bytes=1-2', 'if-range': etag })).status, 206);
  assert.equal((await head({ 'if-none-match': before.headers.get('etag') })).status, 200);
  assert.equal((await head({ 'if-none-match': etag })).status, 304);
  const plain = previews.register('/cache', 'gone.pdf', 'v1');
  assert.equal((await handlers.get('mixdog-media')(new Request(plain.url, { method: 'HEAD' }))).status, 404);
  previews.dispose();
});

test('reads whose misses arrive one after another convert once, and a source saved since is not served under the old URL', async () => {
  const handlers = new Map();
  const session = {
    protocol: {
      handle: (scheme, handler) => handlers.set(scheme, handler),
      unhandle: (scheme) => handlers.delete(scheme),
      isProtocolHandled: (scheme) => handlers.has(scheme),
    },
  };
  const present = new Set();
  const staleStats = [];
  const invoke = async (_name, [root, rel]) => {
    if (present.has(`${root}/${rel}`)) return { size: 5, mtimeMs: 1 };
    // Each miss of the old file fails when the test lets it, so one can land after the conversion finished.
    await new Promise((done) => staleStats.push(done));
    throw new Error('ENOENT');
  };
  let conversions = 0;
  const converted = { mtimeMs: 1, size: 5 };
  const previews = createServerFilePreviews({ session, invoke });
  const { url } = previews.register('/cache', 'a.pdf', '1:5', {
    regenerate: async () => {
      conversions += 1;
      present.add('/cache/a.pdf');
      return { path: '/cache/a.pdf', ...converted };
    },
  });
  const head = () => handlers.get('mixdog-media')(new Request(url, { method: 'HEAD' }));
  const first = head();
  const second = head();
  await new Promise((done) => setTimeout(done, 5));
  assert.equal(staleStats.length, 2);
  staleStats[0]();
  assert.equal((await first).status, 200);
  staleStats[1]();
  assert.equal((await second).status, 200);
  assert.equal(conversions, 1);

  // A source saved since the token was made: the cache holds another revision, which is another document.
  present.clear();
  converted.mtimeMs = 2;
  const third = head();
  await new Promise((done) => setTimeout(done, 5));
  staleStats[2]();
  assert.equal((await third).status, 404);
  assert.equal(conversions, 2);
  previews.dispose();
});

test('a delayed successful stat of the replaced file is not served as the size of the regenerated one', async () => {
  const handlers = new Map();
  const session = {
    protocol: {
      handle: (scheme, handler) => handlers.set(scheme, handler),
      unhandle: (scheme) => handlers.delete(scheme),
      isProtocolHandled: (scheme) => handlers.has(scheme),
    },
  };
  let releaseOld;
  let calls = 0;
  const invoke = async (_name, [root, rel]) => {
    calls += 1;
    if (calls === 1) {
      // Reader A: the old file answers, but late.
      await new Promise((done) => (releaseOld = done));
      return { size: 5, mtimeMs: 1 };
    }
    if (`${root}/${rel}` === '/cache/a.pdf') throw new Error('ENOENT');
    return { size: 22, mtimeMs: 1 };
  };
  const previews = createServerFilePreviews({ session, invoke });
  const { url } = previews.register('/cache', 'a.pdf', '1:5', {
    regenerate: async () => ({ path: '/cache/b.pdf', mtimeMs: 1, size: 5 }),
  });
  const head = () => handlers.get('mixdog-media')(new Request(url, { method: 'HEAD' }));
  const delayed = head();
  await new Promise((done) => setTimeout(done, 5));
  const regenerated = await head();
  assert.equal(regenerated.headers.get('content-length'), '22');
  releaseOld();
  const late = await delayed;
  assert.equal(late.headers.get('content-length'), '22');
  assert.equal(late.headers.get('etag'), regenerated.headers.get('etag'));
  previews.dispose();
});

test('a slow reader follows any number of regenerations by others and is never answered 404 for them', async () => {
  const handlers = new Map();
  const session = {
    protocol: {
      handle: (scheme, handler) => handlers.set(scheme, handler),
      unhandle: (scheme) => handlers.delete(scheme),
      isProtocolHandled: (scheme) => handlers.has(scheme),
    },
  };
  const present = new Set(['/cache/a.pdf']);
  let holdNext = false;
  let release = () => {};
  const invoke = async (_name, [root, rel]) => {
    if (holdNext) {
      holdNext = false;
      await new Promise((done) => (release = done));
      return { size: 7, mtimeMs: 1 };
    }
    if (!present.has(`${root}/${rel}`)) throw new Error('ENOENT');
    return { size: 5, mtimeMs: 1 };
  };
  let conversions = 0;
  const previews = createServerFilePreviews({ session, invoke });
  const { url } = previews.register('/cache', 'a.pdf', '1:5', {
    regenerate: async () => {
      conversions += 1;
      present.add(`/cache/g${conversions}.pdf`);
      return { path: `/cache/g${conversions}.pdf`, mtimeMs: 1, size: 5 };
    },
  });
  const head = () => handlers.get('mixdog-media')(new Request(url, { method: 'HEAD' }));
  holdNext = true;
  const slow = head();
  await new Promise((done) => setTimeout(done, 5));
  for (let advance = 1; advance <= 4; advance += 1) {
    // Another reader finds the file evicted and regenerates; then the slow reader's pending stat, now outdated, is let go
    // and its next stat is held again.
    present.clear();
    assert.equal((await head()).status, 200);
    holdNext = true;
    release();
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.equal(conversions, 4);
  holdNext = false;
  release();
  const answer = await slow;
  assert.equal(answer.status, 200);
  assert.match(answer.headers.get('etag'), /\.4-server-7"$/);
  assert.equal(conversions, 4, "following others' regenerations converts nothing itself");
  previews.dispose();
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
