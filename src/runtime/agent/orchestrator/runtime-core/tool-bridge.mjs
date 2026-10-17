// Fixed tool bridge for sessions whose toolExposureMode is 'bridge-v1'
// (non-native providers, see tool-exposure.mjs): the shared load_tool
// describes tools by name (never loads them), and call_tool runs one target
// through the ordinary execution pipeline (the loop projects it into a call
// of the target itself, see session/loop/tool-call-resolution.mjs). The
// deferred roster names what exists. Discovery and description never grant
// execution permission; continuation tokens only carry a position and grant
// no authority.
import { createHash } from 'node:crypto';
import { BRIDGE_NAME_MAX_CHARS, isBridgeMetaTool } from './tool-bridge-contract.mjs';
import { clean } from './session-text.mjs';
import { isDeferredToolAvailable } from './deferred-tool-availability.mjs';
import {
  deferredCatalogUnion,
  filterSessionToolPolicy,
  isReadonlySelectable,
  toolSearchMatches,
} from './tool-catalog.mjs';
import { parseToolSelection, sortedCatalogByMeasuredUsage } from './tool-catalog-schema.mjs';
import { DEFERRED_SELECT_ALIASES } from './tool-catalog-data.mjs';
import { estimateTokens } from '../session/token-estimate.mjs';
import { preDispatchDenyForSession } from '../session/loop/pre-dispatch-deny.mjs';
import { resolveDeferredSelectMode } from '../session/loop/deferred-call-through.mjs';
import { providerToolExclusionReason, routeToolExclusionReason } from '../session/loop/provider-tool-exclusions.mjs';

export { isToolBridgeEnabled } from './tool-exposure.mjs';

export const BRIDGE_LOAD_TOOL_NAME = 'load_tool';
export const BRIDGE_CALL_TOOL_NAME = 'call_tool';
const DESCRIBE_MAX_NAMES = 8;
// Most definitions one request resolves to: every name an alias of the widest
// alias. A token naming more was not issued by this tool.
const MAX_ALIAS_MEMBERS = Math.max(1, ...Object.values(DEFERRED_SELECT_ALIASES).map((members) => members.length));

export const BRIDGE_LIMITS = Object.freeze({
  nameMaxChars: BRIDGE_NAME_MAX_CHARS,
  continuationMaxChars: 4096,
  continuationMaxTargets: DESCRIBE_MAX_NAMES * MAX_ALIAS_MEMBERS,
  describeMaxNames: DESCRIBE_MAX_NAMES,
  describeMaxBytes: 16 * 1024,
  describeMaxTokens: 4096,
});

// A continuation token travels in load_tool's own `names` field. Provider tool
// names never contain '@' or ':', so the prefix cannot name a tool.
export const BRIDGE_CONTINUATION_PREFIX = '@continue:';

const DESCRIBE_KEYS = new Set(['names']);
// What a bridge describe result tells the model to do with the definitions.
const DESCRIBE_NOTE =
  'Run a deferred tool with call_tool {name, arguments}; call directly defined tools directly. When continueWith is set, call load_tool again with exactly those arguments for the rest.';

export function bridgeError(code, message) {
  return { error: { code, message } };
}

export function bridgeErrorText(code, message) {
  return `Error: ${code}: ${message}`;
}

/** Model-visible text for a bridge result object. */
export function formatBridgeResult(result) {
  if (result?.error) return bridgeErrorText(result.error.code, result.error.message);
  return JSON.stringify(result);
}

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const hashText = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

function unknownKeysError(args, allowed, toolName) {
  if (!isPlainObject(args)) return bridgeError('INVALID_ARGUMENTS', `${toolName} requires an arguments object.`);
  const extra = Object.keys(args).filter((key) => !allowed.has(key));
  if (!extra.length) return null;
  return bridgeError('INVALID_ARGUMENTS', `${toolName} does not accept: ${extra.join(', ')}.`);
}

function fitsBudget(value, maxBytes, maxTokens) {
  const text = JSON.stringify(value);
  return Buffer.byteLength(text, 'utf8') <= maxBytes && estimateTokens(text) <= maxTokens;
}

// ---------------------------------------------------------------------------
// Continuation tokens: prefix + base64url JSON of the definitions still being
// paged (their indexes in the session's own available-tool list), their
// schema revision and the offset into the first of them. Requested, missing
// and blocked names never travel, so a token stays far below the decoder
// bound whatever names the request carried.

function encodeContinuation(indexes, revision, offset) {
  const payload = Buffer.from(JSON.stringify({ v: 2, t: indexes, r: revision, o: offset }), 'utf8');
  return `${BRIDGE_CONTINUATION_PREFIX}${payload.toString('base64url')}`;
}

// Longest token a page over `count` definitions of `available` tools can emit,
// used to reserve room while filling it.
const reserveContinuation = (count, available) =>
  encodeContinuation(Array(count).fill(available), 'f'.repeat(16), 99_999_999);

const invalidContinuation = () =>
  bridgeError('INVALID_CONTINUATION', 'names holds a continuation token this tool did not return.');

// The token's payload, or an error; the revision is checked once the names resolve.
function decodeContinuation(token) {
  if (token.length > BRIDGE_LIMITS.continuationMaxChars) return invalidContinuation();
  let payload = null;
  try {
    const body = token.slice(BRIDGE_CONTINUATION_PREFIX.length);
    const bytes = Buffer.from(body, 'base64url');
    // Only the canonical encoding this tool emits is accepted.
    if (bytes.toString('base64url') !== body) return invalidContinuation();
    payload = JSON.parse(bytes.toString('utf8'));
  } catch {
    payload = null;
  }
  const indexes = payload?.t;
  if (
    payload?.v !== 2 ||
    typeof payload.r !== 'string' ||
    !isIndex(payload.o) ||
    !Array.isArray(indexes) ||
    !indexes.length ||
    indexes.length > BRIDGE_LIMITS.continuationMaxTargets ||
    !indexes.every(isIndex) ||
    new Set(indexes).size !== indexes.length
  ) {
    return invalidContinuation();
  }
  return { indexes, revision: payload.r, offset: payload.o };
}

// A whole names value that is exactly one token: no padding, separators or other text.
const CONTINUATION_TOKEN_PATTERN = new RegExp(`^\\s*${BRIDGE_CONTINUATION_PREFIX}[A-Za-z0-9_-]+\\s*$`);

const catalogChanged = () =>
  bridgeError(
    'CATALOG_CHANGED',
    'the described tools or their schemas changed since this continuation was issued; describe them again by name.'
  );

// The `continueWith` arguments for the definitions still to page.
function continuationFor(remaining, offset, revisionOf) {
  const token = encodeContinuation(
    remaining.map((doc) => doc.index),
    revisionOf(remaining),
    offset
  );
  return { names: token };
}

// A token's definitions in the session's current scope, or null when any is
// gone or now refused (the session changed; the token grants nothing).
function continuationTargets(session, indexes, available, mode) {
  const eagerNames = eagerToolNames(session);
  const tools = indexes.map((index) => available[index]);
  if (tools.some((tool) => !tool || bridgeBlockReason(session, tool, mode, eagerNames))) return null;
  return tools;
}

const isIndex = (value) => Number.isSafeInteger(value) && value >= 0;

// ---------------------------------------------------------------------------
// Session catalog: eager surface + deferred catalog union, current scope only.

function eagerToolNames(session) {
  return new Set((Array.isArray(session?.tools) ? session.tools : []).map((tool) => clean(tool?.name)).filter(Boolean));
}

/**
 * Every tool currently available to the session (eager first wins), within
 * its own policy: a tool its allowlist or denied tools exclude is unknown
 * here (never described, listed or named as blocked).
 */
function availableBridgeTools(session) {
  const eager = Array.isArray(session?.tools) ? session.tools : [];
  const seen = new Set();
  const out = [];
  for (const tool of filterSessionToolPolicy([...eager, ...deferredCatalogUnion(session)], session)) {
    const name = clean(tool?.name);
    if (!name || seen.has(name) || !isDeferredToolAvailable(session, name)) continue;
    seen.add(name);
    out.push(tool);
  }
  return sortedCatalogByMeasuredUsage(out);
}

export function isBridgeReadonlySession(session, mode) {
  return (
    mode === 'readonly' ||
    session?.deferredSurfaceMode === 'readonly' ||
    resolveDeferredSelectMode(session) === 'readonly'
  );
}

// Why a currently available tool cannot run in this session, or null. Eager
// tools already passed the surface's own readonly filter.
function bridgeBlockReason(session, tool, mode, eagerNames) {
  const name = clean(tool?.name);
  const denial = preDispatchDenyForSession(session, { name, arguments: {} });
  if (denial) return denial.replace(/^Error:\s*/, '');
  // An eager tool the route never sends is not "directly available"; deferred
  // ones run through call_tool and need no declaration.
  const unsent = eagerNames.has(name) ? routeToolExclusionReason(session, tool) : null;
  if (unsent) return unsent;
  if (!eagerNames.has(name) && isBridgeReadonlySession(session, mode) && !isReadonlySelectable(tool)) {
    return 'readonly mode';
  }
  return null;
}

function lookupByName(tools, name) {
  const key = clean(name);
  if (!key) return null;
  const lower = key.toLowerCase();
  return (
    tools.find((tool) => clean(tool?.name) === key) ||
    tools.find((tool) => clean(tool?.name).toLowerCase() === lower) ||
    null
  );
}

// ---------------------------------------------------------------------------
// load_tool (bridge mode): describe only.

const schemaRevisionOf = (document) => hashText(JSON.stringify(document));

// An offset between the halves of a surrogate pair is not a code point boundary.
function splitsSurrogatePair(text, offset) {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function toolDocument(tool) {
  return {
    name: clean(tool?.name),
    description: typeof tool?.description === 'string' ? tool.description : '',
    inputSchema:
      tool?.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
    annotations: isPlainObject(tool?.annotations) ? tool.annotations : {},
  };
}

function describeNames(raw) {
  if (typeof raw !== 'string' && (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string'))) return null;
  const names = [...new Set(parseToolSelection(raw))];
  if (!names.length || names.length > BRIDGE_LIMITS.describeMaxNames) return null;
  if (names.some((name) => name.length > BRIDGE_LIMITS.nameMaxChars)) return null;
  return names;
}

// Requested names → available tools; an alias that names no tool expands to
// its members (existing load_tool alias compatibility).
function resolveDescribeTargets(session, names, mode, available) {
  const eagerNames = eagerToolNames(session);
  const targets = [];
  const missing = [];
  const blocked = [];
  const seen = new Set();
  const add = (tool) => {
    const name = clean(tool?.name);
    if (seen.has(name)) return;
    seen.add(name);
    const reason = bridgeBlockReason(session, tool, mode, eagerNames);
    if (reason) blocked.push({ name, reason });
    else targets.push(tool);
  };
  for (const requested of names) {
    const tool = lookupByName(available, requested);
    if (tool) {
      add(tool);
      continue;
    }
    const members = (DEFERRED_SELECT_ALIASES[requested.toLowerCase()] || [])
      .map((member) => lookupByName(available, member))
      .filter(Boolean);
    if (members.length) members.forEach(add);
    else missing.push(requested);
  }
  return { targets, missing, blocked };
}

const SEARCH_MAX_MATCHES = 20;
const SEARCH_DESCRIPTION_CHARS = 100;

// A requested name that is no tool is a keyword: a case-insensitive substring
// search over the deferred tools this session can run (the same availability,
// allow/deny and read-only rules as a lookup, so nothing the session cannot
// run is ever listed). Keywords with no hit stay in `missing`.
function searchKeywords(session, keywords, mode, available) {
  const eagerNames = eagerToolNames(session);
  const matches = [];
  const missing = [];
  let remaining = SEARCH_MAX_MATCHES;
  for (const keyword of keywords) {
    const tools = available
      .filter((tool) => {
        const name = clean(tool?.name);
        return (
          !eagerNames.has(name) &&
          !isBridgeMetaTool(name) &&
          toolSearchMatches(tool, keyword) &&
          !bridgeBlockReason(session, tool, mode, eagerNames)
        );
      })
      .slice(0, remaining)
      .map((tool) => ({
        name: clean(tool.name),
        description: clean(tool.description).slice(0, SEARCH_DESCRIPTION_CHARS),
      }));
    if (!tools.length) {
      missing.push(keyword);
      continue;
    }
    remaining -= tools.length;
    matches.push({ keyword, tools });
  }
  return { matches, missing };
}

// Largest code-point-aligned chunk of `text` from `offset` that keeps the page
// within budget; 0 when nothing more fits.
function largestChunk(text, offset, buildPage) {
  const fits = (length) =>
    fitsBudget(
      buildPage(text.slice(offset, offset + length)),
      BRIDGE_LIMITS.describeMaxBytes,
      BRIDGE_LIMITS.describeMaxTokens
    );
  let low = 0;
  let high = text.length - offset;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  // Never end a chunk between the halves of a surrogate pair (UTF-8 boundary).
  const last = text.charCodeAt(offset + low - 1);
  if (low > 0 && offset + low < text.length && last >= 0xd800 && last <= 0xdbff) low -= 1;
  return low;
}

export function describeBridgeTools(session, args = {}, { mode } = {}) {
  const syntaxHint = ' Use load_tool {"names":["exact_tool_name"]}; the required key is names, not name.';
  const invalid = unknownKeysError(args, DESCRIBE_KEYS, BRIDGE_LOAD_TOOL_NAME);
  if (invalid) {
    const hint = isPlainObject(args) && 'query' in args ? ' Pass exact names; the deferred tool list names them.' : '';
    return bridgeError(invalid.error.code, `${invalid.error.message}${hint}${syntaxHint}`);
  }
  // A continuation token resumes an earlier request. It travels alone: names
  // is split exactly as for a lookup, and a token beside any other value is
  // refused rather than read as a missing name.
  const raw = args.names;
  let strings = [];
  if (typeof raw === 'string') strings = [raw];
  else if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) strings = raw;
  let continuation = null;
  if (strings.some((item) => item.includes(BRIDGE_CONTINUATION_PREFIX))) {
    if (strings.length !== 1 || !CONTINUATION_TOKEN_PATTERN.test(strings[0])) {
      return bridgeError('INVALID_ARGUMENTS', 'pass a continuation token alone in names.');
    }
    continuation = decodeContinuation(strings[0].trim());
    if (continuation.error) return continuation;
  }
  const available = availableBridgeTools(session);
  let targets;
  let missing = [];
  let blocked = [];
  let matches = [];
  if (continuation) {
    targets = continuationTargets(session, continuation.indexes, available, mode);
    if (!targets) return catalogChanged();
  } else {
    const names = describeNames(raw);
    if (!names) {
      return bridgeError(
        'INVALID_ARGUMENTS',
        `names must be 1-${BRIDGE_LIMITS.describeMaxNames} exact tool names of at most ${BRIDGE_LIMITS.nameMaxChars} characters.${syntaxHint}`
      );
    }
    ({ targets, missing, blocked } = resolveDescribeTargets(session, names, mode, available));
    ({ matches, missing } = searchKeywords(session, missing, mode, available));
  }
  const found = matches.length ? { matches } : {};
  const docs = targets.map((tool) => {
    const document = toolDocument(tool);
    return {
      index: available.indexOf(tool),
      name: document.name,
      schemaRevision: schemaRevisionOf(document),
      value: document,
      text: JSON.stringify(document),
    };
  });
  const revisionOf = (list) => hashText(JSON.stringify(list.map((doc) => [doc.name, doc.schemaRevision])));
  let entryIndex = 0;
  let offset = 0;
  if (continuation) {
    if (continuation.revision !== revisionOf(docs)) return catalogChanged();
    const at = continuation.offset;
    if (at > docs[0].text.length || splitsSurrogatePair(docs[0].text, at)) return invalidContinuation();
    offset = at;
  }
  const entries = [];
  const reserve = { names: reserveContinuation(docs.length, available.length) };
  const page = (extra) => ({
    entries: [...entries, extra],
    missing,
    blocked,
    ...found,
    note: DESCRIBE_NOTE,
    continueWith: reserve,
  });
  const fits = (value) => fitsBudget(value, BRIDGE_LIMITS.describeMaxBytes, BRIDGE_LIMITS.describeMaxTokens);
  let nextPosition = null;
  for (; entryIndex < docs.length; entryIndex += 1, offset = 0) {
    const doc = docs[entryIndex];
    const head = { name: doc.name, schemaRevision: doc.schemaRevision };
    if (offset === 0) {
      const whole = { ...head, complete: true, document: doc.value };
      if (fits(page(whole))) {
        entries.push(whole);
        continue;
      }
      // A document that fits on a page of its own starts the next page whole.
      if (
        entries.length &&
        fits({ entries: [whole], missing, blocked, ...found, note: DESCRIBE_NOTE, continueWith: reserve })
      ) {
        nextPosition = [entryIndex, 0];
        break;
      }
    }
    const chunkEntry = (chunk) => ({
      ...head,
      complete: offset + chunk.length >= doc.text.length,
      offset,
      jsonTextChunk: chunk,
    });
    const length = largestChunk(doc.text, offset, (chunk) => page(chunkEntry(chunk)));
    if (length === 0) {
      if (!entries.length) return bridgeError('RESULT_TOO_LARGE', 'the description cannot fit in one result.');
      nextPosition = [entryIndex, offset];
      break;
    }
    const chunk = doc.text.slice(offset, offset + length);
    entries.push(chunkEntry(chunk));
    if (offset + length < doc.text.length) {
      nextPosition = [entryIndex, offset + length];
      break;
    }
  }
  const continueWith = nextPosition ? continuationFor(docs.slice(nextPosition[0]), nextPosition[1], revisionOf) : null;
  // Never hand out a token the decoder would refuse.
  if (continueWith && continueWith.names.length > BRIDGE_LIMITS.continuationMaxChars) {
    return bridgeError(
      'RESULT_TOO_LARGE',
      'the remaining definitions cannot be continued; describe fewer tools at once.'
    );
  }
  return { entries, missing, blocked, ...found, note: DESCRIBE_NOTE, continueWith };
}

// ---------------------------------------------------------------------------
// call_tool target resolution (session-scoped; rechecked at execution).

function catalogTool(session, name) {
  return lookupByName(deferredCatalogUnion(session), name);
}

/**
 * The deferred tool a call_tool request names, or an error. Policy (allow /
 * deny, readonly, worker scoping, approvals) is left to the target's ordinary
 * execution path so a bridged call is judged exactly like a direct one.
 */
export function resolveBridgeTarget(session, rawName) {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name || name.length > BRIDGE_LIMITS.nameMaxChars) {
    return bridgeError('INVALID_ARGUMENTS', `name must be 1-${BRIDGE_LIMITS.nameMaxChars} characters.`);
  }
  if (isBridgeMetaTool(name)) {
    return bridgeError('BRIDGE_RECURSION', `call_tool cannot run the bridge tool "${name}"; call it directly.`);
  }
  const eager = lookupByName(Array.isArray(session?.tools) ? session.tools : [], name);
  if (eager) {
    const direct = clean(eager.name);
    const excluded = providerToolExclusionReason(session, direct) || routeToolExclusionReason(session, eager);
    if (excluded) return bridgeError('TOOL_EXCLUDED', excluded);
    return bridgeError(
      'USE_DIRECT_TOOL',
      `"${direct}" is directly available; call ${direct} directly instead of call_tool.`
    );
  }
  const tool = catalogTool(session, name);
  if (!tool) {
    return bridgeError(
      'TOOL_NOT_FOUND',
      `no tool named "${name}" is available in this session; find tools with load_tool {names: keyword}.`
    );
  }
  const canonical = clean(tool.name);
  if (!isDeferredToolAvailable(session, canonical)) {
    return bridgeError(
      'TOOL_UNAVAILABLE',
      `tool "${canonical}" is unavailable in the current session catalog; no call was sent.`
    );
  }
  return { name: canonical, tool };
}

/** Execution-time recheck of a projected target (after hooks), or null. */
export function bridgeTargetUnavailable(session, name) {
  const key = clean(name);
  if (lookupByName(Array.isArray(session?.tools) ? session.tools : [], key)) return null;
  const tool = catalogTool(session, key);
  if (!tool) {
    return bridgeErrorText('TOOL_NOT_FOUND', `no tool named "${key}" is available in this session; no call was sent.`);
  }
  if (!isDeferredToolAvailable(session, clean(tool.name))) {
    return bridgeErrorText(
      'TOOL_UNAVAILABLE',
      `tool "${clean(tool.name)}" is unavailable in the current session catalog; no call was sent.`
    );
  }
  return null;
}
