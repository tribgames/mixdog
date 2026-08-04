import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  embeddingRuntimeTarget,
  pruneEmbeddingRuntime,
} from './prune-embedding-runtime.mjs'
import { runtimeDependencyFingerprint } from './runtime-dependency-cache-key.mjs'

const execFileAsync = promisify(execFile)

const TARGETS = [
  ['win32', 'x64'],
  ['win32', 'arm64'],
  ['darwin', 'x64'],
  ['darwin', 'arm64'],
  ['linux', 'x64'],
  ['linux', 'arm64'],
]

async function present(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-embedding-prune-'))
  const modules = join(root, 'node_modules')
  const transformers = join(modules, '@huggingface', 'transformers')
  const ort = join(transformers, 'node_modules', 'onnxruntime-node')
  const web = join(modules, 'onnxruntime-web')
  await Promise.all([
    mkdir(join(transformers, 'dist'), { recursive: true }),
    mkdir(join(transformers, 'src'), { recursive: true }),
    mkdir(join(transformers, 'types'), { recursive: true }),
    mkdir(ort, { recursive: true }),
    mkdir(join(web, 'dist'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(transformers, 'package.json'), '{"name":"@huggingface/transformers"}'),
    writeFile(join(transformers, 'LICENSE'), 'license'),
    writeFile(join(transformers, 'README.md'), 'readme'),
    writeFile(join(transformers, 'src', 'source.js'), 'source'),
    writeFile(join(transformers, 'types', 'index.d.ts'), 'types'),
    writeFile(join(transformers, 'dist', 'transformers.node.cjs'), 'module.exports = {}'),
    writeFile(join(transformers, 'dist', 'transformers.node.mjs'), 'export const pipeline = true'),
    writeFile(join(transformers, 'dist', 'transformers.web.js'), 'web'),
    writeFile(join(transformers, 'dist', 'runtime.wasm'), 'wasm'),
    writeFile(join(web, 'package.json'), '{"name":"onnxruntime-web"}'),
    writeFile(join(web, 'LICENSE'), 'license'),
    writeFile(join(web, 'dist', 'runtime.wasm'), 'wasm'),
    writeFile(join(ort, 'package.json'), '{"name":"onnxruntime-node"}'),
    mkdir(join(ort, 'dist'), { recursive: true }),
  ])
  for (const [platform, arch] of TARGETS) {
    const bin = join(ort, 'bin', 'napi-v3', platform, arch)
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'onnxruntime_binding.node'), `${platform}-${arch}`)
    await writeFile(join(bin, platform === 'win32' ? 'onnxruntime.dll'
      : platform === 'darwin' ? 'libonnxruntime.dylib' : 'libonnxruntime.so.1'), 'native')
  }
  return { root, transformers, ort, web }
}

for (const [platform, arch] of TARGETS) {
  test(`embedding runtime pruning keeps only ${platform}-${arch}`, async () => {
    const paths = await fixture()
    try {
      const result = await pruneEmbeddingRuntime(paths.root, { platform, arch })
      assert.equal(result.key, `${platform}-${arch}`)
      assert.equal(
        (await pruneEmbeddingRuntime(paths.root, { platform, arch })).key,
        `${platform}-${arch}`,
      )
      assert.equal(await present(join(paths.transformers, 'dist', 'transformers.node.cjs')), true)
      assert.equal(await present(join(paths.transformers, 'dist', 'transformers.node.mjs')), true)
      assert.equal(await present(join(paths.transformers, 'dist', 'transformers.web.js')), false)
      assert.equal(await present(join(paths.transformers, 'src')), false)
      assert.equal(await present(join(paths.web, 'package.json')), true)
      assert.equal(await present(join(paths.web, 'dist')), false)
      for (const [candidatePlatform, candidateArch] of TARGETS) {
        assert.equal(
          await present(join(paths.ort, 'bin', 'napi-v3', candidatePlatform, candidateArch)),
          candidatePlatform === platform && candidateArch === arch,
        )
      }
    } finally {
      await rm(paths.root, { recursive: true, force: true })
    }
  })
}

test('embedding runtime target rejects unsupported platform pairs', () => {
  assert.throws(
    () => embeddingRuntimeTarget({ platform: 'freebsd', arch: 'x64' }),
    /Unsupported embedding runtime target: freebsd-x64/,
  )
})

test('embedding verifier imports transformers from the packaged runtime root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-embedding-verify-'))
  const runtimeRoot = join(root, 'runtime')
  const transformers = join(runtimeRoot, 'node_modules', '@huggingface', 'transformers')
  const ort = join(transformers, 'node_modules', 'onnxruntime-node')
  const nativeDir = join(ort, 'bin', 'napi-v3', process.platform, process.arch)
  const verifier = join(root, 'verify-embedding-runtime.mjs')
  try {
    await mkdir(nativeDir, { recursive: true })
    await Promise.all([
      writeFile(join(runtimeRoot, 'package.json'), '{"name":"packaged-runtime"}'),
      copyFile(new URL('./verify-embedding-runtime.mjs', import.meta.url), verifier),
    ])
    await Promise.all([
      writeFile(
        join(transformers, 'package.json'),
        '{"name":"@huggingface/transformers","main":"index.cjs"}',
      ),
      writeFile(join(transformers, 'index.cjs'), 'module.exports={pipeline(){}}'),
      writeFile(join(ort, 'package.json'), '{"name":"onnxruntime-node","main":"index.cjs"}'),
      writeFile(join(ort, 'index.cjs'), 'module.exports={InferenceSession:{create(){}}}'),
      writeFile(join(nativeDir, 'onnxruntime_binding.node'), ''),
    ])

    const { stdout } = await execFileAsync(process.execPath, [
      verifier,
      `--runtime-root=${runtimeRoot}`,
    ])
    assert.match(stdout, /Embedding runtime OK:/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('runtime dependency fingerprint ignores release identity but invalidates runtime inputs', () => {
  const lockfile = {
    name: 'mixdog',
    version: '0.9.82',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'mixdog',
        version: '0.9.82',
        dependencies: { runtime: '^1.0.0' },
      },
      'node_modules/runtime': { version: '1.0.0' },
    },
  }
  const fingerprint = (overrides = {}) => runtimeDependencyFingerprint({
    lockfile,
    prunerSource: 'pruner-v1',
    target: 'win32-x64',
    host: 'win32-x64',
    nodeAbi: '127',
    ...overrides,
  })
  const nextRelease = structuredClone(lockfile)
  nextRelease.version = '0.9.83'
  nextRelease.packages[''].version = '0.9.83'
  assert.equal(fingerprint(), fingerprint({ lockfile: nextRelease }))

  const changedDependency = structuredClone(lockfile)
  changedDependency.packages['node_modules/runtime'].version = '1.1.0'
  assert.notEqual(fingerprint(), fingerprint({ lockfile: changedDependency }))
  assert.notEqual(fingerprint(), fingerprint({ prunerSource: 'pruner-v2' }))
  assert.notEqual(fingerprint(), fingerprint({ target: 'linux-x64', host: 'linux-x64' }))
})
