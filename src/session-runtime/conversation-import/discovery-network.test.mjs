import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as realFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

// Every path discovery hands to fs/promises is recorded, so a rejected
// network/device path can be proven never to reach the filesystem.
const probes = [];
const recorded = (name) =>
  async function (...args) {
    probes.push(String(args[0]));
    return realFs[name].apply(this, args);
  };
const { default: realDefault, ...realNamed } = realFs;
mock.module('node:fs/promises', {
  namedExports: {
    ...realNamed,
    access: recorded('access'),
    open: recorded('open'),
    readdir: recorded('readdir'),
    realpath: recorded('realpath'),
    stat: recorded('stat'),
  },
  defaultExport: realDefault,
});

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mixdog-import-network-')));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
const { isNetworkOrDevicePath, listConversations, registerFile, resetConversationDiscovery, resolveSourceCwd } =
  await import('./discovery.mjs');
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const REMOTE_CWDS = [
  '\\\\server\\share\\project',
  '\\\\?\\UNC\\server\\share\\project',
  '\\\\.\\pipe\\project',
  '\\\\?\\C:\\project',
  '//server/share/project',
];
const touched = (raw) => probes.filter((path) => path === raw || path.includes('server') || path.includes('pipe'));

test('network and device paths are recognized by string alone', () => {
  for (const path of REMOTE_CWDS) assert.equal(isNetworkOrDevicePath(path), true, path);
  for (const path of ['C:\\project', '/home/me/project', 'relative\\dir']) {
    assert.equal(isNetworkOrDevicePath(path), false, path);
  }
});

test('an imported network/device or relative cwd is display text only and is never probed', async () => {
  probes.length = 0;
  for (const raw of [...REMOTE_CWDS, 'relative\\project']) {
    assert.deepEqual(await resolveSourceCwd(raw), { exists: false, path: raw });
  }
  assert.deepEqual(probes, []);
  // A local directory is still resolved (the recorder sees it).
  assert.deepEqual(await resolveSourceCwd(root), { exists: true, path: root });
  assert.ok(probes.includes(root));
});

test('listing a conversation whose cwd is a UNC share keeps the text and never probes it', async () => {
  resetConversationDiscovery();
  const codexHome = join(root, 'codex');
  const dir = join(codexHome, 'sessions', '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  const cwd = '\\\\?\\UNC\\fileserver\\share\\project';
  const record = (value) => JSON.stringify(value);
  writeFileSync(
    join(dir, 'rollout-unc.jsonl'),
    `${[
      record({ type: 'session_meta', payload: { id: 'id-unc', cwd } }),
      record({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Over the network' }] },
      }),
    ].join('\n')}\n`
  );
  probes.length = 0;
  const page = await listConversations(
    { source: 'codex' },
    { imported: { get: () => null, has: () => false }, env: { CODEX_HOME: codexHome } }
  );
  assert.deepEqual(
    page.rows.map((row) => [row.title, row.cwd, row.warnings]),
    [['Over the network', cwd, ['cwdMissing']]]
  );
  assert.deepEqual(page.projects, [{ cwd, count: 1 }]);
  assert.deepEqual(touched(cwd), []);
});

test('a picked network/device file is refused before any filesystem call', async () => {
  probes.length = 0;
  for (const path of [
    '\\\\server\\share\\chat.jsonl',
    '\\\\?\\UNC\\server\\share\\chat.jsonl',
    '\\\\.\\pipe\\chat.jsonl',
    '\\\\?\\C:\\chat.jsonl',
    '//server/share/chat.jsonl',
  ]) {
    await assert.rejects(registerFile({ source: 'codex', path }, { imported: { get: () => null } }), /unsupported/);
  }
  assert.deepEqual(probes, []);
});
