import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _extractRuntimeTarGz, _validateRuntimeTarEntries } from './runtime-fetcher.mjs'

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

test('native runtime extraction treats an absolute archive path as local', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-runtime-archive-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  mkdirSync(source)
  writeFileSync(join(source, 'payload.txt'), 'runtime payload')

  const archiveName = 'runtime.tar.gz'
  const created = spawnSync('tar', ['-czf', archiveName, '-C', source, '.'], {
    cwd: root,
    stdio: 'pipe',
    windowsHide: true,
  })
  assert.equal(created.status, 0, created.stderr?.toString())

  _extractRuntimeTarGz(join(root, archiveName), destination, destination)
  assert.equal(readFileSync(join(destination, 'payload.txt'), 'utf8'), 'runtime payload')
})
