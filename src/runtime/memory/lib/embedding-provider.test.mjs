import assert from 'node:assert/strict'
import test from 'node:test'

import { embeddingWorkerExecArgv } from './embedding-provider.mjs'

test('embedding worker keeps safe Node flags but drops inherited isolate heap flags', () => {
  assert.deepEqual(embeddingWorkerExecArgv([
    '--max-old-space-size=512',
    '--max-semi-space-size=32',
    '--initial-old-space-size=128',
    '--input-type=module',
    '--trace-warnings',
    '--require',
    'loader.cjs',
  ]), [
    '--trace-warnings',
    '--require',
    'loader.cjs',
  ])
})
