import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _validateRuntimeTarEntries } from './runtime-fetcher.mjs'

test('native runtime tar allows internal links and rejects unsafe entries', () => {
  const base = join(tmpdir(), 'mixdog-runtime-staging')
  assert.doesNotThrow(() => _validateRuntimeTarEntries(
    ['./runtime/', './runtime/bin/tool', './runtime/link', './runtime/hard'],
    [
      'drwxr-xr-x user/group 0 date ./runtime/',
      '-rwxr-xr-x user/group 1 date ./runtime/bin/tool',
      'lrwxrwxrwx user/group 0 date ./runtime/link -> bin/tool',
      'hrw-r--r-- user/group 0 date ./runtime/hard link to ./runtime/bin/tool',
    ],
    base,
  ))
  assert.throws(
    () => _validateRuntimeTarEntries(['../escape'], ['-rw-r--r-- escape'], base),
    /unsafe entry/,
  )
  assert.throws(
    () => _validateRuntimeTarEntries(['runtime/link'], ['lrwxrwxrwx runtime/link -> outside'], base),
    /link target is unsafe/,
  )
  assert.throws(
    () => _validateRuntimeTarEntries(
      ['runtime/link', 'runtime/target'],
      ['lrwxrwxrwx runtime/link -> ../../../outside', '-rw-r--r-- runtime/target'],
      base,
    ),
    /link target is unsafe/,
  )
  assert.throws(
    () => _validateRuntimeTarEntries(['runtime/fifo'], ['prw-r--r-- runtime/fifo'], base),
    /entry type is unsafe/,
  )
})
