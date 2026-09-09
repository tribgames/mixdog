import test from 'node:test'
import assert from 'node:assert/strict'
import { createHttpRouter } from './http-router.mjs'

test('HTTP session payload cannot reintroduce generated summaries', async () => {
  const router = createHttpRouter({
    getDb: () => ({
      query: async (_sql, params) => ({
        rows: params?.length ? [] : [{ id: 1, summary: 'User-approved preference' }],
      }),
    }),
  })
  const payload = await router.buildSessionCoreMemoryPayload(null)
  assert.deepEqual(payload.dbLines, [])
  assert.deepEqual(payload.userLines, ['User-approved preference'])
})
