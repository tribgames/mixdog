import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  assertVoiceRuntimeManifestIdentity,
  compareSemver,
} from './generate-voice-runtime-manifest.mjs'

export async function mergeVoiceRuntimeManifest(current, released, options = {}) {
  await assertVoiceRuntimeManifestIdentity(released, options)
  if (compareSemver(current.version, released.version) > 0) {
    throw new Error(`refusing voice runtime manifest downgrade from ${current.version} to ${released.version}`)
  }
  return {
    ...current,
    version: released.version,
    source: released.source,
    release_tag: released.release_tag,
    build_hash: released.build_hash,
    platforms: released.platforms,
  }
}

async function main() {
  const releasedPath = resolve(process.argv[2] || 'dist/voice-runtime-manifest.json')
  const bundledPath = resolve(
    process.argv[3] || 'src/runtime/channels/data/voice-runtime-manifest.json',
  )
  const [released, current] = await Promise.all([
    readFile(releasedPath, 'utf8').then(JSON.parse),
    readFile(bundledPath, 'utf8').then(JSON.parse),
  ])
  const repository = String(process.env.GITHUB_REPOSITORY || 'tribgames/mixdog')
  const merged = await mergeVoiceRuntimeManifest(current, released, { repository })
  await writeFile(bundledPath, `${JSON.stringify(merged, null, 2)}\n`)
  console.log(`synchronized ${bundledPath} from ${releasedPath}`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error?.stack || error)
    process.exitCode = 1
  })
}
