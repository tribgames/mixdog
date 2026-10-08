import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effortJudgeInstallCurrent, effortJudgeManifest, installEffortJudgeModel } from './model-install.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const BODIES = { 'model.onnx': 'model-bytes', 'tokenizer.json': '{"t":1}', 'calibration.json': '{"temperature":2}' };
const manifest = (release, bodies = BODIES) => ({
  schema_version: 1,
  release,
  files: Object.fromEntries(
    Object.entries(bodies).map(([name, body]) => [name, { url: `https://example.test/${release}/${name}`, sha256: sha(body), size: Buffer.byteLength(body) }])
  ),
});
// Serves `served` (default: the manifest bodies) and records each requested file.
function server(served = BODIES) {
  const calls = [];
  const fetchFn = async (url) => {
    const name = url.split('/').pop();
    calls.push(name);
    return new Response(served[name], { status: 200, headers: { 'content-length': String(Buffer.byteLength(served[name])) } });
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
