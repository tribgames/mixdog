import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CONFIG_URL = new URL('./voice-runtime-config.json', import.meta.url)
const RELEASE_HASH_INPUTS = [
  CONFIG_URL,
  new URL('../.github/workflows/build-voice-runtime.yml', import.meta.url),
  new URL('./build-voice-runtime-unix.sh', import.meta.url),
  new URL('./build-voice-runtime-windows.ps1', import.meta.url),
  new URL('./build-ffmpeg-runtime.sh', import.meta.url),
  new URL('./generate-voice-runtime-manifest.mjs', import.meta.url),
]

function loadVoiceRuntimeConfig() {
  const config = JSON.parse(readFileSync(CONFIG_URL, 'utf8'))
  if (!/^\d+\.\d+\.\d+$/.test(config.runtimeVersion || '')) {
    throw new Error('voice runtime config has an invalid runtimeVersion')
  }
  if (!/^[a-f0-9]{40}$/.test(config.whisperCommit || '')) {
    throw new Error('voice runtime config has an invalid whisperCommit')
  }
  if (!/^\d+\.\d+\.\d+-mixdog\.\d+$/.test(config.ffmpegVersion || '')) {
    throw new Error('voice runtime config has an invalid ffmpegVersion')
  }
  if (!Array.isArray(config.platforms) || config.platforms.length === 0) {
    throw new Error('voice runtime config has no platforms')
  }
  const keys = new Set()
  const assets = new Set()
  for (const platform of config.platforms) {
    for (const field of ['key', 'os', 'arch', 'backend', 'runner', 'asset', 'executable']) {
      if (!platform[field]) throw new Error(`voice runtime platform is missing ${field}`)
    }
    if (keys.has(platform.key)) throw new Error(`duplicate voice runtime platform ${platform.key}`)
    if (assets.has(platform.asset)) throw new Error(`duplicate voice runtime asset ${platform.asset}`)
    keys.add(platform.key)
    assets.add(platform.asset)
    Object.freeze(platform)
  }
  Object.freeze(config.platforms)
  return Object.freeze(config)
}

export const VOICE_RUNTIME_CONFIG = loadVoiceRuntimeConfig()
export const VOICE_RUNTIME_VERSION = VOICE_RUNTIME_CONFIG.runtimeVersion
export const VOICE_RUNTIME_COMMIT = VOICE_RUNTIME_CONFIG.whisperCommit
export const VOICE_RUNTIME_TAG = `voice-runtime-v${VOICE_RUNTIME_VERSION}`

export function releaseAssetSha256(asset) {
  const digest = String(asset?.digest || '')
  const match = /^sha256:([a-f0-9]{64})$/i.exec(digest)
  if (!match) throw new Error(`release asset ${asset?.name || '(unknown)'} has no SHA256 digest`)
  return match[1].toLowerCase()
}

export async function voiceRuntimeBuildHash() {
  const hash = createHash('sha256')
  for (const input of RELEASE_HASH_INPUTS) {
    hash.update(input.pathname.split('/').pop() || '')
    hash.update('\0')
    hash.update(await readFile(input))
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function compareSemver(left, right) {
  const parse = (value) => {
    if (!/^\d+\.\d+\.\d+$/.test(String(value || ''))) {
      throw new Error(`invalid semantic version ${value || '(missing)'}`)
    }
    return String(value).split('.').map(Number)
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

export function buildVoiceRuntimePlatforms(
  releaseAssets,
  { repository = 'tribgames/mixdog', tag = VOICE_RUNTIME_TAG } = {},
) {
  const byName = new Map((releaseAssets || []).map((asset) => [asset.name, asset]))
  const expectedAssets = new Set(VOICE_RUNTIME_CONFIG.platforms.map((platform) => platform.asset))
  const unexpected = (releaseAssets || []).filter(
    (asset) => /^whisper-server-.*\.zip$/i.test(asset.name) && !expectedAssets.has(asset.name),
  )
  if (unexpected.length > 0) {
    throw new Error(`release has unexpected runtime asset ${unexpected.map((asset) => asset.name).join(', ')}`)
  }
  const platforms = {}
  for (const spec of VOICE_RUNTIME_CONFIG.platforms) {
    const asset = byName.get(spec.asset)
    if (!asset) throw new Error(`release is missing required asset ${spec.asset}`)
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error(`release asset ${spec.asset} has invalid size`)
    }
    const sourceUrl = String(asset.browser_download_url || '')
    const url = `https://github.com/${repository}/releases/download/${tag}/${spec.asset}`
    let validDraftUrl = false
    try {
      const parsed = new URL(sourceUrl)
      const prefix = `/${repository}/releases/download/`
      const parts = parsed.pathname.startsWith(prefix)
        ? parsed.pathname.slice(prefix.length).split('/')
        : []
      validDraftUrl = parsed.origin === 'https://github.com'
        && !parsed.search
        && !parsed.hash
        && parts.length === 2
        && parts[0].startsWith('untagged-')
        && parts[1] === spec.asset
    } catch {
      validDraftUrl = false
    }
    if (sourceUrl !== url && !validDraftUrl) {
      throw new Error(`release asset ${spec.asset} has invalid download URL`)
    }
    platforms[spec.key] = {
      variants: [{
        id: spec.backend,
        requires: null,
        url,
        sha256: releaseAssetSha256(asset),
        size: asset.size,
        format: 'zip',
        executable: spec.executable,
      }],
    }
  }
  return platforms
}

function ffmpegAssetName(spec) {
  return `ffmpeg-${spec.os}-${spec.arch}.gz`
}

export function buildVoiceFfmpegPlatforms(
  releaseAssets,
  { repository = 'tribgames/mixdog', tag = VOICE_RUNTIME_TAG } = {},
) {
  const byName = new Map((releaseAssets || []).map((asset) => [asset.name, asset]))
  const platforms = {}
  for (const spec of VOICE_RUNTIME_CONFIG.platforms) {
    const assetName = ffmpegAssetName(spec)
    const asset = byName.get(assetName)
    if (!asset) throw new Error(`release is missing required asset ${assetName}`)
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error(`release asset ${assetName} has invalid size`)
    }
    platforms[spec.key] = {
      url: `https://github.com/${repository}/releases/download/${tag}/${assetName}`,
      sha256: releaseAssetSha256(asset),
      size: asset.size,
      format: 'gz',
      executable: spec.os === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
    }
  }
  return {
    version: VOICE_RUNTIME_CONFIG.ffmpegVersion,
    source: 'FFmpeg n6.1.1 minimal audio-transcode build',
    platforms,
  }
}

function githubHeaders(token, accept = 'application/vnd.github+json') {
  return {
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mixdog-voice-runtime-manifest',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

export async function fetchGithubRelease(
  repository,
  tag,
  token,
  { allowMissing = false } = {},
) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, {
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(30_000),
      })
      if (response.ok) return response.json()
      if (response.status !== 404) {
        throw new Error(`GitHub release lookup failed: HTTP ${response.status}`)
      }

      // GitHub keeps a hidden draft under an `untagged-*` URL and the
      // releases/tags endpoint returns 404 until publication creates the real
      // tag. Authenticated release listings still expose its requested
      // tag_name, which lets interrupted release runs resume and verify it.
      for (let page = 1; page <= 10; page++) {
        const listing = await fetch(
          `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
          {
            headers: githubHeaders(token),
            signal: AbortSignal.timeout(30_000),
          },
        )
        if (!listing.ok) {
          throw new Error(`GitHub release listing failed: HTTP ${listing.status}`)
        }
        const releases = await listing.json()
        const draft = releases.find((release) => release?.draft && release?.tag_name === tag)
        if (draft) return draft
        if (releases.length < 100) break
      }
      if (allowMissing) return null
      throw new Error('GitHub release lookup failed: HTTP 404')
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1_000))
    }
  }
  throw lastError
}

export async function downloadReleaseAsset(asset, token) {
  if (!asset?.url) throw new Error('release asset has no API URL')
  const response = await fetch(asset.url, {
    headers: githubHeaders(token, 'application/octet-stream'),
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`GitHub release asset download failed: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

export function voiceRuntimeIdentity(manifest) {
  return {
    version: manifest?.version,
    source: manifest?.source,
    release_tag: manifest?.release_tag,
    build_hash: manifest?.build_hash,
    ffmpeg: manifest?.ffmpeg,
    platforms: manifest?.platforms,
  }
}

export function sameVoiceRuntimeIdentity(left, right) {
  return JSON.stringify(voiceRuntimeIdentity(left)) === JSON.stringify(voiceRuntimeIdentity(right))
}

export async function assertVoiceRuntimeManifestIdentity(
  manifest,
  { repository = 'tribgames/mixdog' } = {},
) {
  const expectedSource = `ggml-org/whisper.cpp@${VOICE_RUNTIME_COMMIT}`
  const expectedHash = await voiceRuntimeBuildHash()
  if (manifest?.version !== VOICE_RUNTIME_VERSION) {
    throw new Error(`voice runtime manifest version must be ${VOICE_RUNTIME_VERSION}`)
  }
  if (manifest?.source !== expectedSource) {
    throw new Error(`voice runtime manifest source must be ${expectedSource}`)
  }
  if (manifest?.release_tag !== VOICE_RUNTIME_TAG) {
    throw new Error(`voice runtime manifest release_tag must be ${VOICE_RUNTIME_TAG}`)
  }
  if (manifest?.build_hash !== expectedHash) {
    throw new Error('published voice runtime differs from the current build inputs; bump runtimeVersion')
  }
  const platformKeys = Object.keys(manifest?.platforms || {})
  const expectedKeys = VOICE_RUNTIME_CONFIG.platforms.map((platform) => platform.key)
  if (JSON.stringify(platformKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`voice runtime manifest platforms must be ${expectedKeys.join(', ')}`)
  }
  for (const spec of VOICE_RUNTIME_CONFIG.platforms) {
    const variants = manifest.platforms[spec.key]?.variants
    if (!Array.isArray(variants) || variants.length !== 1) {
      throw new Error(`voice runtime manifest ${spec.key} must have exactly one variant`)
    }
    const variant = variants[0]
    const expectedUrl = `https://github.com/${repository}/releases/download/${VOICE_RUNTIME_TAG}/${spec.asset}`
    if (
      variant.id !== spec.backend
      || variant.requires !== null
      || variant.url !== expectedUrl
      || variant.executable !== spec.executable
      || variant.format !== 'zip'
      || !/^[a-f0-9]{64}$/.test(variant.sha256 || '')
      || !Number.isSafeInteger(variant.size)
      || variant.size <= 0
    ) {
      throw new Error(`voice runtime manifest ${spec.key} does not match the release config`)
    }
  }
  const expectedFfmpeg = buildVoiceFfmpegPlatforms(
    VOICE_RUNTIME_CONFIG.platforms.map((spec, index) => ({
      name: ffmpegAssetName(spec),
      size: index + 1,
      digest: `sha256:${String(index + 1).padStart(64, '0')}`,
    })),
    { repository, tag: VOICE_RUNTIME_TAG },
  )
  if (
    manifest?.ffmpeg?.version !== expectedFfmpeg.version
    || manifest?.ffmpeg?.source !== expectedFfmpeg.source
    || JSON.stringify(Object.keys(manifest?.ffmpeg?.platforms || {}))
      !== JSON.stringify(Object.keys(expectedFfmpeg.platforms))
  ) {
    throw new Error('voice runtime FFmpeg manifest does not match the release config')
  }
  for (const spec of VOICE_RUNTIME_CONFIG.platforms) {
    const actual = manifest.ffmpeg.platforms[spec.key]
    const expected = expectedFfmpeg.platforms[spec.key]
    if (
      actual?.url !== expected.url
      || actual?.format !== expected.format
      || actual?.executable !== expected.executable
      || !/^[a-f0-9]{64}$/.test(actual?.sha256 || '')
      || !Number.isSafeInteger(actual?.size)
      || actual.size <= 0
    ) {
      throw new Error(`voice runtime FFmpeg ${spec.key} does not match the release config`)
    }
  }
}

async function main() {
  const repository = String(process.env.GITHUB_REPOSITORY || 'tribgames/mixdog')
  const tag = String(process.env.RELEASE_TAG || VOICE_RUNTIME_TAG)
  if (tag !== VOICE_RUNTIME_TAG) {
    throw new Error(`voice runtime tag must be ${VOICE_RUNTIME_TAG}, got ${tag}`)
  }
  const manifestPath = resolve(process.argv[2] || 'src/runtime/channels/data/voice-runtime-manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  let platforms
  let ffmpeg
  let lastError
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const release = await fetchGithubRelease(repository, tag, process.env.GITHUB_TOKEN)
      platforms = buildVoiceRuntimePlatforms(release.assets, { repository, tag })
      ffmpeg = buildVoiceFfmpegPlatforms(release.assets, { repository, tag })
      lastError = null
      break
    } catch (error) {
      lastError = error
      if (attempt < 5) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 2_000))
    }
  }
  if (lastError) throw lastError
  manifest.version = VOICE_RUNTIME_VERSION
  manifest.source = `ggml-org/whisper.cpp@${VOICE_RUNTIME_COMMIT}`
  manifest.release_tag = tag
  manifest.build_hash = await voiceRuntimeBuildHash()
  manifest.ffmpeg = ffmpeg
  manifest.platforms = platforms
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`updated ${manifestPath} from ${tag}`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error?.stack || error)
    process.exitCode = 1
  })
}
