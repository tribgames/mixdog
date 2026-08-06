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
    .replace("'./compact-vector-cache.mjs'", JSON.stringify(new URL('../src/runtime/memory/lib/compact-vector-cache.mjs', import.meta.url).href))
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

async function createIdleRetirementRaceFixture() {
  const tempDir = await mkdtemp(join(tmpdir(), 'mixdog-embed-worker-retire-'))
  const workerPath = join(tempDir, 'idle-dispose-before-reply.mjs')
  await writeFile(workerPath, `
    import { parentPort } from 'node:worker_threads'
    parentPort.once('message', (message) => {
      parentPort.postMessage({
        type: 'idle-dispose',
        reason: 'test idle race',
        device: 'cpu',
        dtype: 'fp32',
      })
      setTimeout(() => parentPort.postMessage({
        id: message.id,
        type: 'result',
        dims: 2,
        vector: [0.25, 0.75],
        device: 'cpu',
        dtype: 'fp32',
      }), 50)
    })
  `)
  const source = await readFile(providerUrl, 'utf8')
  const instrumented = source
    .replace("'./memory-log.mjs'", JSON.stringify(new URL('../src/runtime/memory/lib/memory-log.mjs', import.meta.url).href))
    .replace("'./model-profile.mjs'", JSON.stringify(new URL('../src/runtime/memory/lib/model-profile.mjs', import.meta.url).href))
    .replace("'./compact-vector-cache.mjs'", JSON.stringify(new URL('../src/runtime/memory/lib/compact-vector-cache.mjs', import.meta.url).href))
    .replace("'./embedding-model-config.mjs'", JSON.stringify(new URL('../src/runtime/memory/lib/embedding-model-config.mjs', import.meta.url).href))
    .replace(/^const WORKER_PATH = .*$/m, `const WORKER_PATH = ${JSON.stringify(workerPath)}`)
  const providerModule = `data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}#${Date.now()}`
  const fixturePath = join(tempDir, 'run-retire-test.mjs')
  await writeFile(fixturePath, `
    import { embedText, shutdownEmbeddingProvider } from ${JSON.stringify(providerModule)}
    const vector = await embedText('accepted during idle retirement')
    if (JSON.stringify(vector) !== '[0.25,0.75]') throw new Error('accepted embed did not finish')
    await shutdownEmbeddingProvider()
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

test('idle retirement does not terminate a worker with an accepted embed', async () => {
  const { fixturePath, tempDir } = await createIdleRetirementRaceFixture()
  try {
    const result = await runFixture(fixturePath)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.signal, null, result.stderr)
    assert.equal(result.stdout, 'ok')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('memory heavy resources are lazy, idle-reclaimable, and stopped with the daemon', async () => {
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
  assert.match(worker, /: 60_000/)
  assert.match(worker, /disposeLoadedExtractor\('idle timeout'\)/)
  assert.doesNotMatch(worker, /host memory pressure|MIXDOG_EMBED_PRESSURE_MIN_FREE_MB/)
  const drainQueue = worker.slice(
    worker.indexOf('async function drainQueue()'),
    worker.indexOf("parentPort.on('message'"),
  )
  assert.match(drainQueue, /if \(extractorPromise && !_reclaiming\) resetIdleTimer\(\)/)
  assert.doesNotMatch(provider.slice(provider.indexOf("if (msg.type === 'idle-dispose')"),
    provider.indexOf("const pending =", provider.indexOf("if (msg.type === 'idle-dispose')"))),
    /cachedDims = null/)
  assert.match(provider, /retiringWorkers\.add\(created\)/)
  assert.match(provider, /created\.terminate\(\)/)
  assert.match(kiwi, /: 60_000/)
  assert.match(kiwi, /releaseLoaded\('idle timeout'\)/)
  assert.doesNotMatch(kiwi, /host memory pressure|MIXDOG_KO_MORPH_PRESSURE_MIN_FREE_MB/)
  assert.match(index, /shutdownEmbeddingProvider\(\)/)
})
