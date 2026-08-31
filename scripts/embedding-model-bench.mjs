#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { readServiceAdvert } from '../src/runtime/shared/service-discovery.mjs'
import {
  attachPositiveIds,
  buildEvaluation,
  CASE_FILES,
  documentText,
  MODEL_SPECS,
} from './lib/embedding-model-bench-core.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMP_ROOT = join(tmpdir(), 'mixdog-embedding-model-bench')
const CACHE_DIR = join(TEMP_ROOT, 'cache')
const SNAPSHOT_PATH = join(TEMP_ROOT, 'snapshot.json')
const RESULT_DIR = join(TEMP_ROOT, 'results')
const BENCH_DATA_DIR = join(homedir(), '.mixdog', 'bench-data')

function argValue(name, fallback = '') {
  const direct = process.argv.indexOf(`--${name}`)
  if (direct >= 0 && process.argv[direct + 1]) return process.argv[direct + 1]
  const prefix = `--${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

async function loadEvaluations() {
  const evaluations = []
  const excluded = []
  for (const caseFile of CASE_FILES) {
    const cases = JSON.parse(await readFile(join(ROOT, 'scripts', caseFile), 'utf8'))
    for (const kase of cases) {
      if (Array.isArray(kase?.args?.query) && Array.isArray(kase?.expect?.topNContains)) {
        excluded.push({ id: kase.id, caseFile, reason: 'query-target mapping is undefined for array query' })
        continue
      }
      const evaluation = buildEvaluation(caseFile, kase)
      if (evaluation) evaluations.push(evaluation)
    }
  }
  return { evaluations, excluded }
}

async function buildSnapshot() {
  const { evaluations, excluded } = await loadEvaluations()
  const uniqueTargets = [...new Set(evaluations.flatMap((evaluation) => evaluation.targets.map((target) => target.toLowerCase())))]
  const advert = readServiceAdvert('pg')
  const explicitPort = Number(argValue('pg-port'))
  const port = Number.isInteger(explicitPort) && explicitPort > 0
    ? explicitPort
    : Number(advert?.pg_port)
  if (!Number.isInteger(port) || port <= 0) throw new Error('live PostgreSQL advert is unavailable')
  const client = new pg.Client({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    database: 'mixdog',
    password: '',
  })
  await client.connect()
  let rawRows
  let rawTargetMatches
  let databaseSnapshot
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query('SET LOCAL search_path TO memory, public')
    databaseSnapshot = (await client.query(`
      SELECT count(*)::int AS total_rows,
             count(*) FILTER (WHERE is_root = 1)::int AS root_rows,
             max(id)::text AS max_id,
             txid_current_snapshot()::text AS tx_snapshot
      FROM entries
    `)).rows[0]
    rawRows = (await client.query(`
      SELECT id::text, element, summary, category, status, ts::text, project_id
      FROM entries
      WHERE is_root = 1
        AND (NULLIF(btrim(element), '') IS NOT NULL OR NULLIF(btrim(summary), '') IS NOT NULL)
      ORDER BY id
    `)).rows
    rawTargetMatches = (await client.query(`
      WITH targets AS (
        SELECT target, ordinality::int AS target_index
        FROM unnest($1::text[]) WITH ORDINALITY AS input(target, ordinality)
      )
      SELECT targets.target_index,
             entries.id::text,
             entries.is_root,
             entries.chunk_root::text,
             entries.category,
             entries.ts::text,
             entries.project_id
      FROM targets
      JOIN entries
        ON position(targets.target in lower(concat_ws(' ', entries.element, entries.summary, entries.content))) > 0
    `, [uniqueTargets])).rows
    await client.query('ROLLBACK')
  } finally {
    await client.end()
  }

  const documents = rawRows.map((row) => {
    const text = documentText(row)
    return {
      id: Number(row.id),
      text,
      textLower: text.toLowerCase(),
      category: row.category,
      status: row.status,
      ts: Number(row.ts),
      projectId: row.project_id,
    }
  })
  const targetMatches = new Map(uniqueTargets.map((target) => [target, []]))
  for (const row of rawTargetMatches) {
    const rootId = Number(row.is_root) === 1 ? Number(row.id) : Number(row.chunk_root)
    if (!Number.isFinite(rootId)) continue
    const target = uniqueTargets[Number(row.target_index) - 1]
    targetMatches.get(target)?.push({
      rootId,
      category: row.category,
      ts: Number(row.ts),
      projectId: row.project_id,
    })
  }
  const scoredEvaluations = evaluations.map((evaluation) => attachPositiveIds(evaluation, documents, targetMatches))
  const missingTargets = scoredEvaluations.flatMap((evaluation) => (
    evaluation.targets
      .map((target, index) => ({
        caseId: evaluation.id,
        caseFile: evaluation.caseFile,
        target,
        positiveCount: evaluation.positiveIdsByTarget[index].length,
      }))
      .filter((row) => row.positiveCount === 0)
  ))
  const digest = createHash('sha256')
  for (const document of documents) digest.update(`${document.id}\0${document.text}\0`)
  const snapshot = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    database: { host: '127.0.0.1', port, ...databaseSnapshot },
    corpus: {
      documents: documents.length,
      sha256: digest.digest('hex'),
    },
    evaluations: {
      included: scoredEvaluations.length,
      excluded,
      targets: scoredEvaluations.reduce((sum, evaluation) => sum + evaluation.targets.length, 0),
      missingTargets,
    },
    documents,
    cases: scoredEvaluations,
  }
  await mkdir(TEMP_ROOT, { recursive: true })
  await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot))
  return snapshot
}

function runWorker(modelKey, outputPath, corpusLimit, positiveCap) {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = [
      join(ROOT, 'scripts', 'embedding-model-bench-worker.mjs'),
      '--model', modelKey,
      '--snapshot', SNAPSHOT_PATH,
      '--cache', CACHE_DIR,
      '--output', outputPath,
    ]
    if (corpusLimit > 0) args.push('--corpus-limit', String(corpusLimit))
    if (positiveCap > 0) args.push('--positive-cap', String(positiveCap))
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        MIXDOG_QUIET_MEMORY_LOG: '1',
      },
    })
    child.once('error', rejectPromise)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`${modelKey} worker exited with code ${code}`))
    })
  })
}

function formatNumber(value) {
  return Number(value || 0).toFixed(4)
}

function printSummary(aggregate) {
  process.stdout.write('\n=== heuristic-free embedding benchmark ===\n')
  process.stdout.write('model'.padEnd(30) + 'dense MRR@10'.padEnd(15) + 'R@5'.padEnd(10) + 'RRF MRR@10'.padEnd(15) + 'peak RSS MB'.padEnd(14) + 'load ms\n')
  for (const result of aggregate.models) {
    if (result.error) {
      process.stdout.write(`${result.modelKey.padEnd(30)}ERROR: ${result.error}\n`)
      continue
    }
    process.stdout.write(
      `${result.label.padEnd(30)}`
      + `${formatNumber(result.quality.dense.overall.mrrAt10).padEnd(15)}`
      + `${formatNumber(result.quality.dense.overall.recallAt5).padEnd(10)}`
      + `${formatNumber(result.quality.rrf.overall.mrrAt10).padEnd(15)}`
      + `${(result.resources.peakRssBytes / 1024 / 1024).toFixed(1).padEnd(14)}`
      + `${result.resources.loadMs}\n`,
    )
  }
  process.stdout.write(`\nresult: ${aggregate.resultPath}\n`)
}

async function main() {
  await mkdir(RESULT_DIR, { recursive: true })
  await mkdir(CACHE_DIR, { recursive: true })
  await mkdir(BENCH_DATA_DIR, { recursive: true })
  const snapshot = hasFlag('reuse-snapshot')
    ? JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'))
    : await buildSnapshot()
  process.stdout.write(
    `[embedding-bench] snapshot documents=${snapshot.corpus.documents}`
    + ` cases=${snapshot.evaluations.included}`
    + ` targets=${snapshot.evaluations.targets}`
    + ` missingTargets=${snapshot.evaluations.missingTargets.length}\n`,
  )
  if (hasFlag('prepare-only')) return

  const requested = argValue('models')
  const corpusLimit = Math.max(0, Math.floor(Number(argValue('corpus-limit', '0')) || 0))
  const positiveCap = Math.max(0, Math.floor(Number(argValue('positive-cap', '0')) || 0))
  const modelKeys = requested
    ? requested.split(',').map((value) => value.trim()).filter(Boolean)
    : Object.keys(MODEL_SPECS)
  for (const key of modelKeys) {
    if (!MODEL_SPECS[key]) throw new Error(`unknown model key: ${key}`)
  }

  const results = []
  for (const modelKey of modelKeys) {
    const corpusTag = corpusLimit > 0
      ? `${corpusLimit}${positiveCap > 0 ? `-p${positiveCap}` : ''}`
      : 'full'
    const outputPath = join(RESULT_DIR, `${modelKey}-${corpusTag}.json`)
    process.stdout.write(`\n[embedding-bench] running ${modelKey}\n`)
    try {
      await runWorker(modelKey, outputPath, corpusLimit, positiveCap)
      results.push(JSON.parse(await readFile(outputPath, 'utf8')))
    } catch (error) {
      results.push({ modelKey, error: error?.message || String(error) })
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const resultPath = join(BENCH_DATA_DIR, `embedding-model-bench-${timestamp}.json`)
  const aggregate = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    heuristicFree: true,
    ranking: {
      dense: 'cosine similarity',
      lexical: 'BM25(k1=1.2,b=0.75)',
      fusion: 'equal-weight RRF(k=60)',
      queryBranches: false,
      manualBoosts: false,
      similarityThresholds: false,
    },
    corpusLimit: corpusLimit || null,
    positiveCap: positiveCap || null,
    snapshot: {
      generatedAt: snapshot.generatedAt,
      readOnly: snapshot.readOnly,
      database: snapshot.database,
      corpus: snapshot.corpus,
      evaluations: snapshot.evaluations,
    },
    models: results,
    resultPath,
  }
  await writeFile(resultPath, JSON.stringify(aggregate, null, 2))
  if (hasFlag('json')) process.stdout.write(JSON.stringify(aggregate, null, 2) + '\n')
  else printSummary(aggregate)
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || error}\n`)
  process.exitCode = 1
})
