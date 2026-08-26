import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createTranscriptIngest } from './transcript-ingest.mjs'

test('transcript watcher initialization waits for the first active-session sweep', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mixdog-transcript-watch-'))
  const projectDir = path.join(root, 'project')
  const sessionId = 'sess_readiness_regression'
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`)
  const inserts = []
  let offsets = '{}'
  let watcher = null

  try {
    await mkdir(projectDir, { recursive: true })
    await writeFile(transcriptPath, `${JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      cwd: projectDir,
      message: { content: 'persisted before memory readiness' },
    })}\n`)

    const ingest = createTranscriptIngest({
      getDb: () => ({
        async query(_sql, values) {
          inserts.push(values)
          return { rowCount: 1 }
        },
      }),
      loadMeta: async () => offsets,
      persistMeta: async (value) => { offsets = value },
      projectsRoot: () => root,
      resolveProjectId: () => 'project-readiness',
      firstTextContent: (value) => String(value ?? ''),
      cleanMemoryText: (value) => String(value ?? '').trim(),
    })

    await ingest.loadTranscriptOffsets()
    watcher = await ingest.initTranscriptWatcher()

    assert.equal(inserts.length, 1)
    assert.equal(inserts[0][2], 'persisted before memory readiness')
    assert.equal(inserts[0][4], sessionId)
  } finally {
    watcher?.stop()
    await rm(root, { recursive: true, force: true })
  }
})
