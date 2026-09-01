import assert from 'node:assert/strict'
import test from 'node:test'

import { projectSessionMessagesForIngest } from './session-ingest.mjs'

test('session ingest projection preserves every text block in a user message', () => {
  const projected = projectSessionMessagesForIngest([{
    role: 'user',
    content: [
      { type: 'text', text: '<system-reminder>runtime context</system-reminder>' },
      { type: 'text', text: 'actual user instruction' },
      { type: 'image', source: 'ignored-binary' },
      { type: 'text', text: 'pasted continuation' },
    ],
  }])

  assert.equal(projected.length, 1)
  assert.match(projected[0].content, /actual user instruction/)
  assert.match(projected[0].content, /pasted continuation/)
})

test('session ingest projection excludes Compact active-turn continuation rows', () => {
  const projected = projectSessionMessagesForIngest([
    { role: 'user', content: 'actual user instruction' },
    {
      role: 'user',
      content: [
        '<system-reminder>',
        '<active-turn-continuation>',
        'continue without repeating completed tool calls',
        '</active-turn-continuation>',
        '</system-reminder>',
      ].join('\n'),
      meta: {
        source: 'compact-active-turn-continuation',
        synthetic: true,
      },
    },
  ])

  assert.deepEqual(projected, [{
    role: 'user',
    content: 'actual user instruction',
  }])
})
