import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const runtimeRootArgument = process.argv.find((value) => value.startsWith('--runtime-root='))
const runtimeRoot = runtimeRootArgument
  ? resolve(runtimeRootArgument.slice('--runtime-root='.length))
  : resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = runtimeRootArgument
  ? createRequire(join(runtimeRoot, 'package.json'))
  : createRequire(import.meta.url)
const transformersEntry = require.resolve('@huggingface/transformers')
const transformersRequire = createRequire(transformersEntry)
const ortEntry = transformersRequire.resolve('onnxruntime-node')
const mixdogRoot = runtimeRootArgument ? join(runtimeRoot, 'node_modules', 'mixdog') : runtimeRoot
const mixdogModule = (relative) => pathToFileURL(join(mixdogRoot, relative)).href
const verbose = process.env.MIXDOG_VERIFY_EMBEDDING_VERBOSE === '1'
const phase = (value) => { if (verbose) process.stdout.write(`Embedding verify phase: ${value}\n`) }

async function packageRoot(entry, expectedName) {
  let current = dirname(entry)
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(join(current, 'package.json'), 'utf8'))
      if (pkg.name === expectedName) return current
    } catch {}
    const parent = dirname(current)
    if (parent === current) throw new Error(`Unable to locate ${expectedName}`)
    current = parent
  }
}

const ortRoot = await packageRoot(ortEntry, 'onnxruntime-node')
const nativeDir = join(ortRoot, 'bin', 'napi-v6', process.platform, process.arch)
await access(join(nativeDir, 'onnxruntime_binding.node'))

const transformers = transformersRequire(transformersEntry)
assert.equal(typeof transformers.pipeline, 'function')
const ort = transformersRequire('onnxruntime-node')
assert.equal(typeof ort.InferenceSession?.create, 'function')

const runCoreSmoke = process.argv.includes('--core')
const runWarmup = runCoreSmoke || process.argv.includes('--warmup')
let embeddingProvider
let dataDir

try {
  if (runWarmup) {
    embeddingProvider = await import(mixdogModule('src/runtime/memory/lib/embedding-provider.mjs'))
    const vector = await embeddingProvider.embedText('Mixdog embedding runtime warmup verification')
    assert.ok(Array.isArray(vector) && vector.length > 0)
    process.stdout.write(`Embedding warmup OK (${vector.length} dimensions).\n`)

    if (runCoreSmoke) {
      phase('core-import')
      dataDir = await mkdtemp(join(tmpdir(), 'mixdog-embedding-core-smoke-'))
      const [
        { openDatabase, closeDatabase, embeddingToSql },
        { addCore, deleteCore, listCore },
        { searchRelevantHybrid },
      ] = await Promise.all([
        import(mixdogModule('src/runtime/memory/lib/memory.mjs')),
        import(mixdogModule('src/runtime/memory/lib/core-memory-store.mjs')),
        import(mixdogModule('src/runtime/memory/lib/memory-recall-store.mjs')),
      ])
      try {
        phase('database-open')
        const db = await openDatabase(dataDir, vector.length)
        const recallText = 'Embedding runtime portable recall smoke'
        const recallFixture = await db.query(`
          INSERT INTO entries (
            ts, role, content, source_ref, is_root,
            element, category, summary, status, last_seen_at, embedding
          ) VALUES (
            $1, 'user', $2, $3, 1,
            $2, 'fact', $2, 'active', $1, $4::halfvec
          )
          RETURNING id
        `, [
          Date.now(),
          recallText,
          `verify-embedding-runtime:${process.pid}:${Date.now()}`,
          embeddingToSql(vector),
        ])
        const recallFixtureId = recallFixture.rows[0].id
        phase('core-add')
        const added = await addCore(dataDir, {
          element: 'Embedding runtime smoke',
          summary: 'Packaged embedding runtime supports core memory mutations.',
          category: 'fact',
        }, null)
        phase('core-list')
        const listed = await listCore(dataDir, null)
        assert.ok(listed.some((entry) => String(entry.id) === String(added.id)))
        phase('memory-recall')
        const recalled = await searchRelevantHybrid(db, recallText, {
          limit: 3,
          queryVector: vector,
        })
        assert.ok(recalled.some((entry) => String(entry.id) === String(recallFixtureId)))
        await db.query('DELETE FROM entries WHERE id = $1', [recallFixtureId])
        phase('core-delete')
        const deleted = await deleteCore(dataDir, added.id)
        assert.equal(String(deleted.id), String(added.id))
        assert.equal((await listCore(dataDir, null)).length, 0)
        process.stdout.write('Memory add/recall and core add/list/delete smoke OK.\n')
      } catch (error) {
        try {
          const postgresLog = (await readFile(join(dataDir, 'pg.log'), 'utf8')).trim()
          if (postgresLog) process.stderr.write(`Embedding core PostgreSQL log:\n${postgresLog}\n`)
        } catch {}
        throw error
      } finally {
        await closeDatabase(dataDir)
        const { stopPgForShutdown } = await import(mixdogModule('src/runtime/memory/lib/pg/supervisor.mjs'))
        await stopPgForShutdown()
      }
    }
  }
} finally {
  await embeddingProvider?.shutdownEmbeddingProvider()
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
}

process.stdout.write(
  `Embedding runtime OK: ${process.platform}-${process.arch} · ${nativeDir}\n`,
)
