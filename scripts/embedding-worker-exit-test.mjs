import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const providerUrl = new URL('../src/runtime/memory/lib/embedding-provider.mjs', import.meta.url)
const CHILD_DEADLINE_MS = 3_000

async function createExitWorkerFixture() {
  const tempDir = await mkdtemp(join(tmpdir(), 'mixdog-embed-worker-exit-'))
  const workerPath = join(tempDir, 'exit-before-reply.mjs')
  await writeFile(workerPath, `
    import { parentPort } from 'node:worker_threads'
    parentPort.once('message', () => process.exit(0))
  `)
  const source = await readFile(providerUrl, 'utf8')
  const instrumented = source
    .replace("'./memory-log.mjs'", JSON.stringify(new URL('../src/runtime/memory/lib/memory-log.mjs', import.meta.url).href))
    .replace("'./model-profile.mjs'", JSON.stringify(new URL('../src/runtime/memory/lib/model-profile.mjs', import.meta.url).href))
    .replace("'./embedding-model-config.mjs'", JSON.stringify(new URL('../src/runtime/memory/lib/embedding-model-config.mjs', import.meta.url).href))
    .replace(/^const WORKER_PATH = .*$/m, `const WORKER_PATH = ${JSON.stringify(workerPath)}`)
  const providerModule = `data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}#${Date.now()}`
  const fixturePath = join(tempDir, 'run-exit-test.mjs')
  await writeFile(fixturePath, `
    import { embedText } from ${JSON.stringify(providerModule)}
    const started = Date.now()
    const settled = await Promise.allSettled([embedText('first'), embedText('second')])
    if (Date.now() - started >= 2_000) throw new Error('worker exit did not reject pending embeds promptly')
    if (settled.some(({ status }) => status !== 'rejected')) throw new Error('worker exit resolved a pending embed')
    for (const result of settled) {
      if (result.reason?.message !== 'Worker exited with code 0') throw result.reason
    }
    process.stdout.write('ok')
  `)
  return { fixturePath, tempDir }
}

function runFixture(fixturePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixturePath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const deadline = setTimeout(() => {
      timedOut = true
      child.kill()
    }, CHILD_DEADLINE_MS)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => {
      clearTimeout(deadline)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(deadline)
      if (timedOut) {
        reject(new Error(`exit-worker fixture exceeded ${CHILD_DEADLINE_MS}ms and was killed`))
        return
      }
      resolve({ code, signal, stdout, stderr })
    })
  })
}

test('code-zero worker exit before reply promptly rejects every pending embed', async () => {
  const { fixturePath, tempDir } = await createExitWorkerFixture()
  try {
    const result = await runFixture(fixturePath)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.signal, null, result.stderr)
    assert.equal(result.stdout, 'ok')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
