import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveVoiceRuntime, selectVoiceModelId } from './voice-runtime-fetcher.mjs'

test('managed voice always uses the standard multilingual model', () => {
  assert.equal(selectVoiceModelId(), 'standard')
  assert.equal(selectVoiceModelId({ model: 'korean', language: 'ko' }), 'standard')
})

test('voice manifest contains no language-specific model', async () => {
  const manifestPath = new URL('../data/voice-runtime-manifest.json', import.meta.url)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.deepEqual(Object.keys(manifest.models), ['standard'])
  assert.equal(manifest.models.standard.id, 'large-v3-turbo-q8_0')
})

test('voice runtime resolution removes superseded published versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-voice-runtime-gc-'))
  try {
    const manifestPath = new URL('../data/voice-runtime-manifest.json', import.meta.url)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const key = `${process.platform}-${process.arch}`
    const variant = manifest.platforms[key].variants[0]
    const activeWhisper = `whisper-${manifest.version}-${variant.id}`
    const activeFfmpeg = `ffmpeg-${manifest.ffmpeg.version}`
    const whisperRoot = join(root, 'voice-runtime')
    const ffmpegRoot = join(root, 'ffmpeg-runtime')
    await mkdir(join(whisperRoot, activeWhisper), { recursive: true })
    await mkdir(join(whisperRoot, 'whisper-old'), { recursive: true })
    await mkdir(join(ffmpegRoot, activeFfmpeg), { recursive: true })
    await mkdir(join(ffmpegRoot, 'ffmpeg-old'), { recursive: true })
    await writeFile(join(whisperRoot, 'active-version'), activeWhisper)
    await writeFile(join(ffmpegRoot, 'active-version'), activeFfmpeg)
    await writeFile(join(whisperRoot, activeWhisper, variant.executable), 'binary')
    await writeFile(join(ffmpegRoot, activeFfmpeg, manifest.ffmpeg.platforms[key].executable), 'binary')

    resolveVoiceRuntime(root)

    await assert.rejects(access(join(whisperRoot, 'whisper-old')))
    await assert.rejects(access(join(ffmpegRoot, 'ffmpeg-old')))
    await access(join(whisperRoot, activeWhisper, variant.executable))
    await access(join(ffmpegRoot, activeFfmpeg, manifest.ffmpeg.platforms[key].executable))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
