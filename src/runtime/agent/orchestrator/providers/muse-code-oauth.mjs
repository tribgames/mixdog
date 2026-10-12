/**
 * Muse Code subscription provider (Meta Muse Spark models).
 *
 * Inference authenticates with the subscription-minted Model API key (never
 * the Meta account token) against https://api.meta.ai/v1 over the Responses
 * wire, delegated to the shared OpenAI-compatible transport. The key never
 * expires and cannot be refreshed: a 401 means the user must sign in again.
 */
import { createHash } from 'node:crypto';
import { SEEDS, seedRow, SPARK_MAX_OUTPUT } from '../../../shared/llm/muse-models.mjs';
import { noteErrorUsage } from './lib/note-error-usage.mjs';
import { fileMtimeMs } from './lib/oauth-token-utils.mjs';
import { OpenAICompatProvider, preloadOpenAICompatRuntime } from './openai-compat.mjs';
import {
  API_VERSION,
  MODEL_API_BASE_URL,
  getOwnTokenPath,
  loadTokens,
  requestMuseCodeKey,
  scrubMuseSecrets,
} from './muse-code-oauth-tokens.mjs';

export {
  hasMuseCodeOAuthCredentials,
  describeMuseCodeOAuthCredentials,
  forgetMuseCodeOAuthCredentials,
} from './muse-code-oauth-tokens.mjs';
export { beginOAuthLogin, loginOAuth } from './muse-code-oauth-login.mjs';

export const DEFAULT_MODEL = 'muse-spark-1.3';
const FIVE_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh']);
const effortOptions = (levels) => [{ type: 'effort', values: [...levels] }];
// Image and voice generation ids are served by the same catalog but are not chat models.
const NON_CHAT_MODEL_RE = /^muse-(image|voice)-/i;
const SEED_MODELS = Object.freeze(Object.keys(SEEDS));

// Revisioned Spark ids the seed does not list inherit the newest seeded
// revision of their tier (limits, vision, pricing) but take the five-level
// ladder: only reviewed seeds advertise `max`.
const SPARK_ID_RE = /^muse-spark-(\d+)\.(\d+)(?:\.(\d+))?(-contributor)?$/i;

function revisionOf(id) {
  const m = SPARK_ID_RE.exec(id);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

function compareRevision(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function lineageRow(id) {
  if (SEEDS[id]) return null;
  const match = SPARK_ID_RE.exec(id);
  if (!match) return null;
  const contributor = Boolean(match[4]);
  let template = null;
  let templateRevision = null;
  for (const seedId of SEED_MODELS) {
    if (SPARK_ID_RE.exec(seedId)[4] ? !contributor : contributor) continue;
    const candidate = revisionOf(seedId);
    if (!templateRevision || compareRevision(candidate, templateRevision) > 0) {
      template = seedId;
      templateRevision = candidate;
    }
  }
  if (!template) return null;
  const revision =
    match[3] && Number(match[3]) !== 0 ? `${match[1]}.${match[2]}.${match[3]}` : `${match[1]}.${match[2]}`;
  return {
    ...seedRow(template),
    id,
    name: `Muse Spark ${revision}${contributor ? ' (C)' : ''}`,
    reasoningLevels: [...FIVE_LEVELS],
    reasoningOptions: effortOptions(FIVE_LEVELS),
  };
}

// Seeds win for the ids they cover; lineage rows yield to discovered metadata.
// Preserve the contributor marker unless discovery supplies a different name.
const tierAgnosticKey = (text) =>
  String(text || '')
    .replace(/\s+\(c\)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

function museRow(id, discovered) {
  const discoveredName =
    typeof discovered?.name === 'string' && discovered.name && discovered.name !== id ? discovered.name : '';
  if (SEEDS[id]) {
    const seed = seedRow(id);
    const base = { ...(discovered || {}), ...seed, id };
    if (tierAgnosticKey(seed.name) === tierAgnosticKey(discoveredName)) return base;
    return { ...base, ...(discoveredName ? { name: discoveredName } : {}) };
  }
  const lineage = lineageRow(id);
  const row = {
    id,
    name: id,
    provider: 'muse-code-oauth',
    family: 'muse-spark',
    ...(lineage || {}),
    ...(discovered || {}),
  };
  if (discoveredName) row.name = discoveredName;
  else if (lineage) row.name = lineage.name;
  if (!row.reasoningOptions?.length) {
    row.reasoningOptions = effortOptions(FIVE_LEVELS);
    row.reasoningLevels = [...FIVE_LEVELS];
  }
  return row;
}

const EFFORT_DOWNGRADE = { max: 'xhigh' };
const SUMMARY_MODES = new Set(['auto', 'detailed', 'concise']);

// Cache identities beyond the wire limit become a bounded hash identity.
function normalizeCacheKey(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const wellFormed = text.toWellFormed();
  if (wellFormed.length <= 64) return wellFormed;
  return `pc_${createHash('sha256').update(wellFormed).digest('hex').slice(0, 32)}`;
}

// Final request shaping on the Responses wire (installed through the shared
// transport's opt-in params hook).
function shapeResponsesParams(params, { opts, modelInfo }, config = {}) {
  delete params.parallel_tool_calls;
  const modelMax = Number(modelInfo?.outputTokens) > 0 ? Number(modelInfo.outputTokens) : SPARK_MAX_OUTPUT;
  if (params.max_output_tokens) params.max_output_tokens = Math.min(params.max_output_tokens, modelMax);

  delete params.reasoning;
  const requested = String(opts.effort ?? config.reasoningEffort ?? '')
    .trim()
    .toLowerCase();
  const allowed = modelInfo?.reasoningOptions?.find((o) => o?.type === 'effort')?.values || FIVE_LEVELS;
  const forcedOff = opts.forceReasoningOff === true || requested === 'none' || requested === 'off';
  if (forcedOff) {
    // Explicit off: the only disable level the wire defines, with no encrypted replay.
    params.reasoning = { effort: 'none' };
  } else {
    if (opts.disableReasoning === true) {
      // Disabling without a request selects the model's lowest supported effort.
      if (!requested && allowed.length) params.reasoning = { effort: allowed[0] };
    } else if (requested || opts.reasoningSummary !== undefined) {
      // A summary request alone still engages reasoning at the default effort.
      const wanted = requested || 'medium';
      const effort = allowed.includes(wanted) ? wanted : EFFORT_DOWNGRADE[wanted];
      if (effort && allowed.includes(effort)) {
        params.reasoning = { effort };
        const summary = opts.reasoningSummary === undefined ? 'auto' : opts.reasoningSummary;
        if (summary !== null) params.reasoning.summary = SUMMARY_MODES.has(summary) ? summary : 'auto';
      }
    }
  }

  // Caller includes survive (copied, deduped); encrypted reasoning is added
  // only when reasoning is not forced off and the model and caller allow it.
  const include = Array.isArray(opts.include) ? opts.include.filter((v) => typeof v === 'string' && v) : [];
  if (!forcedOff && modelInfo?.supportsReasoning !== false && opts.includeEncryptedReasoning !== false) {
    include.push('reasoning.encrypted_content');
  }
  if (include.length) params.include = [...new Set(include)];
  else delete params.include;

  for (const [field, value] of [
    ['temperature', opts.temperature],
    ['top_p', opts.topP ?? opts.top_p],
    ['top_k', opts.topK ?? opts.top_k],
    ['min_p', opts.minP ?? opts.min_p],
    ['presence_penalty', opts.presencePenalty ?? opts.presence_penalty],
    ['repetition_penalty', opts.repetitionPenalty ?? opts.repetition_penalty],
  ]) {
    if (typeof value === 'number' && Number.isFinite(value)) params[field] = value;
  }

  if (opts.cacheRetention !== 'none') {
    const key = normalizeCacheKey(opts.promptCacheKey ?? opts.sessionId);
    if (key) params.prompt_cache_key = key;
  }

  if (opts.extraBody && typeof opts.extraBody === 'object' && !Array.isArray(opts.extraBody)) {
    Object.assign(params, opts.extraBody);
  }
}

function resetAtMs(value) {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function usageStatus(usedFraction) {
  if (usedFraction >= 1) return 'exhausted';
  if (usedFraction >= 0.9) return 'warning';
  return 'ok';
}

function usageWindow({ id, label, longLabel, durationMs }, entry, tier) {
  const used = entry?.used_percent;
  if (!entry || typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  const resetAt = resetAtMs(entry.resets_at);
  const usedPct = Math.min(100, used);
  const usedFraction = usedPct / 100;
  return {
    id,
    label,
    longLabel,
    source: 'muse-code-key',
    usedPct: Math.round(usedPct * 100) / 100,
    usedFraction,
    remainingFraction: 1 - usedFraction,
    status: usageStatus(usedFraction),
    ...(durationMs ? { durationMs } : {}),
    ...(tier ? { tier } : {}),
    ...(resetAt ? { resetAt } : {}),
  };
}

function rollingWindowSpec(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return { id: 'rolling', label: 'W', longLabel: 'Rolling Window' };
  const rounded = Math.round(m);
  const hours = rounded / 60;
  const whole = rounded % 60 === 0;
  const count = whole ? hours : rounded;
  const unit = whole ? 'Hour' : 'Minute';
  return {
    id: `${rounded}m`,
    label: whole ? `${hours}H` : `${rounded}M`,
    longLabel: `${count} ${count === 1 ? unit : `${unit}s`}`,
    durationMs: m * 60_000,
  };
}

/** Map the key endpoint's `subs_usage` onto the shared quota-window shape. */
export function quotaWindowsFromSubsUsage(subsUsage, tier) {
  const windows = [];
  const rolling = usageWindow(rollingWindowSpec(subsUsage?.window?.window_duration_mins), subsUsage?.window, tier);
  if (rolling) windows.push(rolling);
  const weekly = usageWindow(
    { id: '1w', label: '7D', longLabel: 'Weekly', durationMs: WEEK_MS },
    subsUsage?.weekly,
    tier
  );
  if (weekly) windows.push(weekly);
  return windows;
}

function reauthError(detail, status = 401) {
  return Object.assign(new Error(`[muse-code-oauth] ${detail} — open /providers in mixdog to sign in again`), {
    reauthRequired: true,
    status,
  });
}

const USAGE_FAILURE_BACKOFF_MS = 5 * 60_000;

// Scrub the key from errors where the transport first surfaces them, so the
// shared retry reporter (which logs the original error) never sees it.
// Exact known secret values only: normal stream output must pass through unchanged.
function replaceExact(text, secrets) {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('[REDACTED]');
  return out;
}

// `exact` true replaces only the known secret values; false additionally applies
// the generic field-pattern redaction (error objects and messages).
function scrubDeep(value, secrets, exact, seen = new WeakSet()) {
  if (typeof value === 'string') return exact ? replaceExact(value, secrets) : scrubMuseSecrets(value, secrets);
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (value instanceof Error && typeof value.message === 'string') {
    value.message = scrubMuseSecrets(value.message, secrets);
  }
  for (const k of Object.keys(value)) {
    try {
      value[k] = scrubDeep(value[k], secrets, exact, seen);
    } catch {
      /* read-only field */
    }
  }
  return value;
}

function redactClientErrors(client, apiKey, accessToken) {
  const responses = client?.responses;
  const secrets = [apiKey, accessToken].filter(Boolean);
  const marker = secrets.join('|');
  if (!responses || responses.create?.museRedacting === marker) return;
  const create = responses.create.bind(responses);
  const redact = (err) => scrubDeep(err, secrets, false);
  const wrapped = async (...args) => {
    try {
      const stream = await create(...args);
      if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
        const iterate = stream[Symbol.asyncIterator].bind(stream);
        stream[Symbol.asyncIterator] = () => {
          const it = iterate();
          return {
            next: async (...a) => {
              try {
                const step = await it.next(...a);
                // Any event payload can become an exception downstream; scrub every
                // string field at the source rather than by event name.
                if (step && !step.done) scrubDeep(step.value, secrets, true);
                return step;
              } catch (err) {
                throw redact(err);
              }
            },
            return: (...a) => it.return?.(...a),
          };
        };
      }
      return stream;
    } catch (err) {
      throw redact(err);
    }
  };
  wrapped.museRedacting = marker;
  responses.create = wrapped;
}

export class MuseCodeOAuthProvider {
  // No document block on this wire: a PDF is lowered to text before the request is built.
  nativePdf = false;
  static inputExcludesCache = false;
  name = 'muse-code-oauth';
  config;
  tokens = null;
  _inner = null;
  _innerKey = null;
  _lastDiskScan = 0;
  _usageFailure = null;
  _usageLastGood = null;

  _clearUsageState() {
    this._usageFailure = null;
    this._usageLastGood = null;
  }

  constructor(config) {
    this.config = config || {};
    this.tokens = loadTokens();
    try {
      preloadOpenAICompatRuntime();
    } catch {
      /* authoritative send surfaces load failures */
    }
  }

  // The stored key is the whole credential; pick up a newer login from disk
  // but never mint or refresh anything here.
  async ensureAuth() {
    const modified = fileMtimeMs(getOwnTokenPath());
    if (modified === 0) {
      // A missing credential file is signed out, whatever was cached.
      if (this.tokens) this._clearUsageState();
      this.tokens = null;
      this._lastDiskScan = 0;
    } else if (!this.tokens || modified !== this._lastDiskScan) {
      this.tokens = loadTokens();
      this._lastDiskScan = modified;
    }
    if (!this.tokens?.apiKey) {
      throw new Error('[muse-code-oauth] credentials not found — open /providers in mixdog to sign in first');
    }
    return this.tokens;
  }

  _ensureInner(apiKey) {
    if (this._inner && this._innerKey === apiKey) return this._inner;
    this._inner = new OpenAICompatProvider('muse-code-oauth', {
      ...this.config,
      apiKey,
      baseURL: MODEL_API_BASE_URL,
      // JSON accept for discovery; streaming requests override it per call.
      extraHeaders: { Accept: 'application/json', 'x-api-version': API_VERSION },
      // Never inherit OPENAI_ORG_ID / OPENAI_PROJECT_ID from the environment.
      clientOptions: { organization: null, project: null },
      responsesSystemAsInstructions: true,
      responsesParamsHook: (params, ctx) => shapeResponsesParams(params, ctx, this.config),
    });
    this._innerKey = apiKey;
    // The Responses builder reads limits and the effort ladder from the inner
    // provider's cached model row; seeds fill in what discovery omits.
    const innerRow = this._inner.getCachedModelInfo.bind(this._inner);
    this._inner.getCachedModelInfo = (model) => {
      const discovered = innerRow(model);
      return discovered || SEEDS[model] || lineageRow(model) ? museRow(model, discovered) : null;
    };
    return this._inner;
  }

  async send(messages, model, tools, sendOpts) {
    const { apiKey, accessToken } = await this.ensureAuth();
    const inner = this._ensureInner(apiKey);
    redactClientErrors(inner.client, apiKey, accessToken);
    // The endpoint accepts only tool_choice "auto"; the field is omitted entirely.
    const { toolChoice: _unsupported, ...opts } = sendOpts || {};
    try {
      // _doSend bypasses the compat 401 handler, which re-reads a static config key.
      return await inner._doSend(messages, model || DEFAULT_MODEL, tools, {
        ...opts,
        compatWireApi: 'responses',
        requestHeaders: { Accept: 'text/event-stream', ...(opts.requestHeaders || {}) },
      });
    } catch (err) {
      noteErrorUsage(err);
      if (Number(err?.httpStatus || err?.status) === 401) {
        const detail = scrubMuseSecrets(String(err?.message || ''), [apiKey])
          .trim()
          .slice(0, 300);
        throw reauthError(`Model API key rejected${detail ? ` (${detail})` : ''}`);
      }
      if (err && typeof err.message === 'string') err.message = scrubMuseSecrets(err.message, [apiKey]);
      throw err;
    }
  }

  async listModels() {
    const { apiKey } = await this.ensureAuth();
    const inner = this._ensureInner(apiKey);
    let items;
    try {
      items = await inner._fetchModelItems();
    } catch {
      // Discovery failed: fall back to the seeded roster.
      return SEED_MODELS.map((id) => museRow(id));
    }
    // A successful roster is authoritative, even when it holds no chat models.
    const rows = (Array.isArray(items) ? items : [])
      .filter((m) => typeof m?.id === 'string' && m.id && !NON_CHAT_MODEL_RE.test(m.id))
      .map((m) => {
        const contextWindow = Number(m.context_window ?? m.max_context_window ?? m.context_length ?? 0);
        const outputTokens = Number(m.max_output_tokens ?? m.output_tokens ?? 0);
        const name = [m.name, m.display_name].find((v) => typeof v === 'string' && v.trim());
        return museRow(m.id, {
          ...(name ? { name: name.trim() } : {}),
          ...(contextWindow > 0 ? { contextWindow } : {}),
          ...(outputTokens > 0 ? { outputTokens } : {}),
          ...(typeof m.created === 'number' ? { created: m.created } : {}),
        });
      });
    inner._enrichedModels = rows;
    return rows;
  }

  getCachedModelInfo(model) {
    return this._inner?.getCachedModelInfo?.(model) || (SEEDS[model] || lineageRow(model) ? museRow(model) : null);
  }

  /** Subscription window/weekly usage, read from the key endpoint without onboarding. */
  async getUsageSnapshot() {
    const { accessToken, accountId, email: storedEmail } = await this.ensureAuth();
    if (!accessToken) return null;
    // State is bound to the credential: a replaced login never sees another account's cooldown.
    const identity = `${accountId || ''}:${createHash('sha256').update(accessToken).digest('hex').slice(0, 16)}`;
    if (this._usageFailure && this._usageFailure.identity !== identity) this._clearUsageState();
    if (this._usageLastGood && this._usageLastGood.identity !== identity) this._usageLastGood = null;
    const lastGood = () => this._usageLastGood?.snapshot ?? null;
    // A recent failure suppresses re-querying the rate-limited endpoint.
    if (this._usageFailure && Date.now() < this._usageFailure.until) {
      if (this._usageFailure.error) throw this._usageFailure.error;
      return lastGood();
    }
    const fail = (error) => {
      // ±25% jitter keeps accounts from retrying in lockstep.
      const cooldown = USAGE_FAILURE_BACKOFF_MS * (1 + (Math.random() * 0.5 - 0.25));
      this._usageFailure = { identity, until: Date.now() + cooldown, error };
      // A rejected credential must not keep showing stale quota.
      if (error) this._usageLastGood = null;
      return error;
    };
    let payload;
    try {
      payload = await requestMuseCodeKey(accessToken);
    } catch (err) {
      if (err?.status === 401 || err?.status === 403) {
        throw fail(reauthError(`account session rejected (${err.status})`, err.status));
      }
      fail(null);
      return lastGood();
    }
    if (payload.is_subs_active === false) throw fail(reauthError('Muse Code subscription is inactive', 403));
    this._usageFailure = null;
    const tier = payload.subs_tier_name?.trim() || payload.subs_tier_id?.trim() || undefined;
    const quotaWindows = quotaWindowsFromSubsUsage(payload.subs_usage, tier);
    if (!quotaWindows.length) return null;
    const email = payload.user_email?.trim().toLowerCase() || storedEmail || undefined;
    const { api_key: _apiKey, ...raw } = payload;
    const snapshot = {
      provider: 'muse-code-oauth',
      model: null,
      source: 'muse-code-key',
      fetchedAt: Date.now(),
      quotaWindows,
      ...(tier ? { tier } : {}),
      ...(email ? { email } : {}),
      accountId: payload.user_id?.trim() || accountId || email || undefined,
      raw,
      rawKeys: Object.keys(raw).sort(),
    };
    this._usageLastGood = { identity, snapshot };
    return snapshot;
  }

  async isAvailable() {
    return Boolean(this.tokens?.apiKey || loadTokens()?.apiKey);
  }
}
