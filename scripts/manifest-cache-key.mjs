#!/usr/bin/env node

/**
 * Version-neutral digest for release cache keys.
 *
 * Deploy rewrites the version field of package.json / package-lock.json on
 * every release, so a cache key built from hashFiles() over those manifests is
 * guaranteed to miss on the one run that needs it: the desktop bundle and the
 * five prepared platform runtimes were rebuilt from scratch each release even
 * though their inputs were byte-identical apart from the version string.
 * Hashing the same manifests with the package identity stripped keeps the key
 * pinned to the dependency tree that actually decides the output.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { normalizeRuntimeLockfile } from './runtime-dependency-cache-key.mjs'

export const MANIFEST_CACHE_SCHEMA = 1

export function manifestCacheKey(manifests) {
  const digest = createHash('sha256')
  digest.update(`manifest-v${MANIFEST_CACHE_SCHEMA}`)
  for (const manifest of manifests) {
    digest.update(JSON.stringify(normalizeRuntimeLockfile(manifest)))
  }
  return digest.digest('hex')
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  const manifestPaths = process.argv.slice(2)
  if (!manifestPaths.length) {
    throw new Error('Usage: manifest-cache-key.mjs <package.json|package-lock.json>...')
  }
  Promise.all(manifestPaths.map((path) => readFile(resolve(path))))
    .then((manifests) => process.stdout.write(`${manifestCacheKey(manifests)}\n`))
    .catch((error) => {
      process.stderr.write(`Manifest cache key failed: ${error?.message || error}\n`)
      process.exitCode = 1
    })
}
