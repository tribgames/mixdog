import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  VOICE_RUNTIME_CONFIG,
  VOICE_RUNTIME_TAG,
  assertVoiceRuntimeManifestIdentity,
  buildVoiceFfmpegPlatforms,
  buildVoiceRuntimePlatforms,
  downloadReleaseAsset,
  fetchGithubRelease,
  releaseAssetSha256,
} from './generate-voice-runtime-manifest.mjs'

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

async function verifyOnce(manifestPath, repository, token) {
  const release = await fetchGithubRelease(repository, VOICE_RUNTIME_TAG, token)
  if (!release.draft) throw new Error(`${VOICE_RUNTIME_TAG} must remain draft until verification passes`)

  const manifestBytes = await readFile(manifestPath)
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  await assertVoiceRuntimeManifestIdentity(manifest, { repository })

  const expectedNames = new Set(['voice-runtime-manifest.json'])
  for (const platform of VOICE_RUNTIME_CONFIG.platforms) {
    expectedNames.add(platform.asset)
    expectedNames.add(`${platform.asset}.sha256`)
    const ffmpegAsset = `ffmpeg-${platform.os}-${platform.arch}.gz`
    expectedNames.add(ffmpegAsset)
    expectedNames.add(`${ffmpegAsset}.sha256`)
  }
  const voiceAssets = (release.assets || []).filter((asset) =>
    asset.name === 'voice-runtime-manifest.json'
    || asset.name.startsWith('whisper-server-')
    || asset.name.startsWith('ffmpeg-'))
  const unexpected = voiceAssets.filter((asset) => !expectedNames.has(asset.name))
  if (unexpected.length > 0) {
    throw new Error(`release has unexpected voice assets: ${unexpected.map((asset) => asset.name).join(', ')}`)
  }
  for (const name of expectedNames) {
    if (!voiceAssets.some((asset) => asset.name === name)) {
      throw new Error(`release is missing required asset ${name}`)
    }
  }

  const generatedPlatforms = buildVoiceRuntimePlatforms(release.assets, {
    repository,
    tag: VOICE_RUNTIME_TAG,
  })
  if (JSON.stringify(generatedPlatforms) !== JSON.stringify(manifest.platforms)) {
    throw new Error('released runtime assets do not match the generated manifest')
  }
  const generatedFfmpeg = buildVoiceFfmpegPlatforms(release.assets, {
    repository,
    tag: VOICE_RUNTIME_TAG,
  })
  if (JSON.stringify(generatedFfmpeg) !== JSON.stringify(manifest.ffmpeg)) {
    throw new Error('released FFmpeg assets do not match the generated manifest')
  }

  const manifestAsset = voiceAssets.find((asset) => asset.name === 'voice-runtime-manifest.json')
  const localManifestHash = createHash('sha256').update(manifestBytes).digest('hex')
  const localManifestSize = (await stat(manifestPath)).size
  if (manifestAsset.size !== localManifestSize || releaseAssetSha256(manifestAsset) !== localManifestHash) {
    throw new Error('uploaded voice-runtime-manifest.json does not match the verified local manifest')
  }

  for (const platform of VOICE_RUNTIME_CONFIG.platforms) {
    for (const assetName of [
      platform.asset,
      `ffmpeg-${platform.os}-${platform.arch}.gz`,
    ]) {
      const archive = voiceAssets.find((asset) => asset.name === assetName)
      const sidecar = voiceAssets.find((asset) => asset.name === `${assetName}.sha256`)
      const sidecarText = (await downloadReleaseAsset(sidecar, token)).toString('utf8').trim()
      const declaredHash = /^([a-f0-9]{64})\s+/i.exec(sidecarText)?.[1]?.toLowerCase()
      const archiveHash = releaseAssetSha256(archive)
      if (declaredHash !== archiveHash) {
        throw new Error(`${sidecar.name} does not match ${archive.name}`)
      }
    }
  }
}

async function main() {
  const manifestPath = resolve(process.argv[2] || 'src/runtime/channels/data/voice-runtime-manifest.json')
  const repository = String(process.env.GITHUB_REPOSITORY || 'tribgames/mixdog')
  let lastError
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await verifyOnce(manifestPath, repository, process.env.GITHUB_TOKEN)
      console.log(`verified complete draft release ${VOICE_RUNTIME_TAG}`)
      return
    } catch (error) {
      lastError = error
      if (attempt < 5) await delay(attempt * 2_000)
    }
  }
  throw lastError
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exitCode = 1
})
