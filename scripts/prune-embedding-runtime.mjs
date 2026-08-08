#!/usr/bin/env node

import { access, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SUPPORTED_TARGETS = new Map([
  ['win32', new Set(['x64', 'arm64'])],
  ['darwin', new Set(['x64', 'arm64'])],
  ['linux', new Set(['x64', 'arm64'])],
])

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function removeChildrenExcept(directory, keep) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  await Promise.all(entries
    .filter((entry) => !keep.has(entry.name))
    // Windows: pruning a freshly-installed npm tree races AV scans; bounded
    // retries absorb the transient ENOTEMPTY/EPERM rmdir failures.
    .map((entry) => rm(join(directory, entry.name), {
      recursive: true, force: true, maxRetries: 10, retryDelay: 250,
    })))
}

async function packageName(directory) {
  try {
    return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).name
  } catch {
    return ''
  }
}

async function findPackageRoot(entry, expectedName) {
  let current = dirname(entry)
  for (;;) {
    if (await packageName(current) === expectedName) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`Unable to locate ${expectedName} from ${entry}`)
}

export function embeddingRuntimeTarget(options = {}) {
  const platform = String(
    options.platform
      || process.env.MIXDOG_EMBED_TARGET_PLATFORM
      || process.platform,
  ).trim()
  const arch = String(
    options.arch
      || process.env.MIXDOG_EMBED_TARGET_ARCH
      || process.arch,
  ).trim()
  if (!SUPPORTED_TARGETS.get(platform)?.has(arch)) {
    throw new Error(`Unsupported embedding runtime target: ${platform}-${arch}`)
  }
  return { platform, arch, key: `${platform}-${arch}` }
}

export async function pruneEmbeddingRuntime(packageRoot, options = {}) {
  const root = resolve(packageRoot)
  const target = embeddingRuntimeTarget(options)
  const nodeModules = join(root, 'node_modules')
  const transformerRoot = join(nodeModules, '@huggingface', 'transformers')
  const transformerPackage = join(transformerRoot, 'package.json')
  if (!(await exists(transformerPackage))) {
    throw new Error(`Embedding runtime is incomplete: missing ${transformerPackage}`)
  }

  const transformerEntry = join(transformerRoot, 'dist', 'transformers.node.cjs')
  const transformerImport = join(transformerRoot, 'dist', 'transformers.node.mjs')
  for (const required of [transformerEntry, transformerImport]) {
    if (!(await exists(required))) {
      throw new Error(`Embedding runtime is incomplete: missing ${required}`)
    }
  }

  const ortCandidates = [
    join(transformerRoot, 'node_modules', 'onnxruntime-node'),
    join(nodeModules, 'onnxruntime-node'),
  ]
  const ortRoot = (await Promise.all(ortCandidates.map(async (candidate) => (
    await exists(join(candidate, 'package.json')) ? candidate : null
  )))).find(Boolean)
  if (!ortRoot) throw new Error('Embedding runtime is incomplete: onnxruntime-node is unavailable')

  const targetBinaryDir = join(ortRoot, 'bin', 'napi-v3', target.platform, target.arch)
  if (!(await exists(join(targetBinaryDir, 'onnxruntime_binding.node')))) {
    throw new Error(`Embedding runtime is incomplete: missing ${target.key} ONNX binding`)
  }

  // Transformers' Node conditional export bundles all JS implementation code.
  // Browser bundles, WASM, maps, source and types are not runtime inputs.
  await removeChildrenExcept(transformerRoot, new Set([
    'package.json',
    'LICENSE',
    'dist',
    'node_modules',
  ]))
  await removeChildrenExcept(join(transformerRoot, 'dist'), new Set([
    'transformers.node.cjs',
    'transformers.node.mjs',
  ]))

  // onnxruntime-node resolves exactly:
  // bin/napi-v3/${process.platform}/${process.arch}/onnxruntime_binding.node.
  // Keep one native payload and remove every foreign OS/architecture.
  const napiRoot = join(ortRoot, 'bin', 'napi-v3')
  await removeChildrenExcept(napiRoot, new Set([target.platform]))
  await removeChildrenExcept(join(napiRoot, target.platform), new Set([target.arch]))
  await removeChildrenExcept(ortRoot, new Set([
    'package.json',
    'dist',
    'bin',
    'node_modules',
  ]))

  // The Node bundle marks onnxruntime-web as an ignored webpack external. Keep
  // only its manifest so npm's dependency inventory remains coherent.
  for (const webRoot of [
    join(nodeModules, 'onnxruntime-web'),
    join(transformerRoot, 'node_modules', 'onnxruntime-web'),
  ]) {
    if (await exists(join(webRoot, 'package.json'))) {
      await removeChildrenExcept(webRoot, new Set(['package.json', 'LICENSE']))
    }
  }

  return {
    ...target,
    transformerRoot,
    ortRoot,
    targetBinaryDir,
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  pruneEmbeddingRuntime(packageRoot)
    .then(({ key }) => {
      process.stdout.write(`Embedding runtime pruned for ${key}.\n`)
    })
    .catch((error) => {
      process.stderr.write(`Embedding runtime prune failed: ${error?.message || error}\n`)
      process.exitCode = 1
    })
}
