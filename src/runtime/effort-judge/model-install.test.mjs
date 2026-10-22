import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  effortJudgeInstallCurrent,
  effortJudgeInstallStamped,
  effortJudgeManifest,
  fsyncFile,
  installEffortJudgeModel,
  invalidateDamagedEffortJudgeInstall,
} from './model-install.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const BODIES = { 'model.onnx': 'model-bytes', 'tokenizer.json': '{"t":1}', 'calibration.json': '{"temperature":2}' };
const manifest = (release, bodies = BODIES) => ({
  schema_version: 1,
  release,
  files: Object.fromEntries(
    Object.entries(bodies).map(([name, body]) => [
      name,
      { url: `https://example.test/${release}/${name}`, sha256: sha(body), size: Buffer.byteLength(body) },
    ])
  ),
});
// Serves `served` (default: the manifest bodies) and records each requested file.
function server(served = BODIES) {
  const calls = [];
  const fetchFn = async (url) => {
    const name = url.split('/').pop();
    calls.push(name);
    return new Response(served[name], {
      status: 200,
      headers: { 'content-length': String(Buffer.byteLength(served[name])) },
    });
  };
  return { calls, fetchFn };
}

test('the bundled manifest names a release with a url, sha256 and size per file', () => {
  const m = effortJudgeManifest();
  assert.match(m.release, /^effort-judge-v\d+$/);
  assert.deepEqual(Object.keys(m.files).sort(), ['calibration.json', 'model.onnx', 'tokenizer.json']);
  for (const [name, file] of Object.entries(m.files)) {
    assert.equal(file.url, `https://github.com/tribgames/mixdog/releases/download/${m.release}/${name}`);
  }
});

test('install downloads verified files, stamps the release and keeps files that already match', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-judge-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const v1 = manifest('effort-judge-v1');
  assert.equal(effortJudgeInstallCurrent(dir, v1), false);

  const first = server();
  await installEffortJudgeModel(dir, { fetchFn: first.fetchFn, manifest: v1 });
  assert.deepEqual(first.calls.sort(), ['calibration.json', 'model.onnx', 'tokenizer.json']);
  assert.equal(readFileSync(join(dir, 'model.onnx'), 'utf8'), 'model-bytes');
  assert.equal(effortJudgeInstallCurrent(dir, v1), true);

  // A new release that changes only the model downloads only the model and drops the derived tokenizer cache.
  writeFileSync(join(dir, 'tokenizer.bin'), 'cache');
  const bodies2 = { ...BODIES, 'model.onnx': 'model-bytes-2' };
  const v2 = manifest('effort-judge-v2', bodies2);
  assert.equal(effortJudgeInstallCurrent(dir, v2), false);
  const second = server(bodies2);
  await installEffortJudgeModel(dir, { fetchFn: second.fetchFn, manifest: v2 });
  assert.deepEqual(second.calls, ['model.onnx']);
  assert.equal(readFileSync(join(dir, 'model.onnx'), 'utf8'), 'model-bytes-2');
  assert.equal(existsSync(join(dir, 'tokenizer.bin')), false);
  assert.equal(effortJudgeInstallCurrent(dir, v2), true);
});

test('a corrupted download fails the install and leaves the previous file in place', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-judge-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const v1 = manifest('effort-judge-v1');
  await installEffortJudgeModel(dir, { fetchFn: server().fetchFn, manifest: v1 });
  const v2 = manifest('effort-judge-v2', { ...BODIES, 'model.onnx': 'model-bytes-2' });
  // Same length as the expected body, wrong content.
  const bad = server({ ...BODIES, 'model.onnx': 'model-bytes-X' });
  await assert.rejects(installEffortJudgeModel(dir, { fetchFn: bad.fetchFn, manifest: v2 }), /sha256 mismatch/);
  assert.equal(readFileSync(join(dir, 'model.onnx'), 'utf8'), 'model-bytes');
  assert.equal(effortJudgeInstallCurrent(dir, v1), true);
  assert.deepEqual(
    (await import('node:fs')).readdirSync(dir).filter((name) => name.endsWith('.part')),
    []
  );
});

test('an update interrupted after replacing a file leaves the folder unstamped, never a stamped mix', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-judge-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await installEffortJudgeModel(dir, { fetchFn: server().fetchFn, manifest: manifest('effort-judge-v1') });
  assert.equal(effortJudgeInstallStamped(dir), true);
  // The model is replaced, then the tokenizer download arrives corrupted.
  const bodies2 = { ...BODIES, 'model.onnx': 'model-bytes-2', 'tokenizer.json': '{"t":2}' };
  const v2 = manifest('effort-judge-v2', bodies2);
  const bad = server({ ...bodies2, 'tokenizer.json': '{"t":X}' });
  await assert.rejects(installEffortJudgeModel(dir, { fetchFn: bad.fetchFn, manifest: v2 }), /sha256 mismatch/);
  assert.equal(readFileSync(join(dir, 'model.onnx'), 'utf8'), 'model-bytes-2');
  assert.equal(effortJudgeInstallStamped(dir), false);
  // The next install completes it and stamps again.
  await installEffortJudgeModel(dir, { fetchFn: server(bodies2).fetchFn, manifest: v2 });
  assert.equal(effortJudgeInstallCurrent(dir, v2), true);
});

test('a stamped model with a zeroed tail is invalidated and reinstalled by fetching only that file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-judge-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const v1 = manifest('effort-judge-v1');
  await installEffortJudgeModel(dir, { fetchFn: server().fetchFn, manifest: v1 });
  assert.deepEqual(await invalidateDamagedEffortJudgeInstall(dir, v1), []);
  assert.equal(effortJudgeInstallCurrent(dir, v1), true, 'an intact install keeps its stamp');

  // Same size, wrong bytes: the tail never reached the disk.
  writeFileSync(join(dir, 'model.onnx'), Buffer.concat([Buffer.from('model-by'), Buffer.alloc(3)]));
  assert.equal(effortJudgeInstallCurrent(dir, v1), true, 'the stamp alone cannot tell');
  assert.deepEqual(await invalidateDamagedEffortJudgeInstall(dir, v1), ['model.onnx']);
  assert.equal(effortJudgeInstallStamped(dir), false);

  const repair = server();
  await installEffortJudgeModel(dir, { fetchFn: repair.fetchFn, manifest: v1 });
  assert.deepEqual(repair.calls, ['model.onnx']);
  assert.equal(readFileSync(join(dir, 'model.onnx'), 'utf8'), 'model-bytes');
  assert.equal(effortJudgeInstallCurrent(dir, v1), true);
});

test('a missing file counts as damaged', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-judge-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const v1 = manifest('effort-judge-v1');
  await installEffortJudgeModel(dir, { fetchFn: server().fetchFn, manifest: v1 });
  rmSync(join(dir, 'tokenizer.json'));
  assert.deepEqual(await invalidateDamagedEffortJudgeInstall(dir, v1), ['tokenizer.json']);
});

test('each downloaded file is fsynced before it is renamed into place', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-judge-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const synced = [];
  await installEffortJudgeModel(dir, {
    fetchFn: server().fetchFn,
    manifest: manifest('effort-judge-v1'),
    syncFile: async (path) => {
      const name = path.replace(/\.\d+\.part$/, '');
      synced.push(name.slice(dir.length + 1));
      assert.equal(existsSync(path), true, 'the partial file is still there');
      assert.equal(existsSync(name), false, 'the target is not yet published');
    },
  });
  assert.deepEqual(synced.sort(), ['calibration.json', 'model.onnx', 'tokenizer.json']);
});

// An open() whose handle fails its sync with `code`, recording the close.
function failingOpen(code) {
  const seen = { closed: 0 };
  const open = async (path, flags) => {
    assert.equal(flags, 'r+', 'a write handle: Windows refuses fsync on a read-only one');
    return {
      sync: async () => {
        throw Object.assign(new Error(`${code} from fsync`), { code });
      },
      close: async () => {
        seen.closed += 1;
      },
    };
  };
  return { open, seen };
}

test('an fsync the filesystem refuses is tolerated and the handle is closed', async () => {
  for (const code of ['EPERM', 'ENOTSUP', 'EINVAL']) {
    const { open, seen } = failingOpen(code);
    await fsyncFile('unused', open);
    assert.equal(seen.closed, 1, code);
  }
});

test('a fatal fsync error closes the handle and the file is never renamed into place', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-judge-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { open, seen } = failingOpen('EIO');
  await assert.rejects(fsyncFile('unused', open), /EIO from fsync/);
  assert.equal(seen.closed, 1);

  const install = failingOpen('EIO');
  await assert.rejects(
    installEffortJudgeModel(dir, {
      fetchFn: server().fetchFn,
      manifest: manifest('effort-judge-v1'),
      syncFile: (path) => fsyncFile(path, install.open),
    }),
    /EIO from fsync/
  );
  assert.equal(install.seen.closed, 1);
  assert.deepEqual(readdirSync(dir), [], 'no published file, no stamp, no leftover .part');
});

test('the default fsync accepts a real downloaded file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-judge-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await installEffortJudgeModel(dir, { fetchFn: server().fetchFn, manifest: manifest('effort-judge-v1') });
  assert.equal(readFileSync(join(dir, 'model.onnx'), 'utf8'), 'model-bytes');
});

test('an empty or NUL-filled install stamp reads as not installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-judge-stamp-'));
  try {
    for (const damaged of [Buffer.alloc(0), Buffer.alloc(32)]) {
      writeFileSync(join(dir, 'install.json'), damaged);
      assert.equal(effortJudgeInstallStamped(dir), false);
      assert.equal(effortJudgeInstallCurrent(dir, { release: 'r1' }), false);
    }
    writeFileSync(join(dir, 'install.json'), '{"release":"r1"}\n');
    assert.equal(effortJudgeInstallStamped(dir), true);
    assert.equal(effortJudgeInstallCurrent(dir, { release: 'r1' }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
