import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { selectVoiceModelId } from './voice-runtime-fetcher.mjs'

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
