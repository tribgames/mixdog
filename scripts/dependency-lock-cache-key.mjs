#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { normalizeRuntimeLockfile } from './runtime-dependency-cache-key.mjs'

export const DEPENDENCY_LOCK_CACHE_SCHEMA = 1

export function dependencyLockCacheKey(lockfile) {
  const normalized = normalizeRuntimeLockfile(lockfile)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex')
  return `dependency-lock-v${DEPENDENCY_LOCK_CACHE_SCHEMA}-${fingerprint}`
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  const lockfilePath = process.argv[2]
  if (!lockfilePath) throw new Error('Usage: dependency-lock-cache-key.mjs <package-lock.json>')
  readFile(resolve(lockfilePath))
    .then((lockfile) => process.stdout.write(`${dependencyLockCacheKey(lockfile)}\n`))
    .catch((error) => {
      process.stderr.write(`Dependency lock cache key failed: ${error?.message || error}\n`)
      process.exitCode = 1
    })
}
