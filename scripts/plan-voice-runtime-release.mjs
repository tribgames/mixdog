import { appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  VOICE_RUNTIME_CONFIG,
  VOICE_RUNTIME_TAG,
  assertVoiceRuntimeManifestIdentity,
  compareSemver,
  downloadReleaseAsset,
  fetchGithubRelease,
  sameVoiceRuntimeIdentity,
} from './generate-voice-runtime-manifest.mjs'

async function main() {
  const repository = String(process.env.GITHUB_REPOSITORY || 'tribgames/mixdog')
  const requestedTag = String(process.env.INPUT_TAG || '').trim()
  if (requestedTag && requestedTag !== VOICE_RUNTIME_TAG) {
    throw new Error(`voice runtime tag must be ${VOICE_RUNTIME_TAG}, got ${requestedTag}`)
  }

  const bundledPath = resolve('src/runtime/channels/data/voice-runtime-manifest.json')
  const bundled = JSON.parse(await readFile(bundledPath, 'utf8'))
  if (compareSemver(bundled.version, VOICE_RUNTIME_CONFIG.runtimeVersion) > 0) {
    throw new Error(
      `refusing voice runtime downgrade from ${bundled.version} to ${VOICE_RUNTIME_CONFIG.runtimeVersion}`,
    )
  }

  const release = await fetchGithubRelease(repository, VOICE_RUNTIME_TAG, process.env.GITHUB_TOKEN, {
    allowMissing: true,
  })
  let buildNeeded = true
  let syncNeeded = true
  let releaseState = 'missing'

  if (release?.draft) {
    releaseState = 'draft'
  } else if (release) {
    releaseState = 'published'
    if (release.prerelease) throw new Error(`${VOICE_RUNTIME_TAG} must not be a prerelease`)
    const manifestAsset = release.assets?.find((asset) => asset.name === 'voice-runtime-manifest.json')
    if (!manifestAsset) {
      throw new Error(`published ${VOICE_RUNTIME_TAG} has no voice-runtime-manifest.json`)
    }
    const released = JSON.parse(
      (await downloadReleaseAsset(manifestAsset, process.env.GITHUB_TOKEN)).toString('utf8'),
    )
    await assertVoiceRuntimeManifestIdentity(released, { repository })
    buildNeeded = false
    syncNeeded = !sameVoiceRuntimeIdentity(bundled, released)
  }

  const values = {
    tag: VOICE_RUNTIME_TAG,
    version: VOICE_RUNTIME_CONFIG.runtimeVersion,
    commit: VOICE_RUNTIME_CONFIG.whisperCommit,
    vulkan_sdk_version: VOICE_RUNTIME_CONFIG.vulkanSdkVersion,
    matrix: JSON.stringify(VOICE_RUNTIME_CONFIG.platforms),
    build_needed: String(buildNeeded),
    sync_needed: String(syncNeeded),
  }
  const output = process.env.GITHUB_OUTPUT
  if (output) {
    for (const [key, value] of Object.entries(values)) appendFileSync(output, `${key}=${value}\n`)
  }
  console.log(JSON.stringify({ release_state: releaseState, ...values }, null, 2))
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
