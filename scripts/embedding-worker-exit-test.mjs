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

test('memory heavy resources are lazy, pressure-reclaimable, and stopped with the daemon', async () => {
  const [index, queryHandlers, worker, provider, proxy, kiwi] = await Promise.all([
    readFile(new URL('../src/runtime/memory/index.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/runtime/memory/lib/query-handlers.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/runtime/memory/lib/embedding-worker.mjs', import.meta.url), 'utf8'),
    readFile(providerUrl, 'utf8'),
    readFile(new URL('../src/standalone/memory-runtime-proxy.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/runtime/memory/lib/ko-morph.mjs', import.meta.url), 'utf8'),
  ])
  const initStore = index.slice(index.indexOf('async function _initStore()'),
    index.indexOf('async function getCycleLastRun()'))
  assert.doesNotMatch(initStore, /initKoMorph|fireDeferred/,
    'known-dimension boot must not load Kiwi or ONNX')
  assert.match(queryHandlers, /embedding model warming in background; returning lexical results/)
  assert.doesNotMatch(queryHandlers, /MIXDOG_RECALL_WARMUP_WAIT_MS|COLD_RECALL_WARMUP_WAIT_MS/)
  assert.match(proxy, /MIXDOG_EMBED_WARMUP: process\.env\.MIXDOG_EMBED_WARMUP \?\? '0'/)
  assert.match(worker, /3 \* 60_000/)
  assert.match(worker, /host memory pressure/)
  assert.match(worker, /embedding model load deferred under host memory pressure/)
  assert.doesNotMatch(provider.slice(provider.indexOf("if (msg.type === 'idle-dispose')"),
    provider.indexOf("const pending =", provider.indexOf("if (msg.type === 'idle-dispose')"))),
    /cachedDims = null/)
  assert.match(kiwi, /2 \* 60_000/)
  assert.match(kiwi, /kiwi morph load deferred under host memory pressure/)
  assert.match(index, /shutdownEmbeddingProvider\(\)/)
})
