import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NATIVE_TOOL_KINDS,
  NATIVE_TOOL_PLATFORM_KEYS,
  nativeToolAssetName,
  nativeToolAssetUrl,
  nativeToolInstalledName,
  nativeToolPlatformAssets,
} from './native-tool-download.mjs'
import {
  GRAPH_PLATFORMS,
  PATCH_PLATFORMS,
  SPAWN_PLATFORMS,
} from './verify-release-assets.mjs'

const PATCH_FILES = {
  'darwin-arm64': 'mixdog-patch-darwin-arm64',
  'darwin-x64': 'mixdog-patch-darwin-x64',
  'linux-arm64': 'mixdog-patch-linux-arm64',
  'linux-x64': 'mixdog-patch-linux-x64',
  'win32-x64': 'mixdog-patch-win32-x64.exe',
}
const GRAPH_FILES = {
  'darwin-arm64': 'mixdog-graph-darwin-arm64',
  'darwin-x64': 'mixdog-graph-darwin-x64',
  'linux-arm64': 'mixdog-graph-linux-arm64',
  'linux-x64': 'mixdog-graph-linux-x64',
  'win32-x64': 'mixdog-graph-win32-x64.exe',
}
const SPAWN_FILES = {
  'darwin-arm64': 'mixdog-spawn-darwin-arm64',
  'darwin-x64': 'mixdog-spawn-darwin-x64',
  'linux-arm64': 'mixdog-spawn-linux-arm64',
  'linux-x64': 'mixdog-spawn-linux-x64',
  'win32-x64': 'mixdog-spawn-win32-x64.exe',
}

test('native tool platform assets keep the published filenames', () => {
  assert.deepEqual([...NATIVE_TOOL_KINDS], ['graph', 'patch', 'spawn'])
  assert.deepEqual([...NATIVE_TOOL_PLATFORM_KEYS], Object.keys(PATCH_FILES))
  assert.equal(nativeToolAssetName('patch', { platform: 'win32', arch: 'x64' }), PATCH_FILES['win32-x64'])
  assert.equal(nativeToolAssetName('graph', { platform: 'darwin', arch: 'arm64' }), GRAPH_FILES['darwin-arm64'])
  assert.equal(nativeToolInstalledName('spawn', { platform: 'linux', arch: 'x64' }), 'mixdog-spawn')
  assert.equal(nativeToolInstalledName('spawn', { platform: 'win32', arch: 'x64' }), 'mixdog-spawn.exe')
  assert.equal(
    nativeToolAssetUrl('patch', '1.2.3', { platform: 'linux', arch: 'arm64' }),
    'https://github.com/tribgames/mixdog/releases/download/patch-v1.2.3/mixdog-patch-linux-arm64',
  )
  assert.deepEqual(nativeToolPlatformAssets('patch'), PATCH_FILES)
  assert.deepEqual(nativeToolPlatformAssets('graph'), GRAPH_FILES)
  assert.deepEqual(nativeToolPlatformAssets('spawn'), SPAWN_FILES)
  assert.deepEqual(PATCH_PLATFORMS, PATCH_FILES)
  assert.deepEqual(GRAPH_PLATFORMS, GRAPH_FILES)
  assert.deepEqual(SPAWN_PLATFORMS, SPAWN_FILES)
})
