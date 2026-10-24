// Host downloads (file-downloads.ts): a paired device downloads what the
// desktop can open, under the desktop's project boundary; every grant is
// bound to the device, the session, the opened file and its version, and
// consumed exactly once.
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FILE_DOWNLOAD_GRANT_TTL_MS,
  FILE_DOWNLOAD_LEASE_IDLE_MS,
  FILE_DOWNLOAD_LEASE_MAX_MS,
  FILE_DOWNLOAD_MAX_BYTES,
  FILE_DOWNLOAD_RANGE_MAX_BYTES,
  fileDownloadErrorReason,
} from '../shared/file-downloads.ts';
import { createFileDownloadService, fileDownloadRemoteMethods, fileDownloadTestHooks } from './file-downloads.ts';
import { createRemoteMethods, executeRemoteFrame } from './remote-methods.ts';
import { createRelayClientLifecycle } from './remote-relay-client-lifecycle.ts';
import { createRelayClientRegistry } from './remote-relay-clients.ts';
import { generateRelayE2EEServerIdentity, relayE2EEPairingMaterial } from '../shared/remote-e2ee.ts';

const PHONE = { deviceId: 'phone-credential' };
const OTHER = { deviceId: 'tablet-credential' };
const slash = (path) => path.replace(/\\/g, '/');

const refusedAs = async (promise, reason) => {
  const error = await promise.then(
    () => null,
    (failure) => failure
  );
  assert.ok(error, `expected a ${reason} refusal`);
  assert.equal(fileDownloadErrorReason(error), reason, String(error?.message));
};

/** Installs a test seam for the rest of the test. */
function hook(t, name, fn) {
  fileDownloadTestHooks[name] = fn;
  t.after(() => {
    delete fileDownloadTestHooks[name];
  });
}

async function closed(handle) {
  for (let attempt = 0; attempt < 200 && handle.fd !== -1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return handle.fd === -1;
}

function fixture(t, { mediaLane = false } = {}) {
  // The native form (no 8.3 short names): what the host's project paths use.
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'file-downloads-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const projectA = join(base, 'project-a');
  const projectB = join(base, 'project-b');
  const outside = join(base, 'outside');
  const media = join(base, 'media');
  const task = join(base, 'task');
  for (const dir of [projectA, projectB, outside, media, task, join(projectA, 'sub')]) mkdirSync(dir);
  writeFileSync(join(projectA, 'out.bin'), Buffer.from('0123456789abcdef'));
  writeFileSync(join(projectA, 'empty.bin'), '');
  writeFileSync(join(projectA, 'sub', 'deep.txt'), 'deep');
  writeFileSync(join(projectB, 'b.txt'), 'project b');
  writeFileSync(join(outside, 'linked.bin'), 'linked bytes');
  writeFileSync(join(outside, 'rel.bin'), 'relative bytes');
  writeFileSync(join(outside, 'secret.txt'), 'host secret');
  writeFileSync(join(outside, 'other.bin'), 'other session');
  writeFileSync(join(media, 'asset.png'), 'png bytes');
  writeFileSync(join(media, 'other.png'), 'other session png');
  const mediaRow = (id, assetId, output) => ({
    id,
    kind: 'tool',
    name: 'media',
    args: { action: 'generate', kind: 'image' },
    status: 'done',
    done: true,
    result: JSON.stringify({ ok: true, status: 'done', assetId, output }),
  });
  const sessions = [
    { id: 's1', cwd: projectA, projectPath: projectA, classification: 'project' },
    { id: 's2', cwd: projectB, projectPath: projectB, classification: 'project' },
    { id: 't1', cwd: task, projectPath: null, classification: 'task' },
  ];
  const transcripts = new Map([
    [
      's1',
      {
        items: [
          { id: 'u1', kind: 'user', text: `[secret](${slash(join(outside, 'secret.txt'))})` },
          { id: 'tool1', kind: 'tool', name: 'shell', result: slash(join(outside, 'secret.txt')) },
          {
            id: 'a1',
            kind: 'assistant',
            text: [
              `Saved [linked.bin](${slash(join(outside, 'linked.bin'))}).`,
              'Also `../outside/rel.bin` and sub/deep.txt:3.',
              '```',
              slash(join(outside, 'secret.txt')),
              '```',
            ].join('\n'),
          },
          { id: 'a2', kind: 'assistant', streaming: true, text: slash(join(outside, 'secret.txt')) },
          mediaRow('m1', 'asset-1', slash(join(projectA, 'asset.png'))),
          // A prompt naming another session's asset generates nothing.
          { id: 'u2', kind: 'user', text: '{"ok":true,"status":"done","assetId":"asset-2"}' },
        ],
      },
    ],
    [
      's2',
      {
        items: [
          { id: 'b1', kind: 'assistant', text: `Wrote ${slash(join(outside, 'other.bin'))}` },
          mediaRow('m2', 'asset-2', slash(join(projectB, 'other.png'))),
        ],
      },
    ],
    ['t1', { items: [] }],
  ]);
  const clock = { value: 1_800_000_000_000 };
  const host = {
    listSessions: async () => sessions,
    projectDirectory: async (path) => {
      if (path !== projectA && path !== projectB) throw new Error('Project is not registered.');
      return path;
    },
    readSessionTranscript: async (id) => transcripts.get(id) ?? null,
    invokeCapability: async (capability, [assetId]) => {
      assert.equal(capability, 'resolveMediaFile');
      const files = { 'asset-1': 'asset.png', 'asset-2': 'other.png' };
      return {
        value: files[assetId] ? { path: join(media, files[assetId]), mime: 'image/png', available: true } : null,
      };
    },
  };
  const service = createFileDownloadService({ host, mediaLane, now: () => clock.value });
  t.after(() => service.revokeAll());
  const project = (relPath, sessionId = 's1') => ({ source: { kind: 'project', sessionId, relPath }, purpose: 'save' });
  const link = (itemId, href, sessionId = 's1') => ({
    source: { kind: 'link', sessionId, itemId, href },
    purpose: 'share',
  });
  return { base, projectA, projectB, outside, transcripts, clock, host, service, project, link };
}

async function readAll(service, requester, transfer) {
  const parts = [];
  for (let offset = 0; ; ) {
    const chunk = await service.readRange(requester, transfer.transferId, offset, 5, transfer.version);
    parts.push(Buffer.from(chunk.data, 'base64'));
    offset += chunk.length;
    if (chunk.eof) break;
  }
  return Buffer.concat(parts).toString();
}

test('a project file is authorized, consumed into one lease, read in ranges and finished', async (t) => {
  const f = fixture(t);
  const grant = await f.service.authorize(PHONE, f.project('out.bin'));
  assert.equal(grant.name, 'out.bin');
  assert.equal(grant.size, 16);
  assert.equal(grant.mime, 'application/octet-stream');
  assert.match(grant.version, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(grant.expiresAt, f.clock.value + FILE_DOWNLOAD_GRANT_TTL_MS);
  const transfer = await f.service.begin(PHONE, grant.grantId);
  assert.equal(transfer.rangeMaxBytes, FILE_DOWNLOAD_RANGE_MAX_BYTES);
  assert.equal(transfer.media, undefined, 'no media lease until the media lane serves them');
  assert.equal(await readAll(f.service, PHONE, transfer), '0123456789abcdef');
  // A retry of an earlier window inside the lease is fine.
  const again = await f.service.readRange(PHONE, transfer.transferId, 2, 3, transfer.version);
  assert.equal(Buffer.from(again.data, 'base64').toString(), '234');
  assert.deepEqual(await f.service.finish(PHONE, transfer.transferId), {
    transferId: transfer.transferId,
    size: 16,
    version: grant.version,
  });
  await refusedAs(f.service.readRange(PHONE, transfer.transferId, 0, 4, transfer.version), 'expired');
});

test('a zero-byte file downloads as an empty, finished transfer', async (t) => {
  const f = fixture(t);
  const grant = await f.service.authorize(PHONE, f.project('empty.bin'));
  assert.equal(grant.size, 0);
  const transfer = await f.service.begin(PHONE, grant.grantId);
  const chunk = await f.service.readRange(PHONE, transfer.transferId, 0, 1, transfer.version);
  assert.deepEqual([chunk.length, chunk.data, chunk.eof], [0, '', true]);
  assert.equal((await f.service.finish(PHONE, transfer.transferId)).size, 0);
});

test('exactly 256 MiB is allowed and one byte more is refused as too large', async (t) => {
  const f = fixture(t);
  const big = join(f.projectA, 'big.bin');
  writeFileSync(big, '');
  truncateSync(big, FILE_DOWNLOAD_MAX_BYTES);
  const grant = await f.service.authorize(PHONE, f.project('big.bin'));
  assert.equal(grant.size, FILE_DOWNLOAD_MAX_BYTES);
  const transfer = await f.service.begin(PHONE, grant.grantId);
  const tail = await f.service.readRange(
    PHONE,
    transfer.transferId,
    FILE_DOWNLOAD_MAX_BYTES - 4,
    FILE_DOWNLOAD_RANGE_MAX_BYTES,
    transfer.version
  );
  assert.deepEqual([tail.length, tail.eof], [4, true]);
  await f.service.finish(PHONE, transfer.transferId);
  truncateSync(big, FILE_DOWNLOAD_MAX_BYTES + 1);
  await refusedAs(f.service.authorize(PHONE, f.project('big.bin')), 'too-large');
  rmSync(big, { force: true });
});

test('assistant-linked files outside the project are downloadable by the link the row wrote', async (t) => {
  const f = fixture(t);
  const absolute = await f.service.authorize(PHONE, f.link('a1', slash(join(f.outside, 'linked.bin'))));
  assert.equal(absolute.name, 'linked.bin');
  const relative = await f.service.authorize(PHONE, f.link('a1', '../outside/rel.bin'));
  assert.equal(relative.size, 'relative bytes'.length);
  const located = await f.service.authorize(PHONE, f.link('a1', 'sub/deep.txt:3'));
  assert.equal(located.name, 'deep.txt');
  const transfer = await f.service.begin(PHONE, absolute.grantId);
  assert.equal(await readAll(f.service, PHONE, transfer), 'linked bytes');
});

test('a reply link downloads whatever row id the device numbered the reply with', async (t) => {
  const f = fixture(t);
  // A phone's restored window and the PC's projection number one reply
  // differently (`hist_<session>_5_1` vs `_6_1`): the reply still vouches.
  const grant = await f.service.authorize(PHONE, f.link('hist_s1_5_1', slash(join(f.outside, 'linked.bin'))));
  assert.equal(grant.name, 'linked.bin');
  assert.equal((await f.service.authorize(PHONE, f.link('', 'sub/deep.txt:3'))).name, 'deep.txt');
});

test('a secret-bearing file downloads like any other, linked or not', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.projectA, '.env'), 'API_KEY=1');
  writeFileSync(join(f.projectA, 'sub', '.env.local'), 'LOCAL_KEY=1');
  f.transcripts.get('s1').items.push({ id: 'a9', kind: 'assistant', text: 'Keys live in `.env`.' });
  const session = (path) => ({ source: { kind: 'session', sessionId: 's1', path }, purpose: 'save' });
  // Before parity each was refused as `sensitive`.
  for (const [request, bytes] of [
    [f.link('a9', './.env'), 'API_KEY=1'],
    [f.link('a9', '.env'), 'API_KEY=1'],
    [f.link('a1', 'sub/.env.local'), 'LOCAL_KEY=1'],
    [session('.env'), 'API_KEY=1'],
    [f.project('.env'), 'API_KEY=1'],
  ]) {
    const transfer = await f.service.begin(PHONE, (await f.service.authorize(PHONE, request)).grantId);
    assert.equal(await readAll(f.service, PHONE, transfer), bytes, JSON.stringify(request.source));
    await f.service.finish(PHONE, transfer.transferId);
  }
});

test('a link downloads whatever row, session row kind or reply names it, as the desktop opens it', async (t) => {
  const f = fixture(t);
  const secret = slash(join(f.outside, 'secret.txt'));
  // Before parity each was refused as `not-linked`: a prompt, a tool row, a
  // code block, a streaming row, another session's row and no row at all.
  for (const itemId of ['a1', 'u1', 'tool1', 'a2', 'b1', 'missing']) {
    assert.equal((await f.service.authorize(PHONE, f.link(itemId, secret))).name, 'secret.txt', itemId);
  }
  assert.equal((await f.service.authorize(PHONE, f.link('b1', slash(join(f.outside, 'other.bin'))))).name, 'other.bin');
  // The conversation the request names must exist; a web link is no file here.
  await refusedAs(f.service.authorize(PHONE, f.link('a1', secret, 'gone-session')), 'unavailable');
  await refusedAs(f.service.authorize(PHONE, f.link('a1', 'https://example.com/a.bin')), 'not-a-file');
});

test('project downloads stay inside the session project', async (t) => {
  const f = fixture(t);
  await refusedAs(f.service.authorize(PHONE, f.project('../project-b/b.txt')), 'outside-project');
  await refusedAs(f.service.authorize(PHONE, f.project('b.txt')), 'not-found');
  assert.equal((await f.service.authorize(PHONE, f.project('b.txt', 's2'))).name, 'b.txt');
  await refusedAs(f.service.authorize(PHONE, f.project('out.bin', 't1')), 'outside-project');
  await refusedAs(f.service.authorize(PHONE, f.project('sub')), 'not-a-file');
});

test('a junction out of the project is refused for project and linked downloads', async (t) => {
  const f = fixture(t);
  symlinkSync(f.outside, join(f.projectA, 'escape'), 'junction');
  await refusedAs(f.service.authorize(PHONE, f.project('escape/secret.txt')), 'outside-project');
  f.transcripts.get('s1').items.push({
    id: 'a3',
    kind: 'assistant',
    text: `See ${slash(join(f.projectA, 'escape', 'secret.txt'))}`,
  });
  await refusedAs(
    f.service.authorize(PHONE, f.link('a3', slash(join(f.projectA, 'escape', 'secret.txt')))),
    'outside-project'
  );
});

test("git's internal files download like any other file, as the desktop opens them", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.projectA, '.git'));
  writeFileSync(join(f.projectA, '.git', 'config'), '[remote "origin"]\n\turl = https://token@example.com/r.git\n');
  mkdirSync(join(f.projectA, 'nested', '.GIT'), { recursive: true });
  writeFileSync(join(f.projectA, 'nested', '.GIT', 'HEAD'), 'ref: refs/heads/main\n');
  // Project B keeps its git dir elsewhere (a worktree), sharing a common dir.
  const gitDir = join(f.base, 'store', 'worktrees', 'b');
  const commonDir = join(f.base, 'store');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(f.projectB, '.git'), `gitdir: ${slash(gitDir)}\n`);
  writeFileSync(join(gitDir, 'commondir'), '../..\n');
  writeFileSync(join(gitDir, 'index'), 'index');
  writeFileSync(join(commonDir, 'config'), 'config');

  // Before parity: refused as `sensitive` (a `.git` folder or pointer file)
  // or `outside-project` (a git dir with another name).
  assert.equal((await f.service.authorize(PHONE, f.project('.git/config'))).name, 'config');
  assert.equal((await f.service.authorize(PHONE, f.project('nested/.GIT/HEAD'))).name, 'HEAD');
  const pointer = await f.service.begin(PHONE, (await f.service.authorize(PHONE, f.project('.git', 's2'))).grantId);
  assert.equal(await readAll(f.service, PHONE, pointer), `gitdir: ${slash(gitDir)}\n`);
  await f.service.finish(PHONE, pointer.transferId);
  assert.ok(await f.service.authorize(PHONE, f.link('g1', slash(join(f.projectA, '.git', 'config')))));
  for (const target of [join(gitDir, 'index'), join(commonDir, 'config')]) {
    assert.ok(await f.service.authorize(PHONE, f.link('g2', slash(target), 's2')), target);
  }
  // Ordinary files of the same projects download as before.
  assert.ok(await f.service.authorize(PHONE, f.project('out.bin')));
  assert.ok(await f.service.authorize(PHONE, f.project('b.txt', 's2')));
});

test('a git dir pointed to from a nested worktree, or from above a session folder, downloads', async (t) => {
  const f = fixture(t);
  // A worktree nested in the project keeps its git dir (no `.git` name) inside it.
  const worktree = join(f.projectA, 'sub', 'wt');
  mkdirSync(join(worktree, 'store', 'refs'), { recursive: true });
  writeFileSync(join(worktree, '.git'), 'gitdir: store\n');
  writeFileSync(join(worktree, 'store', 'refs', 'HEAD'), 'ref');
  writeFileSync(join(worktree, 'readme.md'), 'readme');
  // Before parity: refused as `outside-project`.
  assert.equal((await f.service.authorize(PHONE, f.project('sub/wt/store/refs/HEAD'))).name, 'HEAD');
  assert.ok(await f.service.authorize(PHONE, f.project('sub/wt/readme.md')), "the worktree's own files download");

  // A session folder below a worktree root whose git dir lives elsewhere.
  const gitDir = join(f.base, 'elsewhere-git');
  mkdirSync(gitDir);
  writeFileSync(join(gitDir, 'config'), 'config');
  writeFileSync(join(f.projectB, '.git'), `gitdir: ${slash(gitDir)}\n`);
  const cwd = join(f.projectB, 'app');
  mkdirSync(cwd);
  const listed = await f.host.listSessions();
  f.host.listSessions = async () => [...listed, { id: 's3', cwd, projectPath: null, classification: 'task' }];
  f.transcripts.set('s3', { items: [{ id: 'c1', kind: 'assistant', text: `See ${slash(join(gitDir, 'config'))}.` }] });
  assert.equal((await f.service.authorize(PHONE, f.link('c1', slash(join(gitDir, 'config')), 's3'))).name, 'config');
  f.transcripts
    .get('s3')
    .items.push({ id: 'c2', kind: 'assistant', text: `See ${slash(join(f.outside, 'linked.bin'))}.` });
  assert.ok(await f.service.authorize(PHONE, f.link('c2', slash(join(f.outside, 'linked.bin')), 's3')));
});

test('a linked file that is a symlink downloads what it leads to', async (t) => {
  const f = fixture(t);
  const leaf = join(f.outside, 'leaf.txt');
  try {
    symlinkSync(join(f.outside, 'secret.txt'), leaf, 'file');
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('file symlinks need elevated rights on this host');
      return;
    }
    throw error;
  }
  f.transcripts.get('s1').items.push({ id: 'a4', kind: 'assistant', text: `Wrote ${slash(leaf)}` });
  // Before parity: refused as `not-linked`.
  const transfer = await f.service.begin(PHONE, (await f.service.authorize(PHONE, f.link('a4', slash(leaf)))).grantId);
  assert.equal(await readAll(f.service, PHONE, transfer), 'host secret');
});

// Every check passes on the resolved path; the directory above the file is
// then swapped for a junction to a same-named file elsewhere, before the open.
// The open follows the junction, and so would any stat of the path after it.
const ancestorSwaps = [
  {
    label: 'a project file',
    request: (f) => f.project('sub/deep.txt'),
    directory: (f) => join(f.projectA, 'sub'),
    leaf: 'deep.txt',
  },
  {
    label: 'a linked file inside the project',
    request: (f) => f.link('a1', 'sub/deep.txt:3'),
    directory: (f) => join(f.projectA, 'sub'),
    leaf: 'deep.txt',
  },
  {
    label: 'a linked file outside the project',
    request: (f) => f.link('a1', slash(join(f.outside, 'linked.bin'))),
    directory: (f) => f.outside,
    leaf: 'linked.bin',
  },
];

for (const swap of ancestorSwaps) {
  test(`${swap.label} whose ancestor is swapped for a junction between resolving and opening is refused`, async (t) => {
    const f = fixture(t);
    const directory = swap.directory(f);
    const decoy = join(f.base, 'decoy');
    mkdirSync(decoy);
    writeFileSync(join(decoy, swap.leaf), 'decoy secret');
    let swapped = false;
    hook(t, 'afterResolve', (canonical) => {
      if (swapped || canonical !== join(directory, swap.leaf)) return;
      swapped = true;
      renameSync(directory, `${directory}-moved`);
      symlinkSync(decoy, directory, 'junction');
    });
    await refusedAs(f.service.authorize(PHONE, swap.request(f)), 'changed');
    assert.ok(swapped, 'the swap ran between resolving and opening');
    assert.equal(readFileSync(join(directory, swap.leaf), 'utf8'), 'decoy secret', 'the path now leads to the decoy');
  });
}

test('a leased file that moves away is refused on its next read, on the RPC and the media lane', async (t) => {
  const f = fixture(t, { mediaLane: true });
  const rpc = await f.service.begin(PHONE, (await f.service.authorize(PHONE, f.project('out.bin'))).grantId);
  const lane = await f.service.begin(PHONE, (await f.service.authorize(PHONE, f.project('out.bin'))).grantId);
  const target = f.service.resolveMedia(lane.media.assetId, 'download', PHONE.deviceId);
  assert.equal((await target.read(0, 4)).toString(), '0123');
  assert.equal((await f.service.readRange(PHONE, rpc.transferId, 0, 4, rpc.version)).length, 4);
  // Same bytes, size and mtime: only its location changed.
  renameSync(join(f.projectA, 'out.bin'), join(f.outside, 'moved.bin'));
  await refusedAs(f.service.readRange(PHONE, rpc.transferId, 0, 4, rpc.version), 'changed');
  await refusedAs(target.read(0, 4), 'changed');
});

const revocations = [
  { label: 'unpair', revoke: (f) => f.service.revokeDevice(PHONE.deviceId), reason: 'expired' },
  { label: 'session deletion', revoke: (f) => f.service.retainSessions(['s2', 't1']), reason: 'unavailable' },
  { label: 'relay close', revoke: (f) => f.service.revokeAll(), reason: 'expired' },
];

for (const { label, revoke, reason } of revocations) {
  test(`${label} while authorize or begin is pending leaves no grant or lease and closes the file`, async (t) => {
    const watched = () => {
      const f = fixture(t);
      f.service.retainSessions(['s1', 's2', 't1']);
      return f;
    };
    const handles = [];

    // Revoked before any filesystem work finished.
    const early = watched();
    hook(t, 'opened', (handle) => handles.push(handle));
    const first = early.service.authorize(PHONE, early.project('out.bin'));
    revoke(early);
    await refusedAs(first, reason);
    assert.equal(handles.length, 1);
    assert.ok(await closed(handles[0]), 'the file opened after the revocation is closed');

    // Revoked right after the file was opened.
    const opened = watched();
    hook(t, 'opened', (handle) => {
      handles.push(handle);
      revoke(opened);
    });
    await refusedAs(opened.service.authorize(PHONE, opened.project('out.bin')), reason);
    assert.ok(await closed(handles[1]), 'the file opened before the revocation is closed');

    // Revoked while begin verifies the consumed grant.
    const consumed = watched();
    hook(t, 'opened', (handle) => handles.push(handle));
    const grant = await consumed.service.authorize(PHONE, consumed.project('out.bin'));
    const pending = consumed.service.begin(PHONE, grant.grantId);
    revoke(consumed);
    await refusedAs(pending, reason);
    assert.ok(await closed(handles[2]), "the consumed grant's file is closed");
    await refusedAs(consumed.service.begin(PHONE, grant.grantId), 'expired');

    // Only what the revocation names ends; later downloads elsewhere work.
    const other = await consumed.service.authorize(OTHER, consumed.project('b.txt', 's2'));
    assert.ok(await consumed.service.begin(OTHER, other.grantId));
  });
}

test('a grant is bound to its device and redeemed once', async (t) => {
  const f = fixture(t);
  const grant = await f.service.authorize(PHONE, f.project('out.bin'));
  await refusedAs(f.service.begin(OTHER, grant.grantId), 'expired');
  const transfer = await f.service.begin(PHONE, grant.grantId);
  await refusedAs(f.service.begin(PHONE, grant.grantId), 'expired');
  await refusedAs(f.service.readRange(OTHER, transfer.transferId, 0, 4, transfer.version), 'expired');
  await refusedAs(f.service.finish(OTHER, transfer.transferId), 'expired');
  assert.equal(await f.service.abort(OTHER, transfer.transferId), false);
  assert.equal(await f.service.abort(PHONE, transfer.transferId), true);
  await refusedAs(f.service.readRange(PHONE, transfer.transferId, 0, 4, transfer.version), 'expired');
});

test('grants and leases expire', async (t) => {
  const f = fixture(t);
  const stale = await f.service.authorize(PHONE, f.project('out.bin'));
  f.clock.value += FILE_DOWNLOAD_GRANT_TTL_MS;
  await refusedAs(f.service.begin(PHONE, stale.grantId), 'expired');

  const idle = await f.service.begin(PHONE, (await f.service.authorize(PHONE, f.project('out.bin'))).grantId);
  f.clock.value += FILE_DOWNLOAD_LEASE_IDLE_MS;
  await refusedAs(f.service.readRange(PHONE, idle.transferId, 0, 4, idle.version), 'expired');

  const busy = await f.service.begin(PHONE, (await f.service.authorize(PHONE, f.project('out.bin'))).grantId);
  const deadline = f.clock.value + FILE_DOWNLOAD_LEASE_MAX_MS;
  while (f.clock.value + FILE_DOWNLOAD_LEASE_IDLE_MS / 2 < deadline) {
    f.clock.value += FILE_DOWNLOAD_LEASE_IDLE_MS / 2;
    await f.service.readRange(PHONE, busy.transferId, 0, 1, busy.version);
  }
  f.clock.value = deadline;
  await refusedAs(f.service.readRange(PHONE, busy.transferId, 0, 1, busy.version), 'expired');
});

test('a file that changes on disk fails the transfer as changed', async (t) => {
  const f = fixture(t);
  const file = join(f.projectA, 'out.bin');
  const before = await f.service.authorize(PHONE, f.project('out.bin'));
  appendFileSync(file, '+');
  await refusedAs(f.service.begin(PHONE, before.grantId), 'changed');

  const during = await f.service.begin(PHONE, (await f.service.authorize(PHONE, f.project('out.bin'))).grantId);
  await refusedAs(f.service.readRange(PHONE, during.transferId, 0, 4, 'A'.repeat(43)), 'changed');
  appendFileSync(file, '+');
  await refusedAs(f.service.readRange(PHONE, during.transferId, 0, 4, during.version), 'changed');
  await refusedAs(f.service.readRange(PHONE, during.transferId, 0, 4, during.version), 'expired');

  const finishing = await f.service.begin(PHONE, (await f.service.authorize(PHONE, f.project('out.bin'))).grantId);
  appendFileSync(file, '+');
  await refusedAs(f.service.finish(PHONE, finishing.transferId), 'changed');
});

test('unpair and session deletion end what a device holds', async (t) => {
  const f = fixture(t);
  f.service.retainSessions(['s1', 's2', 't1']);
  const phone = await f.service.begin(PHONE, (await f.service.authorize(PHONE, f.project('out.bin'))).grantId);
  const other = await f.service.begin(OTHER, (await f.service.authorize(OTHER, f.project('out.bin'))).grantId);
  f.service.revokeDevice(PHONE.deviceId);
  await refusedAs(f.service.readRange(PHONE, phone.transferId, 0, 1, phone.version), 'expired');
  assert.equal((await f.service.readRange(OTHER, other.transferId, 0, 1, other.version)).length, 1);

  const pending = await f.service.authorize(OTHER, f.project('b.txt', 's2'));
  assert.equal(f.service.sessionRemoved('s1'), false);
  f.service.retainSessions(['s2', 't1']);
  assert.equal(f.service.sessionRemoved('s1'), true);
  await refusedAs(f.service.readRange(OTHER, other.transferId, 0, 1, other.version), 'expired');
  await refusedAs(f.service.authorize(OTHER, f.project('out.bin')), 'unavailable');
  assert.ok(await f.service.begin(OTHER, pending.grantId), 'another session is untouched');
});

test('generated media downloads by asset id, and the media-lane hook serves only its own lease', async (t) => {
  const f = fixture(t, { mediaLane: true });
  const media = (assetId, sessionId = 's1') => ({ source: { kind: 'media', sessionId, assetId }, purpose: 'save' });
  // Any stored asset, whichever conversation generated it (before parity:
  // `not-linked` outside the generating one); an unknown id is not found.
  await refusedAs(f.service.authorize(PHONE, media('nope')), 'not-found');
  assert.equal((await f.service.authorize(PHONE, media('asset-2'))).name, 'other.png');
  assert.equal((await f.service.authorize(PHONE, media('asset-1', 's2'))).name, 'asset.png');
  assert.equal((await f.service.authorize(PHONE, media('asset-2', 's2'))).name, 'other.png');
  const grant = await f.service.authorize(PHONE, {
    source: { kind: 'media', sessionId: 's1', assetId: 'asset-1' },
    purpose: 'save',
  });
  assert.deepEqual([grant.name, grant.mime], ['asset.png', 'image/png']);
  const transfer = await f.service.begin(PHONE, grant.grantId);
  assert.equal(transfer.media.variant, 'download');
  assert.match(transfer.media.assetId, /^[0-9a-f-]{36}$/);
  assert.equal(f.service.resolveMedia(transfer.media.assetId, 'original', PHONE.deviceId), null);
  assert.equal(f.service.resolveMedia(transfer.media.assetId, 'download', OTHER.deviceId), null);
  const target = f.service.resolveMedia(transfer.media.assetId, 'download', PHONE.deviceId);
  assert.deepEqual([target.size, target.mime, target.version], [9, 'image/png', grant.version]);
  assert.equal((await target.read(0, 9)).toString(), 'png bytes');
  await f.service.finish(PHONE, transfer.transferId);
  assert.equal(f.service.resolveMedia(transfer.media.assetId, 'download', PHONE.deviceId), null);
  await refusedAs(target.read(0, 1), 'expired');
});

test('remote arguments are validated before any host work', async (t) => {
  const f = fixture(t);
  const methods = fileDownloadRemoteMethods(f.service, () => PHONE);
  const invalid = [
    [],
    [null],
    [{ purpose: 'save' }],
    [{ source: { kind: 'project', sessionId: 's1', relPath: 'a' }, purpose: 'print' }],
    [{ source: { kind: 'project', sessionId: 'bad id!', relPath: 'a' }, purpose: 'save' }],
    [{ source: { kind: 'project', sessionId: 's1', relPath: '' }, purpose: 'save' }],
    [{ source: { kind: 'project', sessionId: 's1', relPath: 'a\0b' }, purpose: 'save' }],
    [{ source: { kind: 'project', sessionId: 's1', relPath: f.projectA }, purpose: 'save' }],
    [{ source: { kind: 'project', sessionId: 's1', relPath: 'x'.repeat(4_097) }, purpose: 'save' }],
    [{ source: { kind: 'link', sessionId: 's1', itemId: 'a1' }, purpose: 'save' }],
    [{ source: { kind: 'media', sessionId: 's1', assetId: '../x' }, purpose: 'save' }],
    [{ source: { kind: 'path', sessionId: 's1', path: '/etc/passwd' }, purpose: 'save' }],
  ];
  for (const params of invalid) {
    await assert.rejects(methods.fileDownloadAuthorize(params), TypeError, JSON.stringify(params));
  }
  const id = '01234567-89ab-cdef-0123-456789abcdef';
  const version = 'A'.repeat(43);
  await assert.rejects(methods.fileDownloadBegin(['not-an-id']), TypeError);
  await assert.rejects(methods.fileDownloadBegin([id.toUpperCase()]), TypeError);
  for (const [offset, length, v] of [
    [-1, 1, version],
    [1.5, 1, version],
    [FILE_DOWNLOAD_MAX_BYTES + 1, 1, version],
    [0, 0, version],
    [0, FILE_DOWNLOAD_RANGE_MAX_BYTES + 1, version],
    [0, 1, 'short'],
  ]) {
    await assert.rejects(methods.fileDownloadRange([id, offset, length, v]), TypeError);
  }
  await assert.rejects(methods.fileDownloadFinish([42]), TypeError);
  await assert.rejects(methods.fileDownloadAbort(['../x']), TypeError);
  // Well-formed but unknown ids are simply expired.
  await refusedAs(methods.fileDownloadBegin([id]), 'expired');
  assert.equal(await methods.fileDownloadAbort([id]), false);
});

test('the remote table binds downloads to the connection device and lifts refusal codes onto the frame', async (t) => {
  const f = fixture(t);
  const anonymous = createRemoteMethods({ host: f.host, fileDownloads: f.service }, {});
  await refusedAs(anonymous.fileDownloadAuthorize([f.project('out.bin')]), 'unavailable');
  const legOnly = createRemoteMethods(
    { host: f.host, fileDownloads: f.service },
    { credentialId: () => '', connectionId: () => 'leg-1' }
  );
  const grant = await legOnly.fileDownloadAuthorize([f.project('out.bin')]);
  await refusedAs(f.service.begin({ deviceId: 'connection:leg-2' }, grant.grantId), 'expired');
  assert.ok(await f.service.begin({ deviceId: 'connection:leg-1' }, grant.grantId));

  const paired = createRemoteMethods(
    { host: f.host, fileDownloads: f.service },
    { credentialId: () => PHONE.deviceId, connectionId: () => 'leg-3' }
  );
  const reply = await executeRemoteFrame(
    paired,
    JSON.stringify({
      id: 7,
      method: 'fileDownloadAuthorize',
      params: [f.project('../project-b/b.txt')],
    })
  );
  assert.equal(reply.ok, false);
  assert.equal(reply.errorCode, 'file-download:outside-project');
  assert.equal(createRemoteMethods({ host: f.host }, {}).fileDownloadAuthorize, undefined);
});

test('the host advertises fileDownloads in its encryption challenge', async () => {
  const identity = await generateRelayE2EEServerIdentity();
  const envelopes = [];
  const clients = createRelayClientRegistry({
    host: { setVisibleSessionsForSource: async () => true },
    sendEnvelope: (payload) => envelopes.push(payload),
    frameBudgetBytes: 1 << 20,
    onClientCountChanged: () => {},
    onEmpty: () => {},
  });
  const lifecycle = createRelayClientLifecycle({
    clients,
    e2eeIdentity: identity,
    pairing: relayE2EEPairingMaterial(identity),
    relayBinaryFrames: () => false,
    viewSyncSupported: () => false,
    relayRoutingCapsPayload: () => ({}),
    sendEnvelope: (payload) => envelopes.push(payload),
    sendEncryptedFrame: async () => {},
    dispatchClientCall: async () => ({}),
    resyncClient: () => {},
  });
  lifecycle.open('client-1', 'phone-credential');
  const challenge = JSON.parse(envelopes.find((entry) => entry.type === 'frame').data);
  assert.equal(challenge.type, 'e2ee-challenge');
  assert.equal(challenge.fileDownloads, 1);
  assert.equal(challenge.hostDirectories, 1);
  clients.clear();
});
