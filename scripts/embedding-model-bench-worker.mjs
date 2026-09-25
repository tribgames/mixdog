#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  aggregateScoredRows,
  documentMatchesFilter,
  MODEL_SPECS,
  prepareBm25Documents,
  rankBm25,
  rankDense,
  rankEqualRrf,
  scoreRanking,
  selectDeterministicCorpus,
} from './lib/embedding-model-bench-core.mjs';
import { percentile, sortedFinite } from './lib/trace-stats.mjs';

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return '';
}

async function directorySize(path) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return 0;
  }
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  const entries = await readdir(path, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) total += await directorySize(join(path, entry.name));
  return total;
}

function normalizeRows(data, rows, dims) {
  for (let row = 0; row < rows; row += 1) {
    const offset = row * dims;
    let normSquared = 0;
    for (let dimension = 0; dimension < dims; dimension += 1) {
      const value = data[offset + dimension];
      normSquared += value * value;
    }
    const norm = Math.sqrt(normSquared);
    if (!Number.isFinite(norm) || norm === 0) continue;
    for (let dimension = 0; dimension < dims; dimension += 1) data[offset + dimension] /= norm;
  }
}

function runtimeRequire(runtimeRoot = '') {
  return runtimeRoot ? createRequire(join(runtimeRoot, 'package.json')) : createRequire(import.meta.url);
}

function patchOrtThreads(runtimeRoot = '') {
  try {
    const require = runtimeRequire(runtimeRoot);
    const transformersEntry = require.resolve('@huggingface/transformers');
    const transformersRequire = createRequire(transformersEntry);
    const ort = transformersRequire('onnxruntime-node');
    if (!ort?.InferenceSession?.create) return;
    const original = ort.InferenceSession.create.bind(ort.InferenceSession);
    ort.InferenceSession.create = (model, options = {}) =>
      original(model, {
        ...options,
        intraOpNumThreads: options.intraOpNumThreads || 1,
        interOpNumThreads: options.interOpNumThreads || 1,
        graphOptimizationLevel: options.graphOptimizationLevel || 'basic',
        logSeverityLevel: options.logSeverityLevel ?? 4,
      });
  } catch {}
}

async function loadExtractor(spec, cacheDir, runtimeRoot = '') {
  patchOrtThreads(runtimeRoot);
  const require = runtimeRequire(runtimeRoot);
  const transformersEntry = require.resolve('@huggingface/transformers');
  const { AutoModel, AutoTokenizer, env, pipeline } = await import(pathToFileURL(transformersEntry).href);
  env.allowLocalModels = false;
  env.cacheDir = cacheDir;
  try {
    env.backends.onnx.logLevel = 'fatal';
  } catch {}
  const options = { dtype: spec.dtype, device: 'cpu' };
  if (spec.modelFileName) options.model_file_name = spec.modelFileName;
  if (spec.outputName) {
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(spec.modelId),
      AutoModel.from_pretrained(spec.modelId, options),
    ]);
    return {
      async embed(texts, inputType) {
        const prefix = inputType === 'query' ? spec.queryPrefix : spec.documentPrefix;
        const prepared = texts.map((text) => `${prefix}${String(text || '').slice(0, 8000)}`);
        const inputs = await tokenizer(prepared, { padding: true, truncation: true });
        const outputs = await model(inputs);
        const tensor = outputs?.[spec.outputName];
        if (!tensor?.data?.length) throw new Error(`missing output ${spec.outputName}`);
        const rows = prepared.length;
        const dims = tensor.data.length / rows;
        const data = Float32Array.from(tensor.data);
        normalizeRows(data, rows, dims);
        return { data, dims };
      },
      dispose: () => model.dispose(),
    };
  }
  const extractor = await pipeline('feature-extraction', spec.modelId, options);
  return {
    async embed(texts, inputType) {
      const prefix = inputType === 'query' ? spec.queryPrefix : spec.documentPrefix;
      const prepared = texts.map((text) => `${prefix}${String(text || '').slice(0, 8000)}`);
      const tensor = await extractor(prepared, {
        pooling: spec.pooling,
        normalize: true,
        truncation: true,
      });
      const rows = prepared.length;
      const dims = tensor.data.length / rows;
      const data = Float32Array.from(tensor.data);
      normalizeRows(data, rows, dims);
      return { data, dims };
    },
    dispose: () => extractor.dispose(),
  };
}

function candidateIndices(documents, evaluation) {
  const indices = [];
  const extraIds = new Set(evaluation.extraCandidateIds || []);
  for (let index = 0; index < documents.length; index += 1) {
    if (documentMatchesFilter(documents[index], evaluation.filter) || extraIds.has(documents[index].id))
      indices.push(index);
  }
  return indices;
}

function scoreLane(evaluation, ranked, documents) {
  return {
    id: evaluation.id,
    caseFile: evaluation.caseFile,
    label: evaluation.label,
    query: evaluation.query,
    language: evaluation.language,
    candidateCount: evaluation.candidateCount,
    ...scoreRanking(evaluation, ranked, documents),
  };
}

// Nonsense queries with no relevant document: their top scores calibrate what
// a "no match" looks like for a model that always returns its nearest rows.
const EVIDENCE_NEGATIVE_QUERIES = [
  'zzqqxx qvmtpl norkfuzz 938472',
  '없는기억식별자 qzxvplm 847291',
  '不存在记忆 qzxvplm 847291',
  'souvenir inexistant qzxvplm 847291',
  'underwater basket weaving on Neptune cobalt penguin',
  '해왕성 수중 바구니 직조 코발트 펭귄',
];

function parseWorkerArgs() {
  return {
    modelKey: argValue('model'),
    snapshotPath: argValue('snapshot'),
    cacheDir: argValue('cache'),
    outputPath: argValue('output'),
    runtimeRoot: argValue('runtime-root'),
    corpusLimit: Number(argValue('corpus-limit')),
    positiveCap: Number(argValue('positive-cap')),
  };
}

async function measureHotQueryLatency(extractor, uniqueQueries) {
  const hotSamplesMs = [];
  for (const query of uniqueQueries.slice(0, 10)) {
    const started = performance.now();
    await extractor.embed([query], 'query');
    hotSamplesMs.push(performance.now() - started);
  }
  return hotSamplesMs;
}

async function embedDocumentCorpus(extractor, documents, spec, modelKey) {
  let dims = 0;
  let documentVectors = null;
  let completed = 0;
  const corpusStarted = Date.now();
  for (let offset = 0; offset < documents.length; offset += spec.batchSize) {
    const chunk = documents.slice(offset, offset + spec.batchSize);
    const output = await extractor.embed(
      chunk.map((document) => document.text),
      'document'
    );
    if (dims === 0) {
      dims = output.dims;
      documentVectors = new Float32Array(documents.length * dims);
    }
    if (output.dims !== dims) throw new Error(`document dims changed ${dims} -> ${output.dims}`);
    documentVectors.set(output.data, offset * dims);
    completed += chunk.length;
    if (completed % 512 === 0 || completed === documents.length) {
      process.stdout.write(`[${modelKey}] documents ${completed}/${documents.length}\n`);
    }
  }
  return { documentVectors, dims, corpusMs: Date.now() - corpusStarted };
}

async function embedQueries(extractor, uniqueQueries, spec, dims) {
  const queryVectors = new Map();
  for (let offset = 0; offset < uniqueQueries.length; offset += spec.batchSize) {
    const chunk = uniqueQueries.slice(offset, offset + spec.batchSize);
    const output = await extractor.embed(chunk, 'query');
    if (output.dims !== dims) throw new Error(`query dims ${output.dims} != document dims ${dims}`);
    for (let index = 0; index < chunk.length; index += 1) {
      queryVectors.set(chunk[index], output.data.slice(index * dims, (index + 1) * dims));
    }
  }
  return queryVectors;
}

function evaluateLanes({ evaluations, documents, queryVectors, documentVectors, dims, modelKey }) {
  const preparedBm25 = prepareBm25Documents(documents);
  const rows = { dense: [], bm25: [], rrf: [] };
  const positiveEvidence = [];
  for (let evaluationIndex = 0; evaluationIndex < evaluations.length; evaluationIndex += 1) {
    const evaluation = evaluations[evaluationIndex];
    const candidates = candidateIndices(documents, evaluation);
    const scopedEvaluation = { ...evaluation, candidateCount: candidates.length };
    const denseRanked = rankDense(queryVectors.get(evaluation.query), documentVectors, dims, candidates);
    const bm25Ranked = rankBm25(evaluation.query, candidates, preparedBm25);
    const rrfRanked = rankEqualRrf(denseRanked, bm25Ranked);
    const relevantIds = new Set(evaluation.positiveIdsByTarget.flat());
    const bestRelevant = denseRanked.find((row) => relevantIds.has(documents[row.index].id));
    const lexicalTop10Ids = new Set(bm25Ranked.slice(0, 10).map((row) => documents[row.index].id));
    positiveEvidence.push({
      id: evaluation.id,
      language: evaluation.language,
      topScore: denseRanked[0]?.score ?? null,
      tenthScore: denseRanked[9]?.score ?? null,
      bestRelevantScore: bestRelevant?.score ?? null,
      bestRelevantRank: bestRelevant ? denseRanked.indexOf(bestRelevant) + 1 : null,
      lexicalRelevantAt10: [...relevantIds].some((id) => lexicalTop10Ids.has(id)),
    });
    rows.dense.push(scoreLane(scopedEvaluation, denseRanked, documents));
    rows.bm25.push(scoreLane(scopedEvaluation, bm25Ranked, documents));
    rows.rrf.push(scoreLane(scopedEvaluation, rrfRanked, documents));
    process.stdout.write(`[${modelKey}] scored ${evaluationIndex + 1}/${evaluations.length}\n`);
  }
  return { rows, positiveEvidence };
}

function measureNegativeEvidence(queryVectors, documentVectors, dims, documentCount) {
  const allDocumentIndices = Array.from({ length: documentCount }, (_unused, index) => index);
  return EVIDENCE_NEGATIVE_QUERIES.map((query) => {
    const ranked = rankDense(queryVectors.get(query), documentVectors, dims, allDocumentIndices);
    const topScore = ranked[0]?.score ?? null;
    const tenthScore = ranked[9]?.score ?? null;
    return {
      query,
      topScore,
      thirdScore: ranked[2]?.score ?? null,
      tenthScore,
      topToTenthMargin: topScore != null && tenthScore != null ? topScore - tenthScore : null,
    };
  });
}

function laneFailures(laneRows) {
  return laneRows
    .filter((row) => row.mrrAt10 < 1)
    .sort((left, right) => left.mrrAt10 - right.mrrAt10)
    .slice(0, 30);
}

function buildWorkerResult({
  modelKey,
  spec,
  runtimeRoot,
  dims,
  corpusSelection,
  documentCount,
  quality,
  rows,
  positiveEvidence,
  negativeEvidence,
  missingTargets,
  timings,
  memory,
  cache,
}) {
  return {
    modelKey,
    label: spec.label,
    modelId: spec.modelId,
    runtimeRoot: runtimeRoot || null,
    dtype: spec.dtype,
    pooling: spec.pooling,
    dims,
    corpus: {
      sourceDocuments: corpusSelection.sourceDocuments,
      documents: corpusSelection.selectedDocuments,
      positiveDocuments: corpusSelection.positiveDocuments,
      sampling: corpusSelection.method,
    },
    officialInputContract: {
      queryPrefix: spec.queryPrefix,
      documentPrefix: spec.documentPrefix,
    },
    quality,
    evidenceCalibration: {
      positiveQueries: positiveEvidence,
      negativeQueries: negativeEvidence,
    },
    resources: {
      baselineRssBytes: memory.baselineRssBytes,
      rssAfterLoadBytes: memory.rssAfterLoadBytes,
      rssAfterCorpusBytes: memory.rssAfterCorpusBytes,
      peakRssBytes: memory.peakRssBytes,
      activeRssDeltaBytes: memory.rssAfterCorpusBytes - memory.baselineRssBytes,
      loadMs: timings.loadMs,
      hotQueryP50Ms: percentile(sortedFinite(timings.hotSamplesMs), 50),
      hotQueryP95Ms: percentile(sortedFinite(timings.hotSamplesMs), 95),
      corpusMs: timings.corpusMs,
      documentsPerSecond: documentCount / Math.max(0.001, timings.corpusMs / 1000),
      cacheBytesBefore: cache.bytesBefore,
      cacheBytesAfter: cache.bytesAfter,
      cacheBytesDelta: cache.bytesAfter - cache.bytesBefore,
    },
    labelAudit: {
      missingTargets,
    },
    failures: {
      dense: laneFailures(rows.dense),
      rrf: laneFailures(rows.rrf),
    },
  };
}

async function main() {
  const { modelKey, snapshotPath, cacheDir, outputPath, runtimeRoot, corpusLimit, positiveCap } = parseWorkerArgs();
  const spec = MODEL_SPECS[modelKey];
  if (!spec) throw new Error(`unknown model key: ${modelKey}`);
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  const evaluations = snapshot.cases;
  const corpusSelection = selectDeterministicCorpus(snapshot.documents, evaluations, corpusLimit, positiveCap);
  const documents = corpusSelection.documents;
  const baselineRssBytes = process.memoryUsage().rss;
  let peakRssBytes = baselineRssBytes;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 50);
  sampler.unref();
  const cacheBytesBefore = await directorySize(cacheDir);
  const loadStarted = Date.now();
  const extractor = await loadExtractor(spec, cacheDir, runtimeRoot);
  const loadMs = Date.now() - loadStarted;
  const rssAfterLoadBytes = process.memoryUsage().rss;

  const uniqueQueries = [
    ...new Set([...evaluations.map((evaluation) => evaluation.query), ...EVIDENCE_NEGATIVE_QUERIES]),
  ];
  const hotSamplesMs = await measureHotQueryLatency(extractor, uniqueQueries);

  const { documentVectors, dims, corpusMs } = await embedDocumentCorpus(extractor, documents, spec, modelKey);
  const rssAfterCorpusBytes = process.memoryUsage().rss;
  const queryVectors = await embedQueries(extractor, uniqueQueries, spec, dims);

  const { rows, positiveEvidence } = evaluateLanes({
    evaluations,
    documents,
    queryVectors,
    documentVectors,
    dims,
    modelKey,
  });

  await extractor.dispose();
  clearInterval(sampler);
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  const cacheBytesAfter = await directorySize(cacheDir);
  const quality = {
    dense: aggregateScoredRows(rows.dense),
    bm25: aggregateScoredRows(rows.bm25),
    rrf: aggregateScoredRows(rows.rrf),
  };
  const negativeEvidence = measureNegativeEvidence(queryVectors, documentVectors, dims, documents.length);
  const result = buildWorkerResult({
    modelKey,
    spec,
    runtimeRoot,
    dims,
    corpusSelection,
    documentCount: documents.length,
    quality,
    rows,
    positiveEvidence,
    negativeEvidence,
    missingTargets: snapshot.evaluations.missingTargets,
    timings: { loadMs, corpusMs, hotSamplesMs },
    memory: { baselineRssBytes, rssAfterLoadBytes, rssAfterCorpusBytes, peakRssBytes },
    cache: { bytesBefore: cacheBytesBefore, bytesAfter: cacheBytesAfter },
  });
  await writeFile(outputPath, JSON.stringify(result));
  process.stdout.write(
    `[${modelKey}] dense MRR@10=${quality.dense.overall.mrrAt10.toFixed(4)}` +
      ` RRF MRR@10=${quality.rrf.overall.mrrAt10.toFixed(4)}` +
      ` peakRSS=${(peakRssBytes / 1024 / 1024).toFixed(1)}MB\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || error}\n`);
  process.exitCode = 1;
});
