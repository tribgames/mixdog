// One-off model selection for a spawn the user explicitly pinned to a model.
// The agent's preset route stays the default; this only runs when `model` is
// passed. The query is matched against the live provider catalog — literal id,
// then normalized id, then exact display name, then every query word — and a catalog miss retries
// once on a refreshed catalog. One match runs; several or none fail with
// candidates instead of substituting another model.
import { clean } from './helpers.mjs';

const CANDIDATE_LIMIT = 8;

const norm = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
const terms = (value) =>
  String(value || '')
    .toLowerCase()
    .split(/\s+/)
    .map(norm)
    .filter(Boolean);
const label = (row) => `${row.provider}/${row.id}`;

function providerRows(rows, provider) {
  if (!provider) return rows;
  const wanted = norm(provider);
  const exact = rows.filter((row) => norm(row.provider) === wanted);
  return exact.length ? exact : rows.filter((row) => norm(row.provider).includes(wanted));
}

function matchModels(rows, query) {
  const wanted = norm(query);
  const words = terms(query);
  // Nothing to match on ("???"): `[].every` would accept every row.
  if (!words.length) return [];
  const tiers = [
    // A literal id wins over its normalized look-alikes (`foo-bar` vs `foo_bar`).
    (row) => row.id === query,
    (row) => norm(row.id) === wanted,
    (row) => norm(row.display) === wanted,
    (row) => words.every((word) => `${norm(row.id)} ${norm(row.display)}`.includes(word)),
  ];
  for (const test of tiers) {
    const hits = rows.filter(test);
    if (hits.length) return hits;
  }
  return [];
}

function candidates(rows) {
  const shown = rows.slice(0, CANDIDATE_LIMIT).map(label).join(', ');
  return rows.length > CANDIDATE_LIMIT ? `${shown}, … (${rows.length} total)` : shown;
}

/** Resolve args.provider/args.model to one exact catalog route. Without a
 *  catalog (headless/daemon surfaces) exact provider + model pass through. */
export async function resolveRequestedModel(args, listProviderModels) {
  const model = clean(args.model);
  const provider = clean(args.provider);
  if (!model) {
    if (provider) throw new Error('agent spawn: provider requires model');
    return args;
  }
  if (typeof listProviderModels !== 'function') {
    if (!provider) throw new Error('agent spawn: model requires provider on this surface');
    // Punctuation alone names no model; the catalog path rejects it the same way.
    if (!terms(model).length) throw new Error(`agent spawn: model "${model}" for provider "${provider}" not found`);
    return args;
  }
  let pool = providerRows(await listProviderModels(), provider);
  let hits = matchModels(pool, model);
  if (!hits.length) {
    pool = providerRows(await listProviderModels({ force: true }), provider);
    hits = matchModels(pool, model);
  }
  if (hits.length === 1) return { ...args, provider: hits[0].provider, model: hits[0].id };
  const scope = provider ? ` for provider "${provider}"` : '';
  if (hits.length > 1) {
    throw new Error(`agent spawn: model "${model}"${scope} is ambiguous: ${candidates(hits)}; pass the exact one`);
  }
  if (!pool.length) {
    throw new Error(`agent spawn: provider "${provider}" has no available models`);
  }
  throw new Error(`agent spawn: model "${model}"${scope} not found; available: ${candidates(pool)}`);
}
