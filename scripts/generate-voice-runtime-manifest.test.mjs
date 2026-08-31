import assert from 'node:assert/strict'
import test from 'node:test'

import {
  VOICE_RUNTIME_CONFIG,
  VOICE_RUNTIME_TAG,
  buildVoiceFfmpegPlatforms,
  buildVoiceRuntimePlatforms,
  fetchGithubRelease,
  voiceRuntimeBuildHash,
} from './generate-voice-runtime-manifest.mjs'
import { mergeVoiceRuntimeManifest } from './sync-voice-runtime-manifest.mjs'

const names = VOICE_RUNTIME_CONFIG.platforms.map((platform) => platform.asset)
const ffmpegNames = VOICE_RUNTIME_CONFIG.platforms.map(
  (platform) => `ffmpeg-${platform.os}-${platform.arch}.gz`,
)

test('voice runtime release assets produce a complete fail-closed manifest', () => {
  assert.equal(VOICE_RUNTIME_CONFIG.vulkanSdkVersion, '1.4.309.0')
  const assets = names.map((name, index) => ({
    name,
    size: index + 1,
    digest: `sha256:${String(index + 1).padStart(64, '0')}`,
    browser_download_url: `https://github.com/tribgames/mixdog/releases/download/${VOICE_RUNTIME_TAG}/${name}`,
  }))
  const platforms = buildVoiceRuntimePlatforms(assets)
  assert.equal(platforms['win32-x64'].variants[0].id, 'vulkan')
  assert.equal(platforms['linux-x64'].variants[0].id, 'vulkan')
  assert.equal(platforms['linux-arm64'].variants[0].id, 'vulkan')
  assert.equal(platforms['darwin-arm64'].variants[0].id, 'metal')
  assert.equal(platforms['darwin-x64'].variants[0].id, 'cpu')
  assert.equal(platforms['win32-x64'].variants[0].executable, 'whisper-server.exe')
  assert.deepEqual(
    VOICE_RUNTIME_CONFIG.platforms
      .filter((platform) => platform.os === 'linux')
      .map((platform) => platform.runner),
    ['ubuntu-24.04', 'ubuntu-24.04-arm'],
  )
})

test('voice runtime manifest generation rejects a partial release', () => {
  assert.throws(() => buildVoiceRuntimePlatforms([]), /missing required asset/)
})

test('voice runtime release assets produce a minimal FFmpeg manifest', () => {
  const assets = ffmpegNames.map((name, index) => ({
    name,
    size: index + 1,
    digest: `sha256:${String(index + 1).padStart(64, '0')}`,
  }))
  const ffmpeg = buildVoiceFfmpegPlatforms(assets)
  assert.equal(ffmpeg.version, VOICE_RUNTIME_CONFIG.ffmpegVersion)
  assert.equal(ffmpeg.platforms['win32-x64'].format, 'gz')
  assert.equal(ffmpeg.platforms['win32-x64'].executable, 'ffmpeg.exe')
  assert.equal(ffmpeg.platforms['darwin-arm64'].executable, 'ffmpeg')
})

test('voice runtime manifest generation rejects undeclared archives', () => {
  assert.throws(
    () => buildVoiceRuntimePlatforms([{
      name: 'whisper-server-linux-riscv64-cpu.zip',
      size: 1,
      digest: `sha256:${'1'.padStart(64, '0')}`,
      browser_download_url:
        `https://github.com/tribgames/mixdog/releases/download/${VOICE_RUNTIME_TAG}/whisper-server-linux-riscv64-cpu.zip`,
    }]),
    /unexpected runtime asset/,
  )
})

test('voice runtime manifest normalizes hidden draft asset URLs to the published tag', () => {
  const assets = names.map((name, index) => ({
    name,
    size: index + 1,
    digest: `sha256:${String(index + 1).padStart(64, '0')}`,
    browser_download_url:
      `https://github.com/tribgames/mixdog/releases/download/untagged-fixture/${name}`,
  }))
  const platforms = buildVoiceRuntimePlatforms(assets)
  assert.equal(
    platforms['win32-x64'].variants[0].url,
    `https://github.com/tribgames/mixdog/releases/download/${VOICE_RUNTIME_TAG}/whisper-server-win32-x64-vulkan.zip`,
  )
})

test('voice runtime release lookup finds an authenticated untagged draft', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const requests = []
  globalThis.fetch = async (url) => {
    requests.push(String(url))
    if (String(url).includes('/releases/tags/')) {
      return new Response(null, { status: 404 })
    }
    return Response.json([{
      tag_name: VOICE_RUNTIME_TAG,
      draft: true,
      assets: [],
    }])
  }

  const release = await fetchGithubRelease(
    'tribgames/mixdog',
    VOICE_RUNTIME_TAG,
    'fixture-token',
  )
  assert.equal(release.draft, true)
  assert.equal(release.tag_name, VOICE_RUNTIME_TAG)
  assert.equal(requests.length, 2)
  assert.match(requests[1], /\/releases\?per_page=100&page=1$/)
})

test('voice runtime build identity is stable and merge preserves model metadata', async () => {
  const buildHash = await voiceRuntimeBuildHash()
  assert.match(buildHash, /^[a-f0-9]{64}$/)
  const platforms = Object.fromEntries(VOICE_RUNTIME_CONFIG.platforms.map((platform, index) => [
    platform.key,
    {
      variants: [{
        id: platform.backend,
        requires: null,
        url: `https://github.com/tribgames/mixdog/releases/download/${VOICE_RUNTIME_TAG}/${platform.asset}`,
        sha256: String(index + 1).padStart(64, '0'),
        size: index + 1,
        format: 'zip',
        executable: platform.executable,
      }],
    },
  ]))
  const current = {
    version: '1.8.4',
    source: 'old',
    model: { id: 'standard' },
    ffmpeg: { version: 'b6.1.1' },
    platforms: {},
  }
  const ffmpeg = buildVoiceFfmpegPlatforms(ffmpegNames.map((name, index) => ({
    name,
    size: index + 1,
    digest: `sha256:${String(index + 1).padStart(64, '0')}`,
  })))
  const released = {
    ...current,
    version: VOICE_RUNTIME_CONFIG.runtimeVersion,
    source: `ggml-org/whisper.cpp@${VOICE_RUNTIME_CONFIG.whisperCommit}`,
    release_tag: VOICE_RUNTIME_TAG,
    build_hash: buildHash,
    ffmpeg,
    platforms,
  }
  const merged = await mergeVoiceRuntimeManifest(current, released)
  assert.strictEqual(merged.model, current.model)
  assert.deepEqual(merged.ffmpeg, ffmpeg)
  assert.deepEqual(merged.platforms, platforms)
})
