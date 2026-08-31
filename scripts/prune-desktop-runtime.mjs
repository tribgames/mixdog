import { access, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { embeddingRuntimeTarget } from './prune-embedding-runtime.mjs'

const PRODUCTION_SOURCE_EXTENSIONS = /\.(?:map|ts|tsx|mts|cts)$/i
const NATIVE_BUILD_ARTIFACT_EXTENSIONS = /\.(?:pdb|obj|ilk|exp|lib)$/i
const TESSERACT_LSTM_CORE_FILES = new Set([
  'tesseract-core-lstm.js',
  'tesseract-core-lstm.wasm',
  'tesseract-core-simd-lstm.js',
  'tesseract-core-simd-lstm.wasm',
  'tesseract-core-relaxedsimd-lstm.js',
  'tesseract-core-relaxedsimd-lstm.wasm',
])

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function removePath(path) {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 250,
  })
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
    .map((entry) => removePath(join(directory, entry.name))))
}

async function removeMatchingFiles(directory, predicate) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }

  let removed = 0
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      removed += await removeMatchingFiles(path, predicate)
    } else if (entry.isFile() && predicate(entry.name, path)) {
      await removePath(path)
      removed += 1
    }
  }
  return removed
}

async function treeContainsFile(directory, predicate) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isFile() && predicate(entry.name, path)) return true
    if (entry.isDirectory() && await treeContainsFile(path, predicate)) return true
  }
  return false
}

async function directoryBytes(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      total += await directoryBytes(path)
    } else if (entry.isFile()) {
      total += (await stat(path)).size
    }
  }
  return total
}

async function assertRuntimePaths(root, paths, label) {
  const missing = []
  for (const path of paths) {
    if (!(await exists(join(root, path)))) missing.push(path)
  }
  if (missing.length) {
    throw new Error(`Desktop ${label} runtime is incomplete: missing ${missing.join(', ')}`)
  }
}

async function pruneTesseractCore(nodeModules) {
  const packageRoot = join(nodeModules, 'tesseract.js-core')
  if (!(await exists(packageRoot))) return { beforeBytes: 0, afterBytes: 0 }
  await assertRuntimePaths(packageRoot, [...TESSERACT_LSTM_CORE_FILES], 'Tesseract LSTM')

  const beforeBytes = await directoryBytes(packageRoot)
  await removeChildrenExcept(packageRoot, new Set([
    'package.json',
    'LICENSE',
    ...TESSERACT_LSTM_CORE_FILES,
  ]))
  const afterBytes = await directoryBytes(packageRoot)
  return { beforeBytes, afterBytes }
}

async function prunePdfJs(nodeModules) {
  const packageRoot = join(nodeModules, 'pdfjs-dist')
  if (!(await exists(packageRoot))) return { beforeBytes: 0, afterBytes: 0 }
  await assertRuntimePaths(packageRoot, [
    'legacy/build/pdf.mjs',
    'legacy/build/pdf.worker.mjs',
  ], 'PDF.js')

  const beforeBytes = await directoryBytes(packageRoot)
  await removeChildrenExcept(packageRoot, new Set([
    'package.json',
    'LICENSE',
    'cmaps',
    'iccs',
    'standard_fonts',
    'wasm',
    'legacy',
  ]))
  await removeChildrenExcept(join(packageRoot, 'legacy'), new Set(['build']))
  await removeChildrenExcept(join(packageRoot, 'legacy', 'build'), new Set([
    'pdf.mjs',
    'pdf.worker.mjs',
  ]))
  const afterBytes = await directoryBytes(packageRoot)
  return { beforeBytes, afterBytes }
}

async function prunePdfLib(nodeModules) {
  const packageRoot = join(nodeModules, 'pdf-lib')
  if (!(await exists(packageRoot))) return { beforeBytes: 0, afterBytes: 0 }
  await assertRuntimePaths(packageRoot, ['cjs/index.js'], 'pdf-lib')

  const beforeBytes = await directoryBytes(packageRoot)
  await removeChildrenExcept(packageRoot, new Set([
    'package.json',
    'LICENSE.md',
    'cjs',
  ]))
  const afterBytes = await directoryBytes(packageRoot)
  return { beforeBytes, afterBytes }
}

async function prunePdfFontkit(nodeModules) {
  const packageRoot = join(nodeModules, '@pdf-lib', 'fontkit')
  if (!(await exists(packageRoot))) return { beforeBytes: 0, afterBytes: 0 }
  await assertRuntimePaths(packageRoot, ['dist/fontkit.umd.js'], 'PDF fontkit')

  const beforeBytes = await directoryBytes(packageRoot)
  await removeChildrenExcept(packageRoot, new Set(['package.json', 'dist']))
  await removeChildrenExcept(join(packageRoot, 'dist'), new Set(['fontkit.umd.js']))
  const afterBytes = await directoryBytes(packageRoot)
  return { beforeBytes, afterBytes }
}

async function pruneUnpdf(nodeModules) {
  const packageRoot = join(nodeModules, 'unpdf')
  if (!(await exists(packageRoot))) return { beforeBytes: 0, afterBytes: 0 }
  await assertRuntimePaths(packageRoot, ['dist/index.mjs'], 'unpdf')

  const beforeBytes = await directoryBytes(packageRoot)
  await removeChildrenExcept(packageRoot, new Set([
    'package.json',
    'LICENSE',
    'dist',
  ]))
  await removeChildrenExcept(join(packageRoot, 'dist'), new Set(['index.mjs']))
  const afterBytes = await directoryBytes(packageRoot)
  return { beforeBytes, afterBytes }
}

async function prunePdfRuntime(nodeModules) {
  const packages = await Promise.all([
    prunePdfJs(nodeModules),
    prunePdfLib(nodeModules),
    prunePdfFontkit(nodeModules),
    pruneUnpdf(nodeModules),
  ])
  return packages.reduce((total, entry) => ({
    beforeBytes: total.beforeBytes + entry.beforeBytes,
    afterBytes: total.afterBytes + entry.afterBytes,
  }), { beforeBytes: 0, afterBytes: 0 })
}

async function pruneSharpWasmFallback(nodeModules, target) {
  const imgRoot = join(nodeModules, '@img')
  let packages
  try {
    packages = await readdir(imgRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }

  const nativePrefix = `sharp-${target.platform}`
  let hasTargetNativeAddon = false
  for (const entry of packages) {
    if (
      !entry.isDirectory()
      || !entry.name.startsWith(nativePrefix)
      || !entry.name.endsWith(`-${target.arch}`)
    ) continue
    if (await treeContainsFile(join(imgRoot, entry.name), (name) => name.endsWith('.node'))) {
      hasTargetNativeAddon = true
      break
    }
  }

  if (!hasTargetNativeAddon) return false
  const wasmPackage = join(imgRoot, 'sharp-wasm32')
  if (!(await exists(wasmPackage))) return false
  await removePath(wasmPackage)
  return true
}

export async function pruneDesktopRuntime(packageRoot, options = {}) {
  const target = embeddingRuntimeTarget(options)
  const nodeModules = join(packageRoot, 'node_modules')
  if (!(await exists(nodeModules))) {
    throw new Error(`Desktop runtime is incomplete: missing ${nodeModules}`)
  }

  const removedSourceFiles = await removeMatchingFiles(
    packageRoot,
    (name) => PRODUCTION_SOURCE_EXTENSIONS.test(name),
  )
  const [removedSharpWasm, tesseractCore, pdfRuntime] = await Promise.all([
    pruneSharpWasmFallback(nodeModules, target),
    pruneTesseractCore(nodeModules),
    prunePdfRuntime(nodeModules),
  ])
  return {
    ...target,
    removedSourceFiles,
    removedSharpWasm,
    removedTesseractBytes: tesseractCore.beforeBytes - tesseractCore.afterBytes,
    removedPdfBytes: pdfRuntime.beforeBytes - pdfRuntime.afterBytes,
  }
}

export async function pruneDesktopPtyPackage(packageRoot, options = {}) {
  const target = embeddingRuntimeTarget(options)
  const beforeBytes = await directoryBytes(packageRoot)
  const keep = new Set(['package.json', 'LICENSE', 'LICENSE.md', 'lib'])
  let nativeRoot

  if (target.platform === 'linux') {
    keep.add('prebuilds')
    const targetName = `${target.platform}-${target.arch}`
    await removeChildrenExcept(join(packageRoot, 'prebuilds'), new Set([targetName]))
    nativeRoot = join(packageRoot, 'prebuilds', targetName)
  } else {
    keep.add('build')
    nativeRoot = join(packageRoot, 'build', 'Release')
  }

  if (!(await treeContainsFile(nativeRoot, (name) => name.endsWith('.node')))) {
    throw new Error(`Desktop node-pty is incomplete: no native addon under ${nativeRoot}`)
  }

  await removeChildrenExcept(packageRoot, keep)
  const removedBuildFiles = await removeMatchingFiles(
    packageRoot,
    (name) => (
      PRODUCTION_SOURCE_EXTENSIONS.test(name)
      || NATIVE_BUILD_ARTIFACT_EXTENSIONS.test(name)
      || /\.(?:test|spec)\.js$/i.test(name)
    ),
  )
  const afterBytes = await directoryBytes(packageRoot)
  return {
    ...target,
    removedBuildFiles,
    beforeBytes,
    afterBytes,
  }
}
