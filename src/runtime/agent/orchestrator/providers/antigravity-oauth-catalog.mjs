/**
 * Antigravity model catalog and quota.
 *
 * Cloud Code Assist publishes the account's models through
 * `fetchAvailableModels`: one wire id per thinking tier ("gemini-3.8-flash-high",
 * "-medium", "-low") labelled "Gemini 3.8 Flash (High)". Mixdog's picker shows
 * one model with an effort control, so the tiers of a family collapse into one
 * record whose `wire` map turns the chosen effort back into the wire id. The
 * list is cached on disk like the other OAuth catalogs; the curated list in the
 * tokens module is the offline fallback. Shared Gemini 5-hour/weekly usage
 * comes from `retrieveUserQuotaSummary`, not the per-model catalog counters.
 */
import { makeModelCache } from './model-cache.mjs';
import { isGeminiFamilyModel } from './gemini-family.mjs';
import { isAntigravityClaude } from './antigravity-request.mjs';
import { getModelMetadataSync } from '../../../shared/llm/model-catalog.mjs';
import {
  ANTIGRAVITY_MODELS,
  PROJECT_ENDPOINT,
  antigravityHeaders,
  _scrubTokens,
  withTimeoutSignal,
} from './antigravity-oauth-tokens.mjs';

const ANTIGRAVITY_MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const ANTIGRAVITY_MODEL_CACHE_VERSION = 1;
const FETCH_MODELS_TIMEOUT_MS = 15_000;
// Tier labels the gateway puts in parentheses, in effort order.
const TIER_EFFORTS = { 'extra low': 'minimal', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' };
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high'];
// IDE-internal completion/chat models are listed without a display name.
const INTERNAL_ID = /^(?:chat|tab)_/;
// The thinkingLevel values the gateway accepts on a single wire id; `minimal`
// is an error there, so it is never offered even when a catalog lists it.
const GATEWAY_THINKING_LEVELS = Object.freeze(['low', 'medium', 'high']);

let _mirror = null;
export const antigravityModelCache = makeModelCache({
  fileName: 'antigravity-oauth-models.json',
  ttlMs: ANTIGRAVITY_MODEL_CACHE_TTL_MS,
  version: ANTIGRAVITY_MODEL_CACHE_VERSION,
  onSave: (models) => {
    _mirror = models;
  },
});

async function postInternalJson(methodName, { accessToken, projectId, fetchFn = fetch, signal = null }) {
  const res = await fetchFn(`${PROJECT_ENDPOINT}/v1internal:${methodName}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...antigravityHeaders(),
    },
    body: JSON.stringify(projectId ? { project: projectId } : {}),
    redirect: 'error',
    signal: withTimeoutSignal(signal, FETCH_MODELS_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[antigravity-oauth] ${methodName} failed: ${res.status} ${_scrubTokens(text).slice(0, 300)}`);
  }
  return res.json();
}

export async function fetchAvailableModels(opts) {
  const json = await postInternalJson('fetchAvailableModels', opts);
  const models = json?.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    throw new Error('[antigravity-oauth] fetchAvailableModels returned no models');
  }
  return models;
}

/** Grouped 5-hour/weekly counters from the same daily host as the catalog. */
export async function fetchUserQuotaSummary(opts) {
  return postInternalJson('retrieveUserQuotaSummary', opts);
}

function splitDisplay(displayName) {
  const text = String(displayName || '').trim();
  const match = text.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  const effort = match ? TIER_EFFORTS[match[2].trim().toLowerCase()] : undefined;
  return effort ? { base: match[1].trim(), effort } : { base: text, effort: null };
}

function familyId(base) {
  return base
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function familyKind(base) {
  const text = base.toLowerCase();
  if (/claude/.test(text)) return null;
  if (/gemini/.test(text)) return /flash/.test(text) ? 'gemini-flash' : 'gemini-pro';
  if (/gpt/.test(text)) return 'gpt-oss';
  return null;
}

// Several wire ids can share one label ("Gemini 3.5 Flash Lite" is served by
// four ids): keep the one whose id carries the labelled version, then the
// shortest, so the choice is stable across responses.
function pickWire(candidates, base) {
  const version = base.match(/\d+(?:\.\d+)?/)?.[0];
  const rank = (id) => (version && id.includes(version) ? 0 : 1);
  return [...candidates].sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b))[0];
}

function chatEntries(rawModels) {
  const out = [];
  for (const [wireId, entry] of Object.entries(rawModels || {})) {
    if (!entry || typeof entry !== 'object' || INTERNAL_ID.test(wireId)) continue;
    const displayName = String(entry.displayName || '').trim();
    const contextWindow = Number(entry.maxTokens) || 0;
    if (!displayName || contextWindow <= 0) continue;
    out.push({ wireId, entry, displayName, contextWindow });
  }
  return out;
}

// A Gemini wire id without tier siblings takes the ordinary thinkingLevel field.
// The ladder comes from the catalogs' row for the same Gemini id (models.dev /
// LiteLLM) narrows what the gateway accepts; when no catalog declares a ladder
// the gateway-accepted levels are offered and the server judges the value.
// Only a model the gateway does not flag as thinking-capable has no levels.
function bareThinkingLevels(wire, supportsReasoning) {
  if (!supportsReasoning) return [];
  // Claude behind the gateway takes the same thinkingLevel enum; no catalog
  // describes these wire ids, so the gateway-accepted levels are offered.
  if (isAntigravityClaude(wire)) return [...GATEWAY_THINKING_LEVELS];
  if (!isGeminiFamilyModel(wire)) return [];
  const effort = getModelMetadataSync(wire, 'gemini')?.reasoningOptions?.find((option) => option?.type === 'effort');
  if (!Array.isArray(effort?.values) || !effort.values.length) return [...GATEWAY_THINKING_LEVELS];
  const declared = new Set(effort.values.map((value) => String(value).toLowerCase()));
  return GATEWAY_THINKING_LEVELS.filter((level) => declared.has(level));
}

/** Collapse the gateway's per-tier wire ids into picker records. */
export function normalizeAntigravityCatalog(rawModels) {
  const families = new Map();
  for (const { wireId, entry, displayName, contextWindow } of chatEntries(rawModels)) {
    const { base, effort } = splitDisplay(displayName);
    const key = familyId(base);
    let family = families.get(key);
    if (!family) {
      family = { base, contextWindow: 0, supportsVision: false, supportsReasoning: false, wires: new Map() };
      families.set(key, family);
    }
    family.contextWindow = Math.max(family.contextWindow, contextWindow);
    family.supportsVision ||= entry.supportsImages === true;
    family.supportsReasoning ||= entry.supportsThinking === true;
    const slot = effort || '';
    if (!family.wires.has(slot)) family.wires.set(slot, []);
    family.wires.get(slot).push(wireId);
  }
  const models = [];
  for (const [key, family] of families) {
    const efforts = EFFORT_ORDER.filter((effort) => family.wires.has(effort));
    const tiered = efforts.length > 1;
    const wire = tiered
      ? Object.fromEntries(efforts.map((effort) => [effort, pickWire(family.wires.get(effort), family.base)]))
      : pickWire(family.wires.get(efforts[0] ?? ''), family.base);
    const id = tiered ? key : wire;
    const display =
      tiered || !efforts.length ? family.base : `${family.base} (${efforts[0][0].toUpperCase()}${efforts[0].slice(1)})`;
    const kind = familyKind(family.base);
    // A lone labelled tier already names its effort in the wire id.
    let reasoningLevels = efforts;
    if (!efforts.length) reasoningLevels = bareThinkingLevels(wire, family.supportsReasoning);
    else if (!tiered) reasoningLevels = [];
    models.push({
      id,
      name: display,
      display,
      provider: 'antigravity-oauth',
      ...(kind ? { family: kind } : {}),
      contextWindow: family.contextWindow,
      supportsVision: family.supportsVision,
      supportsReasoning: family.supportsReasoning,
      supportsFunctionCalling: true,
      reasoningLevels,
      wire,
    });
  }
  return models.sort((a, b) => a.display.localeCompare(b.display));
}

/**
 * Catalog to resolve wire ids against: in-memory mirror, disk cache, then the
 * curated fallback. Sends never refresh the catalog, so the account's last live
 * list is used even past its TTL: it names the wire ids this account was
 * offered, which the curated list can only approximate.
 */
function antigravityCatalogModels() {
  if (!_mirror) _mirror = antigravityModelCache.loadSync({ allowStale: true });
  return _mirror || ANTIGRAVITY_MODELS;
}

/**
 * The catalog `family` ('gemini-pro', 'gemini-flash', 'gpt-oss') of a picker
 * id or one of its wire ids, or null when no record carries one (Claude, or
 * an id the catalog does not list).
 */
export function antigravityModelFamily(model, models = antigravityCatalogModels()) {
  const id = String(model || '');
  const wires = (entry) => (entry?.wire && typeof entry.wire === 'object' ? Object.values(entry.wire) : [entry?.wire]);
  const record = models.find((entry) => entry?.id === id) || models.find((entry) => wires(entry).includes(id));
  return typeof record?.family === 'string' && record.family ? record.family : null;
}

/**
 * Turn a picker model + effort into the wire id the gateway accepts. Tiered
 * families consume the effort (the id encodes it); a bare id whose record
 * lists levels keeps it for thinkingLevel; every other record drops it
 * because the gateway does not flag the model as thinking-capable. Unknown ids pass through unchanged.
 */
export function resolveAntigravityWireModel(model, effort, models = antigravityCatalogModels()) {
  const id = String(model || '');
  const record = models.find((entry) => entry?.id === id);
  if (!record) return { model: id, effort };
  if (record.wire && typeof record.wire === 'object') {
    const levels = Object.keys(record.wire);
    const wanted = String(effort || '').toLowerCase();
    let level = levels[levels.length - 1];
    if (levels.includes(wanted)) level = wanted;
    else if (levels.includes('high')) level = 'high';
    return { model: record.wire[level], effort: null };
  }
  const wire = typeof record.wire === 'string' && record.wire ? record.wire : id;
  return { model: wire, effort: record.reasoningLevels?.length ? effort : null };
}

function quotaRow(label, bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  if (typeof bucket.remainingFraction !== 'number' || !Number.isFinite(bucket.remainingFraction)) return null;
  const usedPct = Math.round(Math.max(0, Math.min(100, (1 - bucket.remainingFraction) * 100)) * 100) / 100;
  const resetAt = Date.parse(String(bucket.resetTime || ''));
  return {
    label,
    usedPct,
    ...(Number.isFinite(resetAt) && resetAt > 0 ? { resetAt } : {}),
    source: 'antigravity-quota-summary',
  };
}

// The gateway's bucket ids; group names are display text and may change.
const GEMINI_5H_BUCKET_ID = 'gemini-5h';
const GEMINI_WEEKLY_BUCKET_ID = 'gemini-weekly';
const ARGON_WEEKLY_BUCKET_ID = 'gemini-argon-wtu-weekly';
// The "Claude and GPT models" group (Claude Opus, Claude Sonnet, GPT-OSS) has
// its own pair of buckets, separate from the Gemini counters.
const THIRD_PARTY_5H_BUCKET_ID = '3p-5h';
const THIRD_PARTY_WEEKLY_BUCKET_ID = '3p-weekly';

/**
 * Gemini 5H/7D rows from retrieveUserQuotaSummary, the separate weekly limit
 * of the Gemini 4 Argon group (its own group with only a weekly bucket), and
 * the Claude/GPT-OSS 5H/7D pair. Rows are selected by bucket id and window.
 * Missing fields stay omitted.
 */
export function antigravityQuotaWindows(summary) {
  const groups = (Array.isArray(summary?.groups) ? summary.groups : []).filter(
    (entry) => entry && typeof entry === 'object'
  );
  const buckets = groups.flatMap((entry) => (Array.isArray(entry.buckets) ? entry.buckets : []));
  const bucket = (id, window) =>
    buckets.find((entry) => entry && typeof entry === 'object' && entry.bucketId === id && entry.window === window) ??
    null;
  return [
    quotaRow('5H', bucket(GEMINI_5H_BUCKET_ID, '5h')),
    quotaRow('7D', bucket(GEMINI_WEEKLY_BUCKET_ID, 'weekly')),
    quotaRow('7D Argon', bucket(ARGON_WEEKLY_BUCKET_ID, 'weekly')),
    quotaRow('5H Claude/GPT', bucket(THIRD_PARTY_5H_BUCKET_ID, '5h')),
    quotaRow('7D Claude/GPT', bucket(THIRD_PARTY_WEEKLY_BUCKET_ID, 'weekly')),
  ].filter(Boolean);
}
