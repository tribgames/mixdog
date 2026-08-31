/**
 * Memory-resident shape of the overlay catalogs.
 *
 * The published catalogs are large: models.dev ships 211 providers / 7,488
 * models (4.2MB on disk) and LiteLLM 3,408 rows (1.4MB), and both carry prose
 * and metadata no lookup in model-catalog.mjs ever reads — `description`
 * alone dominates the models.dev payload. Holding the parsed originals
 * resident measured 21.4MB of heap in every process that loads them, for a
 * useful surface of about a dozen fields.
 *
 * So a row is narrowed to exactly the fields its readers touch the moment it
 * arrives, and the parsed original becomes garbage. Nested values that survive
 * (arrays, strings) are kept BY REFERENCE: the original container is
 * unreachable either way, so copying them would only duplicate live bytes.
 *
 * Disk caches keep the FULL payload. A projection is a memory shape, not a
 * storage format, so widening it later never forces a refetch — the next warm
 * simply reads more fields out of the file already on disk.
 *
 * Every field below is here because a reader exists for it; the reader is
 * named beside it. Adding a field without a reader re-grows the very cost this
 * module exists to remove.
 */

// ── models.dev ──────────────────────────────────────────────────────────────
// Readers: _modelsDevRowToOverride (cost/limit/reasoning/reasoning_options/
// interleaved.field/tool_call/modalities.input), _applyCodingUnfit
// (tool_call, modalities.output), _releaseEpoch (release_date),
// _stalenessFamily (family). `id`/`name` are NOT kept: both call sites pass
// the model id explicitly, so the row-level copy would only duplicate the key.
const MODELSDEV_COST_FIELDS = ['input', 'output', 'cache_read', 'cache_write'];
const MODELSDEV_LIMIT_FIELDS = ['context', 'output'];
const MODELSDEV_MODALITY_FIELDS = ['input', 'output'];

/** Copy the listed keys when present. Returns undefined when none survive, so
 *  callers can drop the container entirely rather than store an empty object. */
function pickPresent(source, fields) {
    if (!source || typeof source !== 'object') return undefined;
    let out;
    for (const field of fields) {
        const value = source[field];
        if (value == null) continue;
        (out ||= {})[field] = value;
    }
    return out;
}

function pickArrays(source, fields) {
    if (!source || typeof source !== 'object') return undefined;
    let out;
    for (const field of fields) {
        const value = source[field];
        if (!Array.isArray(value)) continue;
        (out ||= {})[field] = value;
    }
    return out;
}

function projectModelsDevRow(row) {
    if (!row || typeof row !== 'object') return null;
    const out = {};
    // `cost` gates _modelsDevMetadataSync entirely — a row without it yields no
    // metadata, so an absent cost must stay absent rather than become {}.
    const cost = pickPresent(row.cost, MODELSDEV_COST_FIELDS);
    if (cost) out.cost = cost;
    const limit = pickPresent(row.limit, MODELSDEV_LIMIT_FIELDS);
    if (limit) out.limit = limit;
    const modalities = pickArrays(row.modalities, MODELSDEV_MODALITY_FIELDS);
    if (modalities) out.modalities = modalities;
    if (row.reasoning === true) out.reasoning = true;
    if (Array.isArray(row.reasoning_options) && row.reasoning_options.length > 0) {
        out.reasoning_options = row.reasoning_options;
    }
    const interleavedField = row.interleaved?.field;
    if (interleavedField) out.interleaved = { field: interleavedField };
    // tool_call is read as an explicit `=== false` drop signal, so the
    // distinction between false and absent must survive.
    if (typeof row.tool_call === 'boolean') out.tool_call = row.tool_call;
    if (typeof row.family === 'string' && row.family) out.family = row.family;
    if (typeof row.release_date === 'string' && row.release_date) out.release_date = row.release_date;
    return out;
}

/**
 * Narrow a models.dev catalog to `{ [providerId]: { models } }`.
 * Providers without a models map are dropped: every lookup path reaches rows
 * through `.models`, so such an entry can never answer one.
 */
export function projectModelsDevCatalog(data) {
    if (!data || typeof data !== 'object') return data;
    const out = {};
    for (const [providerId, provider] of Object.entries(data)) {
        const models = provider?.models;
        if (!models || typeof models !== 'object') continue;
        const projected = {};
        for (const [modelId, row] of Object.entries(models)) {
            const projectedRow = projectModelsDevRow(row);
            if (projectedRow) projected[modelId] = projectedRow;
        }
        out[providerId] = { models: projected };
    }
    return out;
}

// ── LiteLLM ─────────────────────────────────────────────────────────────────
// Readers: _normalize (limits, costs, capability flags, reasoning fields,
// mode) and the provider guard in getModelMetadataSync / enrichModels
// (litellm_provider).
const LITELLM_NUMBER_FIELDS = [
    'max_input_tokens',
    'max_tokens',
    'max_output_tokens',
    'input_cost_per_token',
    'output_cost_per_token',
    'cache_read_input_token_cost',
    'cache_creation_input_token_cost',
];
// _normalize tests each of these with `=== true`, so only a true value carries
// information; anything else is indistinguishable from absent.
const LITELLM_FLAG_FIELDS = [
    'supports_vision',
    'supports_function_calling',
    'supports_web_search',
    'supports_websearch',
    'supports_prompt_caching',
    'supports_reasoning',
];
const LITELLM_STRING_FIELDS = ['mode', 'litellm_provider', 'reasoning_content_field'];

function projectLitellmRow(row) {
    if (!row || typeof row !== 'object') return null;
    const out = {};
    for (const field of LITELLM_NUMBER_FIELDS) {
        const value = row[field];
        if (typeof value === 'number' && Number.isFinite(value)) out[field] = value;
    }
    for (const field of LITELLM_FLAG_FIELDS) {
        if (row[field] === true) out[field] = true;
    }
    for (const field of LITELLM_STRING_FIELDS) {
        const value = row[field];
        if (typeof value === 'string' && value) out[field] = value;
    }
    if (Array.isArray(row.reasoning_options) && row.reasoning_options.length > 0) {
        out.reasoning_options = row.reasoning_options;
    }
    return out;
}

/** Narrow a LiteLLM catalog in place of its parsed original. Keys are the
 *  lookup surface and are preserved exactly; only row shape narrows. */
export function projectLitellmCatalog(data) {
    if (!data || typeof data !== 'object') return data;
    const out = {};
    for (const [key, row] of Object.entries(data)) {
        const projectedRow = projectLitellmRow(row);
        if (projectedRow) out[key] = projectedRow;
    }
    return out;
}
