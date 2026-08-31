import { rm } from 'node:fs/promises'
import { join } from 'node:path'

const CACHE_DIRECTORIES = Object.freeze({
  graph: 'graph-bin',
  patch: 'patch-bin',
  spawn: 'spawn-bin',
})

export async function gcSupersededNativeToolCaches(dataDir, bundledKinds) {
  const removed = []
  const failed = []
  for (const kind of new Set(bundledKinds)) {
    const directory = CACHE_DIRECTORIES[kind]
    if (!directory) continue
    try {
      await rm(join(dataDir, directory), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 250,
      })
      removed.push(kind)
    } catch (error) {
      failed.push({ kind, error })
    }
  }
  return { removed, failed }
}
