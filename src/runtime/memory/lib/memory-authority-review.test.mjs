import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectMemoryAuthority, pendingAuthorityReview, renderMemoryAuthority } from './memory-authority-review.mjs'

test('skill changes are included in authority evidence and its fingerprint', t => {
  const root = mkdtempSync(join(tmpdir(), 'memory-authority-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const skill = join(root, 'defaults', 'skills', 'office')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), 'Keep background windows hidden.')
  const first = collectMemoryAuthority(root, null)
  assert.match(first.text, /Keep background windows hidden/)
  writeFileSync(join(skill, 'SKILL.md'), 'Require an explicit request for visible windows.')
  assert.notEqual(collectMemoryAuthority(root, null).hash, first.hash)
})

test('changed authority queues review until old active records are reviewed, without altering records', async () => {
  let state
  let reviewedAt = 1
  const db = { query: async (sql, args) => {
    if (sql.startsWith('SELECT value')) return { rows: state ? [{ value: state }] : [] }
    if (sql.startsWith('INSERT INTO meta')) {
      state = JSON.parse(args[1])
      return { rows: [] }
    }
    if (sql.startsWith('SELECT id FROM entries')) {
      return { rows: reviewedAt < args[0] ? [{ id: 1 }] : [] }
    }
    throw new Error('Unexpected mutation or query')
  } }
  assert.equal(await pendingAuthorityReview(db, { hash: 'a' }, 10), 10)
  assert.equal(await pendingAuthorityReview(db, { hash: 'a' }, 20), 10)
  reviewedAt = 11
  assert.equal(await pendingAuthorityReview(db, { hash: 'a' }, 30), null)
  assert.equal(await pendingAuthorityReview(db, { hash: 'b' }, 40), 40)
})

test('bounded review includes later sources instead of dropping their entire contracts', () => {
  const parts = ['# Source: first\n' + 'a'.repeat(8000), '# Source: last\nAn existing tool already guarantees this.']
  const rendered = renderMemoryAuthority({ parts, text: parts.join('\n\n---\n\n') }, 500)
  assert.ok(rendered.length <= 500)
  assert.match(rendered, /# Source: first/)
  assert.match(rendered, /# Source: last/)
  assert.match(rendered, /already guarantees this/)
  assert.match(rendered, /Source truncated/)
})
