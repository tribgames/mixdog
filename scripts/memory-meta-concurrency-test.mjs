#!/usr/bin/env node
// Regression: mergeMetaValue uses jsonb shallow merge (not full replace).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeMetaValue } from '../src/runtime/memory/lib/memory.mjs'

test('mergeMetaValue issues INSERT ... ON CONFLICT DO UPDATE with jsonb ||', async () => {
  const calls = []
  const db = {
    async query(sql, params) {
      calls.push({ sql, params })
    },
  }
  await mergeMetaValue(db, 'state.cycle_last_run', { cycle1: 100, cycle2_last_error: '' })
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /COALESCE\(meta\.value/)
  assert.match(calls[0].sql, /\|\| EXCLUDED\.value/)
  assert.deepEqual(calls[0].params, ['state.cycle_last_run', '{"cycle1":100,"cycle2_last_error":""}'])
})

