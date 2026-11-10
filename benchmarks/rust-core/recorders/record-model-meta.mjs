#!/usr/bin/env node
// The per-route model metadata memo (WP-AI-META): Node's REAL `createModelMetaIndex` (`lookupModelMeta`,
// `remember`, `snapshotIsCurrent`) and the REAL catalog loader's `remember` calls (`createCatalogLoader`), driven
// through scripted providers behind a fake registry. No network, no credential.
//
//   node benchmarks/rust-core/recorders/record-model-meta.mjs --tree <dir containing src/> --commit b6f10295a
//   (the tree is `git archive b6f10295a src` of the Node product)
//
// Output: native/core/fixtures/providers/oracles/model-meta.json (or `--out <file>`; record-providers.mjs runs it so). Each scenario lists its providers and its ops;
// every `lookup` / `load` op carries what Node answered (`expect`) and how many `listModels` calls had been made
// (`listCalls`). The Rust replay builds the same providers and ops and must reproduce every answer.
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, parseArgs, writeJson } from './lib/common.mjs';

const args = parseArgs();
const tree = resolve(args.get('tree') ?? '');
const load = (rel) => import(pathToFileURL(join(tree, rel)).href);
const { createModelMetaIndex } = await load('src/session-runtime/provider-models/model-meta.mjs');
const { createCatalogLoader } = await load('src/session-runtime/provider-models/catalog-load.mjs');
const { providerModelCacheRow } = await load('src/session-runtime/model-recency.mjs');
const { invalidateSharedProviderCatalog } = await load('src/session-runtime/provider-catalog-cache.mjs');

const row = (id, extra = {}) => ({ id, ...extra });

// A row as a provider stores it: the keys the review named, with their presence semantics.
const FULL = (id) => ({
  id,
  name: id,
  display: `Display ${id}`,
  provider: 'ignored-by-normalization',
  supportsFunctionCalling: true,
  supportsWebSearch: false,
  supportsReasoning: false,
  reasoningLevels: [],
  reasoningOptions: [],
  customReasoning: { wireFormat: 'standard', wireValues: {}, replay: false },
  contextWindow: 0,
  outputTokens: null,
});

const SCENARIOS = [
  {
    name: 'cold-lookup-then-startup-listing-stays-pinned',
    providers: { p: { list: true, cached: [] } },
    ops: [
      { op: 'lookup', provider: 'p', model: 'm' },
      { op: 'startupListing', provider: 'p', rows: [FULL('m'), FULL('m2')] },
      { op: 'lookup', provider: 'p', model: 'm' },
      { op: 'lookup', provider: 'p', model: 'm2' },
      { op: 'lookup', provider: 'p', model: 'm2' },
    ],
  },
  {
    name: 'capability-versus-none-both-listed',
    providers: {
      with: { list: true, cached: [FULL('m'), { name: 'no-id-no-provider' }] },
      without: { list: true, listRows: [FULL('m'), { id: 'bare' }] },
    },
    ops: [
      { op: 'lookup', provider: 'with', model: 'm' },
      { op: 'lookup', provider: 'without', model: 'm' },
      { op: 'lookup', provider: 'without', model: 'm', allowFetch: true },
      { op: 'lookup', provider: 'without', model: 'm', allowFetch: true },
      { op: 'lookup', provider: 'without', model: 'bare', allowFetch: true },
      { op: 'lookup', provider: 'without', model: 'bare' },
    ],
  },
  {
    name: 'custom-model-before-any-listing',
    providers: { custom: { list: true, cached: [{ ...FULL('manual'), manual: true, hidden: false }], listRows: [] } },
    ops: [
      { op: 'lookup', provider: 'custom', model: 'manual' },
      { op: 'lookup', provider: 'custom', model: 'other' },
      { op: 'lookup', provider: 'custom', model: 'other', allowFetch: true },
    ],
  },
  {
    name: 'placeholder-then-fetch-hit-empty-thrown',
    providers: {
      hit: { list: true, listRows: [FULL('m')] },
      empty: { list: true, listRows: [] },
      thrown: { list: true, throws: true },
    },
    ops: [
      { op: 'lookup', provider: 'hit', model: 'm' },
      { op: 'lookup', provider: 'hit', model: 'm', allowFetch: true },
      { op: 'lookup', provider: 'hit', model: 'm', allowFetch: true },
      { op: 'lookup', provider: 'empty', model: 'm', allowFetch: true },
      { op: 'lookup', provider: 'empty', model: 'm', allowFetch: true },
      { op: 'lookup', provider: 'thrown', model: 'm' },
      { op: 'lookup', provider: 'thrown', model: 'm', allowFetch: true },
      { op: 'lookup', provider: 'thrown', model: 'm' },
      { op: 'lookup', provider: 'thrown', model: 'm', allowFetch: true },
    ],
  },
  {
    name: 'cached-hit-normalization-versus-fetched-row-identity',
    providers: {
      with: { list: true, cached: [{ id: '', name: 'blank-id', provider: 'other' }, { name: 'no-id' }, { id: 'kept', provider: 'other' }] },
      without: { list: true, listRows: [{ id: 'kept', provider: 'other' }, { id: 'noprov' }] },
    },
    ops: [
      { op: 'lookup', provider: 'with', model: 'kept' },
      { op: 'lookup', provider: 'with', model: 'blank' },
      { op: 'lookup', provider: 'without', model: 'kept', allowFetch: true },
      { op: 'lookup', provider: 'without', model: 'noprov', allowFetch: true },
    ],
  },
  {
    name: 'no-listing-and-unregistered-pin-the-unmarked-fallback',
    providers: { nolist: { list: false } },
    ops: [
      { op: 'lookup', provider: 'nolist', model: 'm' },
      { op: 'lookup', provider: 'nolist', model: 'm', allowFetch: true },
      { op: 'lookup', provider: 'ghost', model: 'm' },
      { op: 'lookup', provider: 'ghost', model: 'm', allowFetch: true },
    ],
  },
  {
    name: 'full-load-overwrites-and-skips-the-unselectable',
    providers: {
      p: {
        list: true,
        cached: [row('shown', { display: 'CACHED-shown' }), row('hid', { display: 'CACHED-hid' }), row('embed', { display: 'CACHED-embed' })],
        listRows: [
          row('shown', { display: 'LOAD-shown', hidden: false, manual: false }),
          row('hid', { display: 'LOAD-hid', hidden: true, manual: true }),
          row('embed', { display: 'LOAD-embed', mode: 'embedding' }),
          row('', { display: 'LOAD-empty' }),
          row('fresh', { display: 'LOAD-fresh' }),
        ],
      },
    },
    ops: [
      { op: 'lookup', provider: 'p', model: 'shown' },
      { op: 'load' },
      { op: 'lookup', provider: 'p', model: 'shown' },
      { op: 'lookup', provider: 'p', model: 'hid' },
      { op: 'lookup', provider: 'p', model: 'embed' },
      { op: 'lookup', provider: 'p', model: 'fresh' },
    ],
  },
  {
    name: 'seq-change-during-fetch-pins-nothing',
    providers: { b: { list: true, listRows: [FULL('m')], duringList: 'invalidate' } },
    ops: [
      { op: 'lookup', provider: 'b', model: 'm', allowFetch: true },
      { op: 'lookup', provider: 'b', model: 'm', allowFetch: true },
    ],
  },
  {
    name: 'revision-change-during-fetch-pins-nothing',
    providers: { b: { list: true, listRows: [FULL('m')], duringList: 'bumpRevision' } },
    ops: [
      { op: 'lookup', provider: 'b', model: 'm', allowFetch: true },
      { op: 'lookup', provider: 'b', model: 'm' },
    ],
  },
  {
    name: 'seq-or-revision-change-during-load-remembers-nothing',
    providers: {
      p: { list: true, listRows: [row('a', { display: 'LOAD-a' })], duringList: 'invalidate' },
    },
    ops: [{ op: 'load' }, { op: 'lookup', provider: 'p', model: 'a' }],
  },
  {
    name: 'revision-move-clears-the-memo',
    providers: { p: { list: true, cached: [FULL('m')] } },
    ops: [
      { op: 'lookup', provider: 'p', model: 'm' },
      { op: 'setCached', provider: 'p', rows: [{ id: 'm', name: 'changed' }] },
      { op: 'lookup', provider: 'p', model: 'm' },
      { op: 'bumpRevision' },
      { op: 'lookup', provider: 'p', model: 'm' },
      { op: 'invalidate' },
      { op: 'setCached', provider: 'p', rows: [{ id: 'm', name: 'after-invalidate' }] },
      { op: 'lookup', provider: 'p', model: 'm' },
    ],
  },
];

function runScenario(scenario) {
  const initial = structuredClone(scenario.providers);
  let revision = 1;
  const caches = { providerModelsLoadSeq: 0 };
  const map = new Map();
  let listCalls = 0;
  const providers = new Map();
  const act = (what) => {
    if (what === 'bumpRevision') revision += 1;
    if (what === 'invalidate') {
      invalidateSharedProviderCatalog();
      caches.providerModelsLoadSeq += 1;
      map.clear();
    }
  };
  for (const [name, spec] of Object.entries(scenario.providers)) {
    const impl = {};
    if (spec.list) {
      impl.listModels = async () => {
        listCalls += 1;
        if (spec.duringList) act(spec.duringList);
        if (spec.throws) throw new Error('listing failed');
        return structuredClone(spec.listRows ?? spec.cached ?? []);
      };
    }
    if (spec.cached) {
      impl.getCachedModelInfo = (model) => spec.cached.find((m) => m.id === model) || null;
    }
    providers.set(name, { impl, spec });
  }
  const registry = {
    providerCatalogRevision: () => revision,
    getProvider: (name) => providers.get(name)?.impl ?? null,
    getAllProviders: () => [...providers].map(([name, { impl }]) => [name, impl]),
  };
  let warmups = 0;
  const meta = createModelMetaIndex({
    caches,
    modelMetaByRoute: map,
    reg: () => registry,
    scheduleProviderModelWarmup: () => {
      warmups += 1;
    },
  });
  const out = [];
  return (async () => {
    for (const op of scenario.ops) {
      const record = { ...op };
      if (op.op === 'lookup') {
        record.expect = await meta.lookupModelMeta(op.provider, op.model, { allowFetch: op.allowFetch === true });
      } else if (op.op === 'startupListing') {
        providers.get(op.provider).spec.cached.splice(0, Infinity, ...structuredClone(op.rows));
      } else if (op.op === 'setCached') {
        const spec = providers.get(op.provider).spec;
        spec.cached.splice(0, Infinity, ...structuredClone(op.rows));
      } else if (op.op === 'bumpRevision' || op.op === 'invalidate') {
        act(op.op);
      } else if (op.op === 'load') {
        const loader = createCatalogLoader({
          caches,
          config: () => ({ providers: {} }),
          reg: () => registry,
          meta,
          rows: { providerModelCacheRow: (name, m) => providerModelCacheRow(name, m, () => false) },
          profile: () => {},
          ensureFullConfig: () => {},
          awaitKeychainPrewarm: async () => {},
          ensureProvidersReady: async () => {},
        });
        invalidateSharedProviderCatalog();
        const rows = await loader({ loadSecrets: false, request: { seq: caches.providerModelsLoadSeq } });
        record.expect = rows.map((r) => ({ provider: r.provider, id: r.id }));
      }
      record.listCalls = listCalls;
      record.warmups = warmups;
      out.push(record);
    }
    return { ...scenario, providers: initial, ops: out };
  })();
}

const scenarios = [];
for (const scenario of SCENARIOS) scenarios.push(await runScenario(structuredClone(scenario)));

const commit = args.get('commit') ?? 'unknown';
writeJson(resolve(args.get('out') ?? join(FIXTURES_ROOT, 'providers', 'oracles', 'model-meta.json')), {
  _doc:
    "Recorded from Node's REAL createModelMetaIndex (lookupModelMeta) and createCatalogLoader (remember) over scripted providers behind a fake registry. `providers[name]`: `list` = has listModels, `cached` = has getCachedModelInfo over these (mutable) rows, `listRows` = what listModels returns (default: `cached`), `throws`, `duringList` = an action taken inside listModels. `expect` is Node's answer; `listCalls` the listModels calls so far; `warmups` the scheduleProviderModelWarmup calls so far.",
  recorder: 'benchmarks/rust-core/recorders/record-model-meta.mjs',
  nodeCommit: commit,
  scenarios,
});
console.log(`recorded ${scenarios.length} scenarios from ${commit}`);
