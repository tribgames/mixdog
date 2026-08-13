import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { _extractTar, _verifyKiwiModelArchive } from './ko-morph.mjs'
import { _validateRuntimeTarEntries } from './runtime-fetcher.mjs'

const REQUIRED = ['combiningRule.txt', 'default.dict', 'extract.mdl', 'sj.knlm', 'sj.morph']

function tarEntry(name, body = Buffer.alloc(0), type = '0') {
  const bytes = Buffer.from(body)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write(bytes.length.toString(8).padStart(11, '0'), 124, 11, 'ascii')
  header[135] = 0
  header[156] = type.charCodeAt(0)
  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512)
  return Buffer.concat([header, bytes, padding])
}

function modelTar(extra = []) {
  return Buffer.concat([
    tarEntry('base/', '', '5'),
    ...REQUIRED.map((name) => tarEntry(`base/${name}`, `data:${name}`)),
    ...extra,
    Buffer.alloc(1024),
  ])
}

test('Kiwi archive verifies size and sha256 and caps decompression', () => {
  const payload = modelTar()
  const gz = gzipSync(payload)
  const sha256 = createHash('sha256').update(gz).digest('hex')
  assert.deepEqual(_verifyKiwiModelArchive(gz, {
    expectedBytes: gz.length,
    expectedSha256: sha256,
    maxTarBytes: payload.length,
  }), payload)
  assert.throws(() => _verifyKiwiModelArchive(gz, {
    expectedBytes: gz.length,
    expectedSha256: '0'.repeat(64),
    maxTarBytes: payload.length,
  }), /sha256 mismatch/)
  assert.throws(() => _verifyKiwiModelArchive(gz, {
    expectedBytes: gz.length,
    expectedSha256: sha256,
    maxTarBytes: 512,
  }), /decompression failed or exceeds/)
})

test('Kiwi tar writes only the pinned regular file set', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-kiwi-tar-'))
  const dest = join(root, 'model')
  mkdirSync(dest)
  try {
    const written = _extractTar(modelTar([tarEntry('base/typo.dict', 'optional')]), dest)
    assert.deepEqual(written.sort(), [...REQUIRED, 'typo.dict'].sort())
    assert.equal(readFileSync(join(dest, 'default.dict'), 'utf8'), 'data:default.dict')
    assert.throws(
      () => _extractTar(modelTar([tarEntry('base/escape', 'bad')]), dest),
      /unexpected file/,
    )
    assert.throws(
      () => _extractTar(modelTar([tarEntry('base/link', '', '2')]), dest),
      /unsupported entry type/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

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
