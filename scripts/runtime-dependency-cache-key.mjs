#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { embeddingRuntimeTarget } from './prune-embedding-runtime.mjs'

export const RUNTIME_DEPENDENCY_CACHE_SCHEMA = 1

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function normalizeRuntimeLockfile(lockfile) {
  const normalized = structuredClone(
    typeof lockfile === 'string' || Buffer.isBuffer(lockfile)
      ? JSON.parse(String(lockfile))
      : lockfile,
  )
  // Deploy updates the package identity before every release, but that does
  // not change the production dependency tree cached by native packagers.
  delete normalized.name
  delete normalized.version
  if (normalized.packages?.['']) {
    delete normalized.packages[''].name
    delete normalized.packages[''].version
  }
  return normalized
}

export function runtimeDependencyFingerprint({
  lockfile,
  prunerSource,
  target,
  host = `${process.platform}-${process.arch}`,
  nodeAbi = process.versions.modules,
}) {
  return sha256(JSON.stringify({
    schemaVersion: RUNTIME_DEPENDENCY_CACHE_SCHEMA,
    target,
    host,
    nodeAbi,
    lockfile: normalizeRuntimeLockfile(lockfile),
    prunerSha256: sha256(prunerSource),
  }))
}

export async function runtimeDependencyCacheIdentity(rootDir, target) {
  const [lockfile, prunerSource] = await Promise.all([
    readFile(join(rootDir, 'package-lock.json')),
    readFile(join(rootDir, 'scripts', 'prune-embedding-runtime.mjs')),
  ])
  const host = `${process.platform}-${process.arch}`
  const nodeAbi = process.versions.modules
  return {
    schemaVersion: RUNTIME_DEPENDENCY_CACHE_SCHEMA,
    target: target.key,
    host,
    nodeAbi,
    fingerprint: runtimeDependencyFingerprint({
      lockfile,
      prunerSource,
      target: target.key,
      host,
      nodeAbi,
    }),
  }
}

export function runtimeDependencyCacheKey(identity) {
  return `runtime-deps-v${identity.schemaVersion}-${identity.target}-${identity.fingerprint}`
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  const optionValue = (name) => {
    const prefix = `--${name}=`
    const argument = process.argv.find((value) => value.startsWith(prefix))
    return argument ? argument.slice(prefix.length) : ''
  }
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const target = embeddingRuntimeTarget({
    platform: optionValue('platform') || undefined,
    arch: optionValue('arch') || undefined,
  })
  runtimeDependencyCacheIdentity(rootDir, target)
    .then((identity) => process.stdout.write(`${runtimeDependencyCacheKey(identity)}\n`))
    .catch((error) => {
      process.stderr.write(`Runtime dependency cache key failed: ${error?.message || error}\n`)
      process.exitCode = 1
    })
}
