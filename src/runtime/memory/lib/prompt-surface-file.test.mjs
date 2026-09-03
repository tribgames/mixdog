import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  writePromptSurfaceSnapshot, readPromptSurfaceFile, renderPromptSurfaceDigest, promptSurfaceHash,
} from './prompt-surface-file.mjs'

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-surface-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('snapshot round-trips rules and tool descriptions', () => withDir(async (dir) => {
  const first = await writePromptSurfaceSnapshot(dir, {
    rules: ['# Tool Workflow\n- Confirm destructive actions.', ''],
    tools: [{ name: 'goal', description: 'Manage durable tasks.\n  paused is the single user-wait state' }, { name: 'x', description: '' }],
  })
  assert.equal(first.written, true)
  const surface = readPromptSurfaceFile(dir)
  assert.equal(surface.rules.length, 1)
  assert.deepEqual(surface.tools, [{ name: 'goal', description: 'Manage durable tasks. paused is the single user-wait state' }])
  assert.equal(surface.hash, promptSurfaceHash(surface))
  const digest = renderPromptSurfaceDigest(surface)
  assert.match(digest, /Confirm destructive actions/)
  assert.match(digest, /- goal: Manage durable tasks\. paused is the single user-wait state/)
}))

test('unchanged surface is not rewritten; changed surface is', () => withDir(async (dir) => {
  const input = { rules: ['rule A'], tools: [{ name: 't', description: 'd' }] }
  const a = await writePromptSurfaceSnapshot(dir, input, { now: 1 })
  const b = await writePromptSurfaceSnapshot(dir, input, { now: 2 })
  assert.equal(a.written, true)
  assert.equal(b.written, false)
  assert.equal(readPromptSurfaceFile(dir).updatedAt, 1)
  const c = await writePromptSurfaceSnapshot(dir, { ...input, rules: ['rule B'] }, { now: 3 })
  assert.equal(c.written, true)
  assert.equal(readPromptSurfaceFile(dir).updatedAt, 3)
}))

test('empty input writes nothing and missing file reads as null', () => withDir(async (dir) => {
  const r = await writePromptSurfaceSnapshot(dir, { rules: [], tools: [] })
  assert.equal(r.written, false)
  assert.equal(readPromptSurfaceFile(dir), null)
  assert.equal(renderPromptSurfaceDigest(null), '')
}))
