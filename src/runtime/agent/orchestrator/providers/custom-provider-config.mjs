// Custom provider config (schema v2): normalization, legacy migration,
// validation and the pure layering of per-model overrides on top of the
// auto-discovered (catalog-enriched) model list. No I/O.

import { CUSTOM_EFFORT_LEVELS, normalizeCustomEffort } from './custom-reasoning.mjs';
import { assertSafeBaseURL } from './provider-base-url.mjs';

export const CUSTOM_PROVIDER_PROTOCOLS = Object.freeze(['openai-chat', 'openai-responses', 'anthropic']);
export const CUSTOM_PROVIDER_SCHEMA_VERSION = 2;
// Ranked weakest → strongest.
export const CUSTOM_REASONING_LEVELS = CUSTOM_EFFORT_LEVELS;
export const CUSTOM_REASONING_WIRE_FORMATS = Object.freeze(['standard', 'deepseek', 'together', 'vllm']);
export const CUSTOM_PROVIDER_AUTH_MODES = Object.freeze(['key', 'none']);
export const CUSTOM_MODEL_OVERRIDE_LIMIT = 500;
export const CUSTOM_HEADER_LIMIT = 64;

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_MODEL_ID = 256;
const MAX_NAME = 200;
const MAX_WIRE_VALUE = 64;
const MAX_HEADER_TEXT = 4096;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// RFC 9110 field-name token, and a field value of visible ASCII, space, tab and
// obs-text (what a fetch Headers value can carry).
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
// The API key field owns authentication; a header may not carry a credential.
const AUTH_HEADERS = new Set(['authorization', 'x-api-key', 'api-key']);

function fail(message) {
  throw new Error(`[custom-provider] ${message}`);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value, label, max) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const out = value.trim();
  if (out.length > max) fail(`${label} must be at most ${max} characters`);
  if (CONTROL_CHARS.test(out)) fail(`${label} must not contain control characters`);
  return out;
}

// Legacy (unversioned) input stays tolerant: blank → unset, numeric strings ok.
// An integer beyond the safe range is dropped (unset), so migration only ever
// emits values the v2 loader accepts.
function lenientPositiveInt(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) fail(`${label} must be a positive integer`);
  return Number.isSafeInteger(n) ? n : undefined;
}

// v2: a JSON number that is a safe positive integer, or absent.
function strictPositiveInt(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    fail(`${label} must be a positive integer`);
  return value;
}

const OVERRIDE_KEYS = new Set([
  'manual',
  'hidden',
  'name',
  'contextWindow',
  'maxOutputTokens',
  'supportsVision',
  'reasoning',
]);
const REASONING_KEYS = new Set(['levels', 'wireFormat', 'wireValues', 'replay']);
const DISCOVERY_KEYS = new Set(['newModelsHidden']);
// v2 config fields, plus the transport fields callers pass alongside them and
// the normalizer ignores: `id` / `apiKey` (setup input, validated by the
// service/IPC) and `preconnect` (runtime construction flag).
const V2_TOP_LEVEL_KEYS = new Set([
  'type',
  'schemaVersion',
  'name',
  'protocol',
  'baseURL',
  'enabled',
  'auth',
  'discovery',
  'modelOverrides',
  'wires',
  'modelWires',
  'headers',
  'id',
  'apiKey',
  'apiKeyEnv',
  'preconnect',
]);
export const CUSTOM_API_KEY_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

// Env var name that supplies the key, or '' when unset (undefined / null).
function normalizeApiKeyEnv(raw) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string' || !CUSTOM_API_KEY_ENV_RE.test(raw))
    fail('apiKeyEnv must be a valid environment variable name');
  return raw;
}
const MAX_BASE_URL = 2048;

function onlyKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label} has unsupported field: ${key}`);
}

function optionalBoolean(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}

function normalizeBaseURL(raw) {
  const value = text(raw);
  if (!value) fail('baseURL is required');
  if (value.length > MAX_BASE_URL) fail(`baseURL must be at most ${MAX_BASE_URL} characters`);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`invalid baseURL: ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail('baseURL must use http or https');
  if (url.username || url.password) fail('baseURL must not embed credentials');
  if (url.search || url.hash || /[?#]/.test(value)) fail('baseURL must not contain a query or hash');
  return assertSafeBaseURL(value.replace(/\/+$/, ''), 'custom');
}

function modelIdKey(raw, label = 'model id') {
  const id = typeof raw === 'string' ? raw : '';
  if (!id.trim()) fail(`every ${label} must be a non-empty string`);
  if (id !== id.trim()) fail(`${label} must not have surrounding whitespace: ${JSON.stringify(id)}`);
  if (id.length > MAX_MODEL_ID) fail(`${label} must be at most ${MAX_MODEL_ID} characters`);
  if (CONTROL_CHARS.test(id)) fail(`${label} must not contain control characters`);
  if (UNSAFE_KEYS.has(id)) fail(`unsafe ${label}: ${id}`);
  return id;
}

/** Canonical level for `raw` (alias-aware), or null when unknown. */
export function canonicalReasoningLevel(raw) {
  return typeof raw === 'string' ? normalizeCustomEffort(raw) : null;
}

const rank = (level) => CUSTOM_REASONING_LEVELS.indexOf(level);
const byRank = (a, b) => rank(a) - rank(b);

function normalizeLevels(raw, label) {
  if (!Array.isArray(raw)) fail(`${label} must be an array`);
  const seen = new Set();
  for (const entry of raw) {
    const level = canonicalReasoningLevel(entry);
    if (!level) fail(`${label} has unknown level: ${String(entry)}`);
    if (seen.has(level)) fail(`${label} has duplicate level: ${level}`);
    seen.add(level);
  }
  return [...seen].sort(byRank);
}

function normalizeReasoning(raw, label, protocol) {
  if (!isPlainObject(raw)) fail(`${label} must be an object`);
  onlyKnownKeys(raw, REASONING_KEYS, label);
  const out = {};
  if (raw.levels !== undefined) out.levels = normalizeLevels(raw.levels, `${label}.levels`);
  if (raw.wireFormat !== undefined) {
    const wireFormat = text(raw.wireFormat);
    if (!CUSTOM_REASONING_WIRE_FORMATS.includes(wireFormat)) fail(`${label}.wireFormat is invalid: ${raw.wireFormat}`);
    if (wireFormat === 'deepseek' && protocol !== 'openai-chat')
      fail(`${label}.wireFormat 'deepseek' requires protocol 'openai-chat'`);
    out.wireFormat = wireFormat;
  }
  if (raw.wireValues !== undefined) out.wireValues = normalizeWireValues(raw.wireValues, label, out.levels);
  const replay = optionalBoolean(raw.replay, `${label}.replay`);
  if (replay !== undefined) out.replay = replay;
  return out;
}

// `levels` (canonical) ties every key to a declared level; null skips the tie.
function normalizeWireValues(raw, label, levels) {
  if (!isPlainObject(raw)) fail(`${label}.wireValues must be an object`);
  const wireValues = {};
  for (const key of Object.keys(raw)) {
    const level = canonicalReasoningLevel(key);
    if (!level) fail(`${label}.wireValues has unknown level: ${key}`);
    if (levels && !levels.includes(level)) fail(`${label}.wireValues level ${level} is not in levels`);
    if (level in wireValues) fail(`${label}.wireValues has duplicate level: ${level}`);
    const value = boundedText(raw[key], `${label}.wireValues.${level}`, MAX_WIRE_VALUE);
    if (!value) fail(`${label}.wireValues.${level} must be non-empty`);
    wireValues[level] = value;
  }
  return Object.fromEntries(Object.entries(wireValues).sort(([a], [b]) => byRank(a, b)));
}

/**
 * Shape check for a tri-state reasoning patch (null deletes a field): the
 * stored-override rules for every supplied value, minus the levels ↔
 * wireValues tie, which the caller settles after merging (pruning).
 */
export function assertCustomReasoningPatch(raw) {
  const label = 'reasoning patch';
  if (!isPlainObject(raw)) fail(`${label} must be an object`);
  onlyKnownKeys(raw, REASONING_KEYS, label);
  const supplied = (key) => raw[key] !== undefined && raw[key] !== null;
  if (supplied('levels')) normalizeLevels(raw.levels, `${label}.levels`);
  if (supplied('wireFormat') && !CUSTOM_REASONING_WIRE_FORMATS.includes(text(raw.wireFormat)))
    fail(`${label}.wireFormat is invalid: ${String(raw.wireFormat)}`);
  if (supplied('wireValues')) normalizeWireValues(raw.wireValues, label, null);
  if (supplied('replay')) optionalBoolean(raw.replay, `${label}.replay`);
}

// `legacy` marks overrides generated by migrateLegacy from an unversioned
// config, whose tolerant value rules are kept; everything else is v2-strict.
function normalizeOverride(id, raw, protocol, legacy) {
  const label = `modelOverrides[${id}]`;
  if (!isPlainObject(raw)) fail(`${label} must be an object`);
  onlyKnownKeys(raw, OVERRIDE_KEYS, label);
  const positiveInt = legacy ? lenientPositiveInt : strictPositiveInt;
  const out = {};
  const manual = optionalBoolean(raw.manual, `${label}.manual`);
  if (manual) out.manual = true;
  const hidden = optionalBoolean(raw.hidden, `${label}.hidden`);
  if (hidden !== undefined) out.hidden = hidden;
  if (raw.name !== undefined) {
    const name = boundedText(raw.name, `${label}.name`, MAX_NAME);
    if (!name && !legacy) fail(`${label}.name must be non-empty`);
    if (name) out.name = name;
  }
  const contextWindow = positiveInt(raw.contextWindow, `${label}.contextWindow`);
  if (contextWindow) out.contextWindow = contextWindow;
  const maxOutputTokens = positiveInt(raw.maxOutputTokens, `${label}.maxOutputTokens`);
  if (maxOutputTokens) out.maxOutputTokens = maxOutputTokens;
  // Tri-state image input: absent = auto (catalog / default), true / false = the user's word.
  const supportsVision = optionalBoolean(raw.supportsVision, `${label}.supportsVision`);
  if (supportsVision !== undefined) out.supportsVision = supportsVision;
  if (raw.reasoning !== undefined) {
    const reasoning = normalizeReasoning(raw.reasoning, `${label}.reasoning`, protocol);
    if (Object.keys(reasoning).length) out.reasoning = reasoning;
  }
  return out;
}

function normalizeOverrides(raw, protocol, legacy) {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) fail('modelOverrides must be an object');
  const keys = Object.keys(raw);
  if (keys.length > CUSTOM_MODEL_OVERRIDE_LIMIT)
    fail(`at most ${CUSTOM_MODEL_OVERRIDE_LIMIT} model overrides are allowed`);
  const out = {};
  for (const key of keys) {
    const id = modelIdKey(key, 'modelOverrides key');
    out[id] = normalizeOverride(id, raw[key], protocol, legacy);
  }
  return out;
}

// The wire each OpenAI-compatible protocol speaks (wire-route.mjs WIRES).
export const CUSTOM_PROTOCOL_WIRES = Object.freeze({
  'openai-chat': 'chat',
  'openai-responses': 'responses',
  anthropic: 'messages',
});
// Wires a user-defined OpenAI-compatible endpoint can be declared to serve.
export const CUSTOM_PROVIDER_WIRES = Object.freeze(['chat', 'responses', 'messages']);

// `wires`: the wires the endpoint serves (the protocol's own wire included);
// absent = the protocol's wire only. Anthropic-protocol providers speak one wire.
function normalizeWires(raw, protocol) {
  if (raw === undefined) return null;
  if (protocol === 'anthropic') fail("wires requires an 'openai-chat' or 'openai-responses' protocol");
  if (!Array.isArray(raw) || raw.length === 0) fail('wires must be a non-empty array');
  const seen = new Set();
  for (const wire of raw) {
    if (!CUSTOM_PROVIDER_WIRES.includes(wire)) fail(`wires has unsupported wire: ${String(wire)}`);
    if (seen.has(wire)) fail(`wires has duplicate wire: ${wire}`);
    seen.add(wire);
  }
  if (!seen.has(CUSTOM_PROTOCOL_WIRES[protocol]))
    fail(`wires must include the protocol wire: ${CUSTOM_PROTOCOL_WIRES[protocol]}`);
  return CUSTOM_PROVIDER_WIRES.filter((wire) => seen.has(wire));
}

// `modelWires`: per-model wire override, each one of the served wires.
function normalizeModelWires(raw, protocol, wires) {
  if (raw === undefined) return {};
  if (protocol === 'anthropic') fail("modelWires requires an 'openai-chat' or 'openai-responses' protocol");
  if (!isPlainObject(raw)) fail('modelWires must be an object');
  const keys = Object.keys(raw);
  if (keys.length > CUSTOM_MODEL_OVERRIDE_LIMIT) fail(`at most ${CUSTOM_MODEL_OVERRIDE_LIMIT} model wires are allowed`);
  const served = wires || [CUSTOM_PROTOCOL_WIRES[protocol]];
  const out = {};
  for (const key of keys) {
    const id = modelIdKey(key, 'modelWires key');
    if (!served.includes(raw[key])) fail(`modelWires[${id}] must be one of the served wires: ${served.join(', ')}`);
    out[id] = raw[key];
  }
  return out;
}

// `headers`: extra HTTP headers sent with every request to the endpoint
// (inference, model discovery, connection test). Names are case-insensitive
// tokens; the credential headers belong to the API key field.
function normalizeHeaders(raw) {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) fail('headers must be an object of header names to string values');
  const names = Object.keys(raw);
  if (names.length > CUSTOM_HEADER_LIMIT) fail(`at most ${CUSTOM_HEADER_LIMIT} headers are allowed`);
  const seen = new Set();
  const entries = [];
  for (const name of names) {
    if (name.length > MAX_HEADER_TEXT || !HEADER_NAME.test(name))
      fail(`headers has an invalid header name: ${JSON.stringify(name.slice(0, 64))}`);
    const lower = name.toLowerCase();
    if (AUTH_HEADERS.has(lower)) fail(`headers must not set ${name}: authentication belongs to the API key field`);
    if (seen.has(lower)) fail(`headers has duplicate header: ${name}`);
    seen.add(lower);
    if (typeof raw[name] !== 'string') fail(`headers.${name} must be a string`);
    // Validate before trimming, and trim only HTTP whitespace (space, tab), so
    // CR/LF is refused rather than stripped and other characters are kept.
    if (!HEADER_VALUE.test(raw[name])) fail(`headers.${name} has an invalid value`);
    const value = raw[name].replace(/^[ \t]+|[ \t]+$/g, '');
    if (value.length > MAX_HEADER_TEXT) fail(`headers.${name} has an invalid value`);
    entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}

// Legacy (pre-v2) `models: [{ id, name?, contextWindow?, maxOutputTokens? }]`
// become manual, visible overrides; their presence hides newly discovered ids.
function migrateLegacy(input) {
  const raw = input.models === undefined || input.models === null ? [] : input.models;
  if (!Array.isArray(raw)) fail('models must be an array');
  if (raw.length > CUSTOM_MODEL_OVERRIDE_LIMIT) fail(`at most ${CUSTOM_MODEL_OVERRIDE_LIMIT} models are allowed`);
  const modelOverrides = {};
  for (const entry of raw) {
    const id = modelIdKey(text(entry?.id), 'model id');
    if (Object.hasOwn(modelOverrides, id)) fail(`duplicate model id: ${id}`);
    const override = { manual: true, hidden: false };
    const name = text(entry.name);
    if (name) override.name = name;
    if (entry.contextWindow !== undefined) override.contextWindow = entry.contextWindow;
    if (entry.maxOutputTokens !== undefined) override.maxOutputTokens = entry.maxOutputTokens;
    modelOverrides[id] = override;
  }
  return {
    ...input,
    // Legacy entries predate keyless auth; a caller-stated auth still applies.
    auth: input.auth ?? 'key',
    discovery: { newModelsHidden: raw.length > 0 },
    modelOverrides,
  };
}

/**
 * Normalized, secret-free v2 config. Legacy (no schemaVersion) input is
 * migrated deterministically; unknown future versions are rejected.
 */
export function normalizeCustomProviderConfig(input) {
  if (!isPlainObject(input)) fail('config must be an object');
  let source = input;
  const version = input.schemaVersion;
  const legacy = version === undefined || version === null;
  if (legacy) {
    // v2 fields without the version would be silently dropped by migration.
    if (input.modelOverrides !== undefined || input.discovery !== undefined)
      fail('modelOverrides and discovery require schemaVersion 2');
    if (input.wires !== undefined || input.modelWires !== undefined)
      fail('wires and modelWires require schemaVersion 2');
    if (input.headers !== undefined) fail('headers require schemaVersion 2');
    source = migrateLegacy(input);
  } else if (Number.isInteger(version) && version > CUSTOM_PROVIDER_SCHEMA_VERSION)
    fail(`unsupported schemaVersion ${version}; update mixdog to use this provider`);
  else if (version !== CUSTOM_PROVIDER_SCHEMA_VERSION) fail(`invalid schemaVersion: ${String(version)}`);
  if (!legacy) {
    // v2 top level is strict (same accept set as the desktop IPC validator):
    // no unknown fields, exact enum strings, boolean `enabled`. An omitted
    // `auth` means 'key' here; edits keep the stored value in the service.
    onlyKnownKeys(input, V2_TOP_LEVEL_KEYS, 'config');
    if (input.type !== undefined && input.type !== 'custom') fail(`invalid type: ${String(input.type)}`);
    if (input.protocol !== undefined && typeof input.protocol !== 'string') fail('protocol must be a string');
    if (typeof input.protocol === 'string' && input.protocol !== input.protocol.trim())
      fail(`unsupported protocol: ${input.protocol}`);
    if (input.auth !== undefined && !CUSTOM_PROVIDER_AUTH_MODES.includes(input.auth))
      fail(`invalid auth: ${String(input.auth)}`);
    optionalBoolean(input.enabled, 'enabled');
    optionalBoolean(input.preconnect, 'preconnect');
  }
  const name = boundedText(source.name ?? '', 'name', MAX_NAME);
  if (!name) fail('name is required');
  const protocol = text(source.protocol);
  if (!protocol) fail('protocol is required');
  if (!CUSTOM_PROVIDER_PROTOCOLS.includes(protocol)) fail(`unsupported protocol: ${protocol}`);
  const auth = source.auth === undefined || source.auth === null ? 'key' : text(source.auth);
  if (!CUSTOM_PROVIDER_AUTH_MODES.includes(auth)) fail(`invalid auth: ${String(source.auth)}`);
  const apiKeyEnv = normalizeApiKeyEnv(source.apiKeyEnv);
  const discovery = source.discovery === undefined ? {} : source.discovery;
  if (!isPlainObject(discovery)) fail('discovery must be an object');
  onlyKnownKeys(discovery, DISCOVERY_KEYS, 'discovery');
  const newModelsHidden = optionalBoolean(discovery.newModelsHidden, 'discovery.newModelsHidden') ?? false;
  const wires = normalizeWires(source.wires, protocol);
  const modelWires = normalizeModelWires(source.modelWires, protocol, wires);
  const headers = normalizeHeaders(source.headers);
  return {
    type: 'custom',
    schemaVersion: CUSTOM_PROVIDER_SCHEMA_VERSION,
    name,
    protocol,
    baseURL: normalizeBaseURL(source.baseURL),
    enabled: source.enabled !== false,
    auth,
    ...(apiKeyEnv && auth === 'key' ? { apiKeyEnv } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    discovery: { newModelsHidden },
    modelOverrides: normalizeOverrides(source.modelOverrides, protocol, legacy),
    ...(wires ? { wires } : {}),
    ...(Object.keys(modelWires).length ? { modelWires } : {}),
  };
}

function catalogLevels(row) {
  const options = Array.isArray(row?.reasoningOptions) ? row.reasoningOptions : [];
  const levels = new Set();
  for (const option of options) {
    if (option?.type !== 'effort' || !Array.isArray(option.values)) continue;
    for (const value of option.values) {
      const level = canonicalReasoningLevel(value);
      if (level) levels.add(level);
    }
  }
  return levels.size ? [...levels].sort(byRank) : null;
}

function reasoningLevelFields(levels) {
  if (!levels) return {};
  return {
    reasoningOptions: levels.length ? [{ type: 'effort', values: [...levels] }] : [],
    reasoningLevels: [...levels],
  };
}

function effectiveRow(base, override, { providerId, discovered, newModelsHidden }) {
  const ov = override || {};
  const reasoning = ov.reasoning || {};
  const {
    reasoningOptions: _options,
    reasoningLevels: _levels,
    reasoningContentField,
    customReasoning: _custom,
    ...rest
  } = base;
  const levels = reasoning.levels ?? catalogLevels(base);
  const replay = reasoning.replay ?? reasoningContentField === 'reasoning_content';
  const wireValues = {};
  for (const [level, value] of Object.entries(reasoning.wireValues || {})) {
    if (!levels || levels.includes(level)) wireValues[level] = value;
  }
  const hidden = 'hidden' in ov ? ov.hidden : discovered && !override && newModelsHidden;
  return {
    ...rest,
    id: base.id,
    name: ov.name ?? (base.name || base.id),
    provider: providerId || base.provider,
    contextWindow: ov.contextWindow ?? (Number(base.contextWindow) > 0 ? Number(base.contextWindow) : 0),
    outputTokens: ov.maxOutputTokens ?? (Number(base.outputTokens) > 0 ? Number(base.outputTokens) : null),
    hidden,
    manual: ov.manual === true,
    // An explicit override (false included) beats the catalog; unset keeps the base.
    ...(typeof ov.supportsVision === 'boolean' ? { supportsVision: ov.supportsVision } : {}),
    supportsReasoning: levels ? levels.some((level) => level !== 'none') : base.supportsReasoning === true,
    ...reasoningLevelFields(levels),
    customReasoning: { wireFormat: reasoning.wireFormat ?? 'standard', wireValues, replay },
    ...(replay ? { reasoningContentField: 'reasoning_content' } : {}),
  };
}

/**
 * Pure layering: discovered rows (catalog-enriched) as base → overrides by
 * property presence → manual overrides missing from discovery appended.
 * `config` is a normalized v2 config. Hidden rows are kept.
 */
export function effectiveCustomModelRows(config, discoveredRows, { providerId } = {}) {
  const overrides = config?.modelOverrides || {};
  const newModelsHidden = config?.discovery?.newModelsHidden === true;
  const rows = [];
  const seen = new Set();
  for (const row of Array.isArray(discoveredRows) ? discoveredRows : []) {
    const id = typeof row?.id === 'string' ? row.id : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const override = Object.hasOwn(overrides, id) ? overrides[id] : undefined;
    rows.push(effectiveRow(row, override, { providerId, discovered: true, newModelsHidden }));
  }
  for (const [id, override] of Object.entries(overrides)) {
    if (!override?.manual || seen.has(id)) continue;
    seen.add(id);
    const base = { id, name: id, provider: providerId, contextWindow: 0, outputTokens: null };
    rows.push(effectiveRow(base, override, { providerId, discovered: false, newModelsHidden }));
  }
  return rows;
}
