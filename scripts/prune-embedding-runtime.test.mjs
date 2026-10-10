import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { pruneEmbeddingRuntime, WINDOWS_DML_PRUNABLE_FILES } from './prune-embedding-runtime.mjs';

async function put(path, contents = 'fixture') {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents);
}

test('Windows embedding pruning keeps DirectML and removes optional DXC payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-prune-embedding-'));
  try {
    const transformerRoot = join(root, 'node_modules', '@huggingface', 'transformers');
    const ortRoot = join(root, 'node_modules', 'onnxruntime-node');
    const target = join(ortRoot, 'bin', 'napi-v6', 'win32', 'x64');
    await put(join(transformerRoot, 'package.json'), JSON.stringify({ name: '@huggingface/transformers' }));
    await put(join(transformerRoot, 'dist', 'transformers.node.cjs'));
    await put(join(transformerRoot, 'dist', 'transformers.node.mjs'));
    await put(join(ortRoot, 'package.json'), JSON.stringify({ name: 'onnxruntime-node' }));
    for (const name of ['onnxruntime_binding.node', 'onnxruntime.dll', 'DirectML.dll', ...WINDOWS_DML_PRUNABLE_FILES]) {
      await put(join(target, name));
    }
    await put(join(ortRoot, 'bin', 'napi-v6', 'linux', 'x64', 'onnxruntime_binding.node'));

    const result = await pruneEmbeddingRuntime(root, { platform: 'win32', arch: 'x64' });

    assert.deepEqual(result.removedTargetFiles.sort(), [...WINDOWS_DML_PRUNABLE_FILES].sort());
    await access(join(target, 'onnxruntime_binding.node'));
    await access(join(target, 'onnxruntime.dll'));
    await access(join(target, 'DirectML.dll'));
    for (const name of WINDOWS_DML_PRUNABLE_FILES) {
      await assert.rejects(access(join(target, name)), { code: 'ENOENT' });
    }
    await assert.rejects(access(join(ortRoot, 'bin', 'napi-v6', 'linux')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('darwin-x64 pruning succeeds without an ONNX binding and removes every native payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-prune-embedding-'));
  try {
    const transformerRoot = join(root, 'node_modules', '@huggingface', 'transformers');
    const webRoot = join(root, 'node_modules', 'onnxruntime-web');
    const ortRoot = join(root, 'node_modules', 'onnxruntime-node');
    await put(join(transformerRoot, 'package.json'), JSON.stringify({ name: '@huggingface/transformers' }));
    await put(join(transformerRoot, 'dist', 'transformers.node.cjs'));
    await put(join(transformerRoot, 'dist', 'transformers.node.mjs'));
    await put(join(transformerRoot, 'dist', 'transformers.web.js'));
    await put(join(webRoot, 'package.json'), JSON.stringify({ name: 'onnxruntime-web' }));
    await put(join(webRoot, 'dist', 'ort.wasm'));
    await put(join(ortRoot, 'package.json'), JSON.stringify({ name: 'onnxruntime-node' }));
    await put(join(ortRoot, 'bin', 'napi-v6', 'darwin', 'arm64', 'onnxruntime_binding.node'));
    await put(join(ortRoot, 'bin', 'napi-v6', 'linux', 'x64', 'onnxruntime_binding.node'));

    const result = await pruneEmbeddingRuntime(root, { platform: 'darwin', arch: 'x64' });

    assert.equal(result.onnx, false);
    assert.equal(result.targetBinaryDir, null);
    await assert.rejects(access(join(ortRoot, 'bin', 'napi-v6', 'darwin')), { code: 'ENOENT' });
    await assert.rejects(access(join(ortRoot, 'bin', 'napi-v6', 'linux')), { code: 'ENOENT' });
    await assert.rejects(access(join(transformerRoot, 'dist', 'transformers.web.js')), { code: 'ENOENT' });
    await assert.rejects(access(join(webRoot, 'dist')), { code: 'ENOENT' });
    await access(join(webRoot, 'package.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
