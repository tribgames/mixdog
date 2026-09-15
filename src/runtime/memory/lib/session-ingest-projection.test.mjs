import assert from 'node:assert/strict'
import test from 'node:test'

import {
  projectSessionMessagesForIngest,
  sessionMessageContentForIngest,
  shouldExcludeIngestMessage,
} from './session-ingest.mjs'

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

test('user-turn prefix envelopes strip only manager.mjs start-anchored sections', () => {
  const content = [
    '# Session',
    'Cwd: C:\\\\Project\\\\mixdog',
    'Model: test',
    'Workflow: solo',
    '',
    '# Project Instructions',
    'repo-local rules',
    '# Additional context',
    'prefetch notes',
    '# Prefetch',
    'file list',
    '# Task',
    'real user prompt',
  ].join('\n')
  assert.equal(sessionMessageContentForIngest({ role: 'user', content }), 'real user prompt')
  assert.equal(
    sessionMessageContentForIngest({ role: 'user', content: '# Session\nmeeting notes\n# Task is later' }),
    '# Session\nmeeting notes\n# Task is later',
  )
})

test('ingest exclusion drops synthetic rows and keeps conversation', () => {
  assert.equal(shouldExcludeIngestMessage({ role: 'user', content: 'Reference files:\nfoo.ts' }), true)
  assert.equal(shouldExcludeIngestMessage({ role: 'user', content: '(attachment)' }), true)
  assert.equal(shouldExcludeIngestMessage({ role: 'user', content: '<skill>body</skill>', meta: 'skill' }), true)
  assert.equal(shouldExcludeIngestMessage({ role: 'user', content: '[mixdog-runtime] continue' }), true)
  assert.equal(shouldExcludeIngestMessage({ role: 'assistant', content: '.', toolCalls: undefined }), true)
  assert.equal(shouldExcludeIngestMessage({ role: 'user', content: 'please continue the task' }), false)
  assert.equal(shouldExcludeIngestMessage({ role: 'assistant', content: 'working on it' }), false)
})
