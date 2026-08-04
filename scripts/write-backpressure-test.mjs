import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  TRACE_QUEUE_MAX_PENDING_EVENTS,
  enqueueTraceEvents,
  getTraceQueueStats,
} from '../src/runtime/memory/lib/trace-store.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appenderModuleUrl = pathToFileURL(join(root, 'src/runtime/shared/buffered-appender.mjs')).href

test('buffered appender caps stalled writes by dropping oldest bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-buffered-appender-cap-'))
  const loaderPath = join(dir, 'loader.mjs')
  const delayedFsPath = join(dir, 'delayed-fs-promises.mjs')
  const outputPath = join(dir, 'output.log')
  try {
    writeFileSync(delayedFsPath, `
      import { appendFile as realAppendFile } from 'node:fs/promises'
      export async function appendFile(...args) {
        await new Promise(resolve => setTimeout(resolve, 200))
        return realAppendFile(...args)
      }
    `)
    writeFileSync(loaderPath, `
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === 'node:fs/promises' && context.parentURL === ${JSON.stringify(appenderModuleUrl)}) {
          return { url: new URL('./delayed-fs-promises.mjs', import.meta.url).href, shortCircuit: true }
        }
        return nextResolve(specifier, context)
      }
    `)
    const child = spawnSync(process.execPath, [
      '--experimental-loader', pathToFileURL(loaderPath).href,
      '--input-type=module', '-e',
      `
        import assert from 'node:assert/strict'
        import { readFileSync } from 'node:fs'
        import {
          BUFFERED_APPEND_MAX_BYTES, appendBuffered, drainPathSync, getBufferedAppenderStats,
        } from ${JSON.stringify(appenderModuleUrl)}
        const initial = 'I'.repeat(32 * 1024)
        const old = 'O'.repeat(BUFFERED_APPEND_MAX_BYTES)
        const newest = 'N'.repeat(64 * 1024)
        appendBuffered(process.env.OUTPUT_PATH, initial)
        appendBuffered(process.env.OUTPUT_PATH, old)
        appendBuffered(process.env.OUTPUT_PATH, newest)
        const stats = getBufferedAppenderStats(process.env.OUTPUT_PATH)
        assert.equal(stats.bufferedBytes, BUFFERED_APPEND_MAX_BYTES)
        assert.equal(stats.droppedBytes, newest.length)
        drainPathSync(process.env.OUTPUT_PATH)
        await new Promise(resolve => setTimeout(resolve, 250))
        const written = readFileSync(process.env.OUTPUT_PATH, 'utf8')
        const retainedOld = old.slice(newest.length)
        assert.equal(written, initial + retainedOld + newest + initial)

        const unicodePath = process.env.UNICODE_OUTPUT_PATH
        const emoji = '😀'
        const unicodeOld = emoji.repeat(BUFFERED_APPEND_MAX_BYTES / Buffer.byteLength(emoji, 'utf8'))
        appendBuffered(unicodePath, initial)
        appendBuffered(unicodePath, unicodeOld)
        appendBuffered(unicodePath, 'x')
        const unicodeStats = getBufferedAppenderStats(unicodePath)
        assert.equal(unicodeStats.bufferedBytes, BUFFERED_APPEND_MAX_BYTES - 3)
        assert.equal(unicodeStats.droppedBytes, 4)
        drainPathSync(unicodePath)
        await new Promise(resolve => setTimeout(resolve, 250))
        assert.equal(readFileSync(unicodePath, 'utf8'), initial + unicodeOld.slice(2) + 'x' + initial)
        assert.equal(getBufferedAppenderStats(unicodePath).droppedBytes, 4)

        const oversizedPath = process.env.OVERSIZED_OUTPUT_PATH
        const oversized = 'Z'.repeat(BUFFERED_APPEND_MAX_BYTES * 2)
        appendBuffered(oversizedPath, initial)
        appendBuffered(oversizedPath, oversized)
        const oversizedStats = getBufferedAppenderStats(oversizedPath)
        assert.equal(oversizedStats.bufferedBytes, BUFFERED_APPEND_MAX_BYTES)
        assert.equal(oversizedStats.droppedBytes, BUFFERED_APPEND_MAX_BYTES)
        drainPathSync(oversizedPath)
        await new Promise(resolve => setTimeout(resolve, 250))
        assert.equal(readFileSync(oversizedPath, 'utf8'), initial + oversized.slice(-BUFFERED_APPEND_MAX_BYTES) + initial)

        const oversizedUnicodePath = process.env.OVERSIZED_UNICODE_OUTPUT_PATH
        const oversizedUnicode = emoji.repeat(BUFFERED_APPEND_MAX_BYTES / 2 + 1)
        const oversizedUnicodeBytes = Buffer.byteLength(oversizedUnicode, 'utf8')
        appendBuffered(oversizedUnicodePath, initial)
        appendBuffered(oversizedUnicodePath, oversizedUnicode)
        const oversizedUnicodeStats = getBufferedAppenderStats(oversizedUnicodePath)
        assert.equal(oversizedUnicodeStats.bufferedBytes, BUFFERED_APPEND_MAX_BYTES)
        assert.equal(oversizedUnicodeStats.droppedBytes, oversizedUnicodeBytes - BUFFERED_APPEND_MAX_BYTES)
        drainPathSync(oversizedUnicodePath)
        await new Promise(resolve => setTimeout(resolve, 250))
        assert.equal(readFileSync(oversizedUnicodePath, 'utf8'), initial + oversizedUnicode.slice(-BUFFERED_APPEND_MAX_BYTES / 2) + initial)
      `,
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        OUTPUT_PATH: outputPath,
        UNICODE_OUTPUT_PATH: join(dir, 'unicode-output.log'),
        OVERSIZED_OUTPUT_PATH: join(dir, 'oversized-output.log'),
        OVERSIZED_UNICODE_OUTPUT_PATH: join(dir, 'oversized-unicode-output.log'),
      },
      timeout: 5_000,
    })
    assert.equal(child.status, 0, child.stderr || child.stdout)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('trace queue caps pending events by dropping oldest entries', async () => {
  let releaseFirstFlush
  const firstFlush = new Promise(resolve => { releaseFirstFlush = resolve })
  const calls = []
  const db = {
    query(sql, params) {
      calls.push({ sql, params })
      return calls.length === 1 ? firstFlush : Promise.resolve()
    },
  }
  const firstBatch = Array.from({ length: 500 }, (_, i) => ({ kind: `first-${i}` }))
  const burst = Array.from(
    { length: TRACE_QUEUE_MAX_PENDING_EVENTS + 64 },
    (_, i) => ({ kind: `burst-${i}` }),
  )

  enqueueTraceEvents(db, firstBatch)
  enqueueTraceEvents(db, burst)
  const stats = getTraceQueueStats(db)
  assert.equal(stats.pendingEvents, TRACE_QUEUE_MAX_PENDING_EVENTS)
  assert.equal(stats.droppedEvents, 64)

  releaseFirstFlush()
  await new Promise(resolve => setTimeout(resolve, 250))
  const chunkCalls = calls.slice(1)
  assert.equal(chunkCalls.length, Math.ceil(TRACE_QUEUE_MAX_PENDING_EVENTS / Math.floor(65_535 / 17)))
  assert.ok(chunkCalls.every(call => call.params.length <= 65_535))
  const retainedKinds = chunkCalls.flatMap(call => call.params.filter((_, i) => i % 17 === 3))
  assert.deepEqual(retainedKinds, burst.slice(64).map(event => event.kind))
})
