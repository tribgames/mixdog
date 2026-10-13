import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonText, updateJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';

// An OpenAI-compatible endpoint that rejects the requested reasoning effort
// (HTTP 400 naming the value) is replayed once at the nearest accepted level,
// and the rejection is remembered per provider+model so the level stops being
// sent (clamped before the request) and stops being offered (the sync reader).

const EFFORT_ORDER = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const FILE_NAME = 'effort-rejections.json';
// Per-provider request fields that can carry the effort next to `opts.effort`.
const EFFORT_OPT_KEYS = ['xaiReasoningEffort', 'openRouterReasoningEffort', 'deepseekReasoningEffort'];
const LEVEL_RE = new RegExp(`\\b(${EFFORT_ORDER.join('|')})\\b`, 'gi');
const LIST_RE =
  /\b(?:supported|allowed|valid|accepted|available)\s+(?:values?|levels?|options?|efforts?)|(?:must|should|expected to) be one of|expected one of|one of|choose from|input should be/i;
const REJECT_RE =
  /invalid|unsupported|not supported|does not support|doesn't support|not allowed|not a valid|unrecognized|must be one of|expected one of|supported values/i;
// Anthropic's `invalid_request_error` words a bad enum value as "Input should be 'low', ...".
const ANTHROPIC_REJECT_RE = /input should be|should be one of|not one of/i;
const EFFORT_RE = /reasoning[._ ]?effort|\beffort\b/i;
const REASONING_RE = /\breasoning\b/i;
// A request field other than the effort: `reasoning.summary`, `reasoning_content`,
// `thinking.type`, `budget_tokens`, ...
const OTHER_FIELD_RE = /\breasoning[._[](?!effort)\w+|(?:^|[\s'"`(])(?:thinking\.\w+|budget_tokens)\b/i;
// The mid-conversation effort update rejection belongs to effort-configuration.mjs.
const EFFORT_CONFIGURATION_RE = /mid-conversation|configuration_update|reasoning_effort_update/i;
/** The effort levels the Anthropic Messages wire accepts (`output_config.effort`). */
export const ANTHROPIC_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

const cache = new Map();

const filePath = () => join(resolvePluginData(), FILE_NAME);
const entryKey = (provider, model) =>
  `${String(provider || '').trim()}:${String(model || '')
    .trim()
    .toLowerCase()}`;
const levelOf = (value) => {
  const level = String(value ?? '')
    .trim()
    .toLowerCase();
  return EFFORT_ORDER.includes(level) ? level : null;
};

// A rejection persisted by another process changes the file; the cached copy is
// only trusted while the file's mtime and size are unchanged.
function signature(file) {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function load(file) {
  const sig = signature(file);
  const cached = cache.get(file);
  if (cached && cached.sig === sig) return cached.data;
  let data = null;
  try {
    data = parseJsonText(readFileSync(file, 'utf8'));
  } catch {}
  const valid =
    data?.version === 1 && data.models && typeof data.models === 'object' ? data : { version: 1, models: {} };
  cache.set(file, { sig, data: valid });
  return valid;
}

function addRejection(data, key, level, allowed) {
  const models = { ...data.models };
  const prev = models[key] || {};
  const rejected = new Set(prev.rejected || []);
  if (level) rejected.add(level);
  const nextAllowed = allowed?.length ? allowed : prev.allowed;
  models[key] = { rejected: [...rejected], ...(nextAllowed?.length ? { allowed: nextAllowed } : {}) };
  return { version: 1, models };
}

function entry(provider, model) {
  return load(filePath()).models[entryKey(provider, model)] || null;
}

/** Levels this provider+model is known not to accept (rejected, or outside a
 *  list the endpoint named). Sync, for the runtime effort catalog. */
export function rejectedEffortLevelsSync(provider, model) {
  const found = entry(provider, model);
  const rejected = new Set(found?.rejected || []);
  if (found?.allowed?.length) for (const level of EFFORT_ORDER) if (!found.allowed.includes(level)) rejected.add(level);
  return rejected;
}

/** Remember a rejected level (and the allowed list the endpoint named, if any). */
export function recordEffortRejection(provider, model, level, allowed = null) {
  const file = filePath();
  const key = entryKey(provider, model);
  const normalized = levelOf(level);
  try {
    const data = updateJsonAtomicSync(
      file,
      (cur) =>
        addRejection(cur?.version === 1 && cur.models ? cur : { version: 1, models: {} }, key, normalized, allowed),
      { lock: true, timeoutMs: 1000 }
    );
    cache.set(file, { sig: signature(file), data });
  } catch {
    cache.set(file, { sig: signature(file), data: addRejection(load(file), key, normalized, allowed) });
  }
}

/** Forget what was loaded from disk (a process restart, for tests). */
export function resetEffortRejectionCache() {
  cache.clear();
}

const collect = (error) => {
  const nested = error?.error?.error && typeof error.error.error === 'object' ? error.error.error : null;
  return [error, error?.error, nested].filter((part) => part && typeof part === 'object');
};

const hasLevel = (text) => new RegExp(LEVEL_RE.source, 'i').test(text);

/**
 * A 400-class provider error that rejects the reasoning effort, as
 * `{ allowed }` (levels the message lists, or null), else null. It must be
 * effort-specific: the `param` names the effort field, or the message names the
 * effort field together with a level, or (given the `requested` level) the
 * message calls that level invalid while talking about reasoning. A rejection
 * of another reasoning field (`reasoning.summary`, `reasoning.include`) never matches.
 */
export function detectEffortRejection(error, requested = null) {
  const status = [error?.status, error?.httpStatus, error?.response?.status].map(Number).find((value) => value > 0);
  if (status !== 400 && status !== 422) return null;
  const parts = collect(error);
  const param = parts.map((part) => String(part.param ?? '')).join(' ');
  const text = parts
    .flatMap((part) => [part.message, part.code, part.param])
    .filter(Boolean)
    .join(' ');
  if (EFFORT_CONFIGURATION_RE.test(text)) return null;
  const anthropic = parts.some((part) => part.type === 'invalid_request_error') || /invalid_request_error/.test(text);
  if (!REJECT_RE.test(text) && !(anthropic && ANTHROPIC_REJECT_RE.test(text))) return null;
  const level = levelOf(requested);
  const targeted =
    /effort/i.test(param) ||
    (!OTHER_FIELD_RE.test(`${param} ${text}`) &&
      ((EFFORT_RE.test(text) && hasLevel(text)) ||
        (level && REASONING_RE.test(text) && new RegExp(`\\b${level}\\b`, 'i').test(text))));
  if (!targeted) return null;
  const list = LIST_RE.exec(text);
  const allowed = list
    ? [...new Set([...text.slice(list.index + list[0].length).matchAll(LEVEL_RE)].map((m) => m[1].toLowerCase()))]
    : [];
  return { allowed: allowed.length ? allowed : null };
}

/**
 * The nearest lower level not in `rejected`; with `allowHigher` (the accepted
 * set is known) the nearest higher one when nothing lower is left.
 */
export function nearestAcceptedEffort(requested, rejected = new Set(), { allowHigher = false } = {}) {
  const from = EFFORT_ORDER.indexOf(requested);
  if (from < 0) return null;
  const open = EFFORT_ORDER.filter((level, index) => index !== from && !rejected.has(level));
  const lower = open.filter((level) => EFFORT_ORDER.indexOf(level) < from).at(-1);
  return lower ?? (allowHigher ? (open[0] ?? null) : null);
}

const requestedEffort = (opts, configEffort) => levelOf(opts?.effort ?? configEffort);

function withEffort(opts, level) {
  const next = { ...opts, effort: level };
  for (const key of EFFORT_OPT_KEYS) if (opts?.[key] !== undefined) next[key] = level;
  return next;
}

// The rejected set seen by a transport that only takes `levels` of the ladder.
function rejectedWithin(provider, model, levels) {
  const rejected = rejectedEffortLevelsSync(provider, model);
  if (levels) for (const level of EFFORT_ORDER) if (!levels.includes(level)) rejected.add(level);
  return rejected;
}

/** `opts` with a level already known to be rejected stepped down; unchanged otherwise. */
export function clampEffortOpts(provider, model, opts, configEffort, levels = null) {
  const requested = requestedEffort(opts, configEffort);
  if (!requested || (levels && !levels.includes(requested))) return opts;
  const rejected = rejectedWithin(provider, model, levels);
  if (!rejected.has(requested)) return opts;
  const level = nearestAcceptedEffort(requested, rejected, { allowHigher: Boolean(entry(provider, model)?.allowed) });
  return level ? withEffort(opts, level) : opts;
}

const STREAM_CALLBACKS = ['onStreamDelta', 'onTextDelta', 'onToolCall'];

/**
 * Runs `send(opts)` with known-rejected levels clamped first; when the model
 * rejects the effort, remembers it and replays the request once at the nearest
 * accepted level. Never replays after output reached the caller, and never
 * replays the replay. `levels` limits the ladder to what the transport's wire
 * accepts. A send re-entered from inside a wrapped send (a transport's own
 * replays call `send` again) passes straight through: the outer wrapper owns it.
 */
export async function withEffortRejectionFallback(provider, model, opts, configEffort, send, { levels = null } = {}) {
  if (opts?._effortRejectionActive) return send(opts);
  let streamed = false;
  const tracked = { ...opts, _effortRejectionActive: true };
  for (const name of STREAM_CALLBACKS) {
    const callback = opts?.[name];
    if (typeof callback === 'function') {
      tracked[name] = (...args) => {
        streamed = true;
        return callback(...args);
      };
    }
  }
  const first = clampEffortOpts(provider, model, tracked, configEffort, levels);
  try {
    return await send(first);
  } catch (error) {
    const requested = requestedEffort(first, configEffort);
    const rejection = detectEffortRejection(error, requested);
    const emitted =
      streamed || error?.liveTextEmitted === true || error?.emittedToolCall === true || error?.unsafeToRetry === true;
    if (!rejection || !requested || (levels && !levels.includes(requested))) throw error;
    recordEffortRejection(provider, model, requested, rejection.allowed);
    if (emitted) throw error;
    const level = nearestAcceptedEffort(requested, rejectedWithin(provider, model, levels), {
      allowHigher: Boolean(entry(provider, model)?.allowed),
    });
    if (!level) throw error;
    process.stderr.write(
      `[${provider}] ${model} rejected reasoning effort '${requested}'; retrying once at '${level}'\n`
    );
    try {
      return await send(withEffort(first, level));
    } catch (retryError) {
      const again = detectEffortRejection(retryError, level);
      if (again) recordEffortRejection(provider, model, level, again.allowed);
      throw retryError;
    }
  }
}
