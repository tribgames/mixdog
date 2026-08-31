import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { gcSupersededNativeToolCaches } from './native-runtime-cache-gc.mjs'

test('packaged native tools remove only their superseded download caches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-native-cache-gc-'))
  try {
    for (const directory of ['graph-bin', 'patch-bin', 'spawn-bin']) {
      await mkdir(join(root, directory), { recursive: true })
      await writeFile(join(root, directory, 'fixture.exe'), 'fixture')
    }

    const result = await gcSupersededNativeToolCaches(root, ['graph', 'patch'])

    await assert.rejects(access(join(root, 'graph-bin')))
    await assert.rejects(access(join(root, 'patch-bin')))
    await access(join(root, 'spawn-bin', 'fixture.exe'))
    assert.deepEqual(result.removed, ['graph', 'patch'])
    assert.deepEqual(result.failed, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
