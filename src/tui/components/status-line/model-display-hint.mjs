/*
 * components/status-line/model-display-hint.mjs — the catalog's display name of a model, for the footer's model segment.
 *
 * Node's footer asked `getModelMetadataSync(model, provider)` (runtime/shared/llm/model-catalog.mjs) for it. That
 * lookup layers, in this order:
 *   - the catalogs: a hand-verified pricing override, else the LiteLLM row, then the models.dev row, whose cleaned
 *     name is the model's display name;
 *   - the provider's cached roster file (`<provider>-models.json`, written by the core), used whole when nothing
 *     above described the model, so its `displayName`/`display`/`name` is the hint;
 *   - the offline seed of the Muse provider, which fills a name nothing above supplied;
 *   - for a relay, the row of the vendor serving the model, which names it when the relay's own lookup found none.
 * The pricing catalogs are in memory only once something has loaded them (Node's model pickers did); before that
 * (`catalogs` null) the lookup runs on the layers that need none. Metadata is reduced here to what decides the name:
 * `{ displayName, name, rates }` (`rates`: which of the four price slots are set, since a row with prices lends its
 * name to a relay that has none).
 */
const PROVIDER_CATALOGS = Object.freeze({
  openai: { modelsDev: 'openai', sameEndpoint: true },
  'openai-oauth': { modelsDev: 'openai', sameEndpoint: false, rosterFiles: ['openai-oauth-models.json'] },
  'anthropic-oauth': { modelsDev: 'anthropic', sameEndpoint: false, rosterFiles: ['anthropic-oauth-models.json'] },
  anthropic: { modelsDev: 'anthropic', sameEndpoint: true, rosterFiles: ['anthropic-oauth-models.json'] },
  gemini: { modelsDev: 'google', sameEndpoint: true, rosterFiles: ['gemini-models.json'] },
  'vertex-ai': { modelsDev: 'google-vertex', sameEndpoint: true },
  'grok-oauth': { modelsDev: 'xai', sameEndpoint: false, rosterFiles: ['grok-oauth-models.json'] },
  'muse-code-oauth': { modelsDev: 'meta', sameEndpoint: true, rosterFiles: ['muse-code-oauth-models.json'], museSeed: true },
  'mimo-oauth': { modelsDev: 'xiaomi', sameEndpoint: false, rosterFiles: ['mimo-oauth-models.json'] },
  'antigravity-oauth': { relay: true, rosterFiles: ['antigravity-oauth-models.json'] },
  'command-code-oauth': { relay: true, rosterFiles: ['command-code-oauth-models.json'] },
  'cursor-oauth': { relay: true },
  'devin-oauth': { relay: true },
  'cursor-api': { relay: true },
  'opencode-go': { relay: true },
  'opencode-go-oauth': { modelsDev: 'opencode-go', relay: true, rosterFiles: ['opencode-go-oauth-models.json'] },
});

const SIMPLE_PREFIXES = [
  'anthropic/',
  'openai/',
  'gemini/',
  'google/',
  'xai/',
  'azure_ai/',
  'deepseek/',
  'openrouter/anthropic/',
  'openrouter/openai/',
  'vertex_ai/',
];
const BEDROCK_PREFIXES = ['anthropic.', 'bedrock/anthropic.'];
const PROVIDER_CATALOG_PREFIXES = {
  openai: ['openai/'],
  anthropic: ['anthropic/'],
  google: ['gemini/', 'google/'],
  xai: ['xai/'],
  deepseek: ['deepseek/'],
  azure: ['azure_ai/'],
  'google-vertex': ['vertex_ai/'],
};

// The models with a hand-verified pricing override: the LiteLLM provider each belongs to, and which of the four
// price slots (input, output, cache read, cache write) it sets.
const PRICING_OVERRIDES = Object.freeze({
  'gemini-3-flash': { provider: 'gemini', rates: [true, true, true, false] },
  'gemini-3.1-pro': { provider: 'gemini', rates: [true, true, true, false] },
  'deepseek-flash': { provider: 'deepseek', rates: [true, true, true, false] },
  'deepseek-v4-flash': { provider: 'deepseek', rates: [true, true, true, false] },
  'deepseek-v4-pro': { provider: 'deepseek', rates: [true, true, true, false] },
});
// Cursor's first-party SKUs with Cursor-billed rates (which price slots each sets).
const CURSOR_PRICED = Object.freeze({
  'composer-2.5': [true, true, true, false],
  'grok-4.7': [false, false, false, false],
  'grok-4.6': [false, false, false, false],
  'grok-4.5': [false, false, false, false],
  'claude-opus-4-7': [false, false, false, false],
});
const RETIRED_GROK_ALIASES = Object.freeze({
  'grok-code-fast-1': 'grok-build-0.1',
  'grok-code-fast': 'grok-build-0.1',
  'grok-code-fast-1-0825': 'grok-build-0.1',
});
const ANTIGRAVITY_PRICING_ALIASES = Object.freeze({ 'claude-opus-4-6-thinking': 'claude-opus-4-6' });
// The offline Antigravity roster: id and the wire id(s) it is served under.
const ANTIGRAVITY_MODELS = Object.freeze([
  { id: 'gemini-3.8-flash', wire: ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high'] },
  { id: 'gemini-3.1-pro', wire: ['gemini-3.1-pro-low', 'gemini-3.1-pro-high'] },
  { id: 'gemini-4-argon', wire: ['gemini-4-argon-low', 'gemini-4-argon-medium', 'gemini-4-argon-high'] },
  { id: 'claude-opus-4-6-thinking', wire: ['claude-opus-4-6-thinking'], single: true },
  { id: 'claude-sonnet-4-6', wire: ['claude-sonnet-4-6'], single: true },
  { id: 'gpt-oss-120b-medium', wire: ['gpt-oss-120b-medium'], single: true },
]);
const MUSE_SEED_NAMES = Object.freeze({
  'muse-spark-1.1': 'Muse Spark 1.1',
  'muse-spark-1.2': 'Muse Spark 1.2',
  'muse-spark-1.2-contributor': 'Muse Spark 1.2 (C)',
  'muse-spark-1.3': 'Muse Spark 1.3',
  'muse-spark-1.3-contributor': 'Muse Spark 1.3 (C)',
});
const MUSE_SEED_RATES = Object.freeze([true, true, true, true]);
const SPARK_ID_RE = /^muse-spark-(\d+)\.(\d+)(?:\.(\d+))?(-contributor)?$/i;

function museSeed(id) {
  const key = String(id || '');
  if (MUSE_SEED_NAMES[key]) return { name: MUSE_SEED_NAMES[key] };
  const match = SPARK_ID_RE.exec(key);
  if (!match) return null;
  const revision = match[3] && Number(match[3]) !== 0 ? `${match[1]}.${match[2]}.${match[3]}` : `${match[1]}.${match[2]}`;
  return { name: `Muse Spark ${revision}${match[4] ? ' (C)' : ''}` };
}

const catalogEntry = (provider) => {
  const p = String(provider || '').trim().toLowerCase();
  if (!p) return null;
  const entry = PROVIDER_CATALOGS[p] || {};
  return {
    provider: p,
    modelsDev: entry.modelsDev || p,
    sameEndpoint: entry.sameEndpoint !== false,
    relay: entry.relay === true,
    rosterFiles: entry.rosterFiles || [],
    museSeed: entry.museSeed === true,
  };
};
const modelsDevProviderId = (provider) => catalogEntry(provider)?.modelsDev || null;
const firstPartyIds = () =>
  [
    ...new Set(
      Object.values(PROVIDER_CATALOGS)
        .filter((entry) => entry.relay !== true && entry.modelsDev)
        .map((entry) => entry.modelsDev)
    ),
  ].sort();

const NO_RATES = Object.freeze([false, false, false, false]);
const hasRates = (meta) => Boolean(meta?.rates?.some(Boolean));

function modelAliases(id) {
  const text = String(id || '').trim();
  if (!text) return [];
  return [...new Set([text, text.replace(/-\d{4}-\d{2}-\d{2}$/, ''), text.replace(/-\d{8}$/, '')])].filter(Boolean);
}
const rowId = (row) => String(row?.id || row?.name || row?.slug || '').trim();

/** A models.dev row's name without marketing tails ("(New)") or a contributor-tier suffix. */
function modelsDevDisplayName(row) {
  const name = typeof row?.name === 'string' ? row.name : '';
  return (
    name
      .replace(/\s*\([^)]*\)\s*$/, '')
      .replace(/\s+contributor$/i, '')
      .trim() || null
  );
}

/* ── the catalogs' projections (what Node kept resident of the LiteLLM and models.dev files) ────────── */

const validRate = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** `{ [key]: { litellm_provider, rates } }` of a LiteLLM catalog's `data`. */
export function projectLitellmForHint(data) {
  if (!data || typeof data !== 'object') return {};
  const out = {};
  for (const [key, row] of Object.entries(data)) {
    if (!row || typeof row !== 'object') continue;
    const provider = typeof row.litellm_provider === 'string' && row.litellm_provider ? row.litellm_provider : undefined;
    out[key] = {
      litellm_provider: provider,
      rates: [
        validRate(row.input_cost_per_token),
        validRate(row.output_cost_per_token),
        validRate(row.cache_read_input_token_cost),
        validRate(row.cache_creation_input_token_cost),
      ],
    };
  }
  return out;
}

/** `{ [provider]: { models: { [id]: { name, rates } } } }` of a models.dev catalog's `data`. */
export function projectModelsDevForHint(data) {
  if (!data || typeof data !== 'object') return {};
  const out = {};
  for (const [providerId, provider] of Object.entries(data)) {
    const models = provider?.models;
    if (!models || typeof models !== 'object') continue;
    const projected = {};
    for (const [modelId, row] of Object.entries(models)) {
      if (!row || typeof row !== 'object') continue;
      const cost = row.cost && typeof row.cost === 'object' ? row.cost : {};
      projected[modelId] = {
        name: typeof row.name === 'string' && row.name ? row.name : undefined,
        rates: [validRate(cost.input), validRate(cost.output), validRate(cost.cache_read), validRate(cost.cache_write)],
      };
    }
    out[providerId] = { models: projected };
  }
  return out;
}

/* ── the lookup ─────────────────────────────────────────────────────────────────────────────────────── */

function pricingModel(provider, model, rosterRows) {
  if (provider === 'grok-oauth') return RETIRED_GROK_ALIASES[model] || model;
  if (provider !== 'antigravity-oauth') return model;
  const files = catalogEntry(provider)?.rosterFiles || [];
  const seen = new Set();
  const rows = [];
  for (const file of files) {
    for (const row of rosterRows(file)) {
      const id = rowId(row);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push({ ...row, id });
    }
  }
  const found =
    rows.find(
      (entry) =>
        entry.id === model ||
        entry.wire === model ||
        (entry.wire && typeof entry.wire === 'object' && Object.values(entry.wire).includes(model))
    ) || ANTIGRAVITY_MODELS.find((entry) => entry.id === model || entry.wire.includes(model));
  const id = found?.pricingModel || found?.id || model;
  return ANTIGRAVITY_PRICING_ALIASES[id] || id;
}

// Provider SKUs published only as a multiple of a base SKU's rates (see model-catalog.mjs `pricedVariant`).
function pricedVariant(provider, id) {
  if (provider === 'grok-oauth' && id === 'grok-4.7-build-fast') return { base: 'grok-4.7' };
  if (provider === 'vertex-ai' && id.endsWith('@regional')) return { base: id.slice(0, -'@regional'.length) };
  const version = provider === 'vertex-ai' ? id.indexOf('@') : -1;
  if (version > 0) return { base: id.slice(0, version) };
  return null;
}

const pricingOnly = (meta) => (meta ? { rates: meta.rates, displayName: meta.displayName || null } : null);

function catalogMetadata(id, mappedProvider, catalogs) {
  let meta = null;
  let fromOverride = false;
  const override = PRICING_OVERRIDES[id];
  if (override && (!mappedProvider || modelsDevProviderId(override.provider) === mappedProvider)) {
    meta = { rates: override.rates };
    fromOverride = true;
  }
  const litellm = catalogs?.litellm || {};
  if (!meta) {
    const row = litellm[id];
    if (row && (!mappedProvider || modelsDevProviderId(row.litellm_provider) === mappedProvider)) meta = { rates: row.rates };
    const allowed = !mappedProvider ? SIMPLE_PREFIXES : PROVIDER_CATALOG_PREFIXES[mappedProvider] ? SIMPLE_PREFIXES.filter((p) => PROVIDER_CATALOG_PREFIXES[mappedProvider].includes(p)) : [];
    for (const prefix of allowed) {
      if (meta) break;
      if (litellm[prefix + id]) meta = { rates: litellm[prefix + id].rates };
    }
    for (const prefix of !mappedProvider || mappedProvider === 'anthropic' ? BEDROCK_PREFIXES : []) {
      if (meta) break;
      const v1 = litellm[`${prefix + id}-v1:0`];
      if (v1) meta = { rates: v1.rates };
    }
  }
  if (mappedProvider) {
    const row = catalogs?.modelsDev?.[mappedProvider]?.models?.[id];
    if (row) {
      // The row's prices overlay the base's, unless the base is an override.
      const rates = meta
        ? meta.rates.map((base, i) => (!fromOverride && row.rates[i] ? true : base))
        : row.rates;
      meta = { ...(meta || {}), rates, displayName: modelsDevDisplayName({ name: row.name }) };
    }
  }
  return meta;
}

// The vendors that serve a relayed model, read off the catalogs (`_relayedModelVendors`).
function relayedModelVendors(id, catalogs) {
  const isVendor = (vendor) => Boolean(vendor) && !String(vendor).startsWith('custom-') && !catalogEntry(vendor)?.relay;
  const vendors = new Set();
  for (const key of [id, ...SIMPLE_PREFIXES.map((prefix) => prefix + id)]) {
    const vendor = modelsDevProviderId(catalogs?.litellm?.[key]?.litellm_provider);
    if (isVendor(vendor)) vendors.add(vendor);
  }
  const firstParty = new Set(firstPartyIds());
  const modelsDev = catalogs?.modelsDev || {};
  for (const vendor of firstParty) if (modelsDev[vendor]?.models?.[id]) vendors.add(vendor);
  const unregistered = Object.entries(modelsDev)
    .filter(([vendor, entry]) => entry?.models?.[id] && !firstParty.has(vendor) && isVendor(vendor))
    .map(([vendor]) => vendor);
  if (unregistered.length === 1) vendors.add(unregistered[0]);
  return vendors;
}

function servingVendorMetadata(id, catalogs, rosterRows) {
  for (const candidate of new Set([id, id.replace(/(\d)\.(\d)/g, '$1-$2')])) {
    for (const vendor of relayedModelVendors(candidate, catalogs)) {
      const row = lookup(candidate, vendor, catalogs, rosterRows);
      if (row) return row;
    }
  }
  return null;
}

function customVendorMetadata(originalId, catalogs, rosterRows) {
  const listedId = String(originalId || '');
  for (const id of new Set([listedId, listedId.slice(listedId.lastIndexOf('/') + 1)])) {
    if (!id) continue;
    const guess = servingVendorMetadata(id, catalogs, rosterRows);
    if (guess) return guess;
  }
  return null;
}

/** `lookupModelMetadata` reduced to `{ displayName, name, rates }`, or null when nothing describes the model. */
function lookup(originalId, provider, catalogs, rosterRows) {
  const custom = String(provider || '').startsWith('custom-');
  const id = pricingModel(provider, originalId, rosterRows);
  const source = provider ? catalogEntry(provider) : null;
  const mappedProvider = source?.modelsDev || null;
  const mapped = catalogMetadata(id, mappedProvider, catalogs);
  let meta = source && !source.sameEndpoint ? pricingOnly(mapped) : mapped;
  let guess = null;
  const relayGuess = source?.relay ? servingVendorMetadata(id, catalogs, rosterRows) : null;
  if (custom) guess = customVendorMetadata(originalId, catalogs, rosterRows);
  else if (relayGuess) guess = relayGuess;
  else if (source && !source.sameEndpoint) guess = mapped;
  if (source?.relay && !hasRates(meta) && hasRates(guess)) {
    meta = meta ? { ...meta, rates: guess.rates } : pricingOnly(guess);
  }
  const variant = pricedVariant(source?.provider || '', id);
  if (variant && !hasRates(meta)) {
    const base = lookup(variant.base, provider, catalogs, rosterRows);
    if (hasRates(base)) meta = { ...meta, rates: base.rates };
  }
  const cursorRates = /^cursor-(?:oauth|api)$/.test(source?.provider || '') ? CURSOR_PRICED[id] : null;
  if (cursorRates) meta = { ...meta, rates: hasRates(meta) ? meta.rates : cursorRates };

  let cached = null;
  if (source?.rosterFiles.length) {
    const aliases = new Set(modelAliases(originalId));
    outer: for (const fileName of source.rosterFiles) {
      for (const row of rosterRows(fileName)) {
        const found = rowId(row);
        if (found && aliases.has(found)) {
          cached = row;
          break outer;
        }
      }
    }
  }
  const seed = source?.museSeed ? museSeed(originalId) : null;
  if (!meta && !cached && !seed && !guess) return null;
  // A custom model known only through its vendor gets the guess alone.
  if (custom && !meta && !cached) return { rates: NO_RATES };

  if (cached) {
    const roster = {
      displayName: cached.displayName || cached.display || cached.name || null,
      name: cached.name || cached.display || null,
      rates: NO_RATES,
    };
    // The cached roster row is the metadata when nothing described the model before it.
    meta = meta ? meta : roster;
  }
  meta = { ...(meta || { rates: NO_RATES }) };
  if (!meta.displayName && seed?.name) meta.displayName = seed.name;
  if (seed && !hasRates(meta)) meta.rates = MUSE_SEED_RATES;
  return meta;
}

/**
 * The display name the catalog gives `model` of `provider`, or '' when it gives none. `rosterRows(fileName)` is a
 * roster file's rows; `catalogs` the projections `{ litellm, modelsDev }` once the pricing catalogs are loaded,
 * null before.
 */
export function catalogDisplayHint(model, provider, rosterRows, catalogs = null) {
  const original = String(model || '').trim();
  if (!original) return '';
  const meta = lookup(original, provider || '', catalogs, rosterRows);
  return String(meta?.displayName || meta?.name || '').trim();
}
