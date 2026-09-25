// Provider request-tool resolution + JSON-safe snapshot machinery.
import { types } from 'node:util';
import { clean } from './session-text.mjs';
import { isDeferredToolAvailable } from './deferred-tool-availability.mjs';
import { finalizeProviderRequestTools } from './provider-request-tools.mjs';
import { parseToolSelection, ANTHROPIC_NATIVE_PROVIDERS } from './tool-catalog-schema.mjs';

const OMIT_REQUEST_TOOL_VALUE = Symbol('omit-request-tool-value');
const MAX_PROVIDER_SNAPSHOT_ARRAY_LENGTH = 1_000_000;

function defineEnumerableDataProperty(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: false,
    writable: false,
  });
}

const UNBOXED = Object.freeze({ matched: false, value: null });

// Internal-slot checks (cross-realm, proxy-opaque) select the one valueOf that
// accepts the object, so plain schema records are classified without throwing.
function boxedJsonPrimitive(value) {
  if (!types.isBoxedPrimitive(value)) return UNBOXED;
  if (types.isNumberObject(value)) return { matched: true, value: Number.prototype.valueOf.call(value) };
  if (types.isStringObject(value)) return { matched: true, value: String.prototype.valueOf.call(value) };
  if (types.isBooleanObject(value)) return { matched: true, value: Boolean.prototype.valueOf.call(value) };
  if (types.isBigIntObject(value)) return { matched: true, value: BigInt.prototype.valueOf.call(value) };
  return UNBOXED;
}

function providerSnapshotLengthPrimitive(value) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return value;
  const exotic = value[Symbol.toPrimitive];
  if (exotic !== undefined && exotic !== null) {
    if (typeof exotic !== 'function') throw new TypeError('invalid length primitive');
    const primitive = exotic.call(value, 'number');
    if ((typeof primitive === 'object' && primitive !== null) || typeof primitive === 'function') {
      throw new TypeError('invalid length primitive');
    }
    return primitive;
  }
  for (const methodName of ['valueOf', 'toString']) {
    const method = value[methodName];
    if (typeof method !== 'function') continue;
    const primitive = method.call(value);
    if ((typeof primitive !== 'object' || primitive === null) && typeof primitive !== 'function') {
      return primitive;
    }
  }
  throw new TypeError('invalid length primitive');
}

function providerSnapshotArrayLength(rawLength) {
  let primitive;
  let numeric;
  try {
    primitive = providerSnapshotLengthPrimitive(rawLength);
    if (typeof primitive === 'bigint' || typeof primitive === 'symbol') {
      throw new TypeError('invalid length primitive');
    }
    numeric = Number(primitive);
  } catch {
    throw new TypeError('provider tool snapshot: invalid array length');
  }
  if (Number.isNaN(numeric) || numeric <= 0) return 0;
  if (!Number.isFinite(numeric)) {
    throw new RangeError(
      `provider tool snapshot: array length exceeds safe limit ${MAX_PROVIDER_SNAPSHOT_ARRAY_LENGTH}`
    );
  }
  const effectiveLength = Math.floor(numeric);
  if (effectiveLength > MAX_PROVIDER_SNAPSHOT_ARRAY_LENGTH) {
    throw new RangeError(
      `provider tool snapshot: array length exceeds safe limit ${MAX_PROVIDER_SNAPSHOT_ARRAY_LENGTH}`
    );
  }
  return effectiveLength;
}

function normalizeRequestToolJson(
  value,
  state,
  { arrayEntry = false, key = '', applyToJSON = true, seededProperties = null } = {}
) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') {
    throw new TypeError('provider tool snapshot: BigInt is not JSON-serializable');
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return arrayEntry ? null : OMIT_REQUEST_TOOL_VALUE;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`provider tool snapshot: unsupported JSON value type ${typeof value}`);
  }
  if (state.active.has(value)) {
    throw new TypeError('provider tool snapshot: cyclic value is not JSON-serializable');
  }
  if (state.memo.has(value)) return state.memo.get(value);

  let capturedProperties = seededProperties;
  if (applyToJSON) {
    // JSON reads `toJSON` once before serializing an object. Preserve that
    // single observation for an own-enumerable non-function (and for a
    // callable that returns `this`) so property traversal cannot invoke a
    // stateful accessor a second time.
    const toJSONDescriptor = Object.getOwnPropertyDescriptor(value, 'toJSON');
    const toJSON = value.toJSON;
    if (typeof toJSON === 'function') {
      // Keep the source guarded through both hook execution and replacement
      // normalization. A hook returning itself, or any replacement graph that
      // points back to its source, is a JSON cycle rather than another hook
      // invocation.
      state.active.add(value);
      try {
        const replacement = toJSON.call(value, key);
        const normalized = normalizeRequestToolJson(replacement, state, {
          arrayEntry,
          key,
          applyToJSON: false,
          seededProperties: null,
        });
        state.memo.set(value, normalized);
        return normalized;
      } finally {
        state.active.delete(value);
      }
    }
    if (toJSONDescriptor?.enumerable) {
      capturedProperties = { ...(seededProperties || {}), toJSON };
    }
  }
  const boxed = boxedJsonPrimitive(value);
  if (boxed.matched) {
    return normalizeRequestToolJson(boxed.value, state, { arrayEntry, key });
  }

  const isArray = Array.isArray(value);
  const normalized = isArray ? [] : {};
  state.active.add(value);
  try {
    if (isArray) {
      // JSON.stringify captures array length once. Accessors may mutate the
      // source array, but they cannot extend or shorten this iteration bound.
      const rawLength = value.length;
      const length = providerSnapshotArrayLength(rawLength);
      for (let index = 0; index < length; index += 1) {
        const entry = value[index];
        normalized.push(
          normalizeRequestToolJson(entry, state, {
            arrayEntry: true,
            key: String(index),
          })
        );
      }
    } else {
      // JSON-compatible request schemas are own-enumerable data. Normalize class
      // instances/accessors to a plain record, ignore inherited mutable fields,
      // and define keys explicitly so an own "__proto__" remains ordinary data.
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable) continue;
        // Deferred catalog selection captures `name` once before touching the
        // candidate schema. Seed that captured value here so a stateful/throwing
        // getter is never observed a second time during JSON normalization.
        const entry =
          capturedProperties && Object.hasOwn(capturedProperties, key) ? capturedProperties[key] : value[key];
        const child = normalizeRequestToolJson(entry, state, { key });
        if (child !== OMIT_REQUEST_TOOL_VALUE) defineEnumerableDataProperty(normalized, key, child);
      }
    }
  } finally {
    state.active.delete(value);
  }
  Object.freeze(normalized);
  state.memo.set(value, normalized);
  return normalized;
}

const NO_ENTRIES = Object.freeze([]);

function entriesOf(value) {
  return Array.isArray(value) ? value : NO_ENTRIES;
}

function sameEntries(stored, current) {
  if (stored === null || current === null) return stored === current;
  if (stored.length !== current.length) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (stored[index] !== current[index]) return false;
  }
  return true;
}

function sameNames(stored, current) {
  if (stored.size !== current.size) return false;
  for (const name of current) {
    if (!stored.has(name)) return false;
  }
  return true;
}

function snapshotStage(session, names = new Set(), snapshots = []) {
  return { state: { active: new WeakSet(), memo: new WeakMap() }, names, snapshots, session };
}

function appendToolSnapshot(stage, candidate, selectedName = null, deferred = false) {
  const { state, names, snapshots, session } = stage;
  const normalized = normalizeRequestToolJson(candidate, state, {
    seededProperties: selectedName === null ? null : { name: selectedName },
  });
  if (
    deferred &&
    (!normalized ||
      typeof normalized !== 'object' ||
      Array.isArray(normalized) ||
      typeof normalized.name !== 'string' ||
      !clean(normalized.name) ||
      normalized.name !== selectedName)
  ) {
    throw new TypeError(`provider tool snapshot: selected tool identity mismatch for ${JSON.stringify(selectedName)}`);
  }
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return;
  const name = clean(normalized.name);
  if (!name || names.has(name) || !isDeferredToolAvailable(session, name)) return;
  names.add(name);
  if (!deferred) {
    snapshots.push(normalized);
    return;
  }
  const deferredSnapshot = {};
  for (const key of Object.keys(normalized)) {
    if (key === 'deferLoading' || key === 'defer_loading') continue;
    defineEnumerableDataProperty(deferredSnapshot, key, normalized[key]);
  }
  defineEnumerableDataProperty(deferredSnapshot, 'deferLoading', true);
  snapshots.push(Object.freeze(deferredSnapshot));
}

// Native definitions plus active candidates: the message-independent stage.
function baseToolSnapshot(provider, activeTools, nativeTools, session, mcpNames) {
  const stage = snapshotStage(session);
  const activeCandidateRefs = new WeakSet();
  // Anthropic native definitions are already provider-wire objects. Preserve
  // their prior prepend order and duplicate behavior, but freeze the exact
  // bytes into the same request snapshot used for accounting and retries.
  for (const nativeTool of nativeTools) {
    if (!nativeTool || typeof nativeTool !== 'object') continue;
    const normalized = normalizeRequestToolJson(nativeTool, stage.state);
    if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
      stage.snapshots.push(normalized);
    }
  }
  const nativePrefixCount = stage.snapshots.length;
  // Active candidates are provider-visible by definition: normalize each once,
  // then perform all validation/dedupe from the plain snapshot only.
  for (const tool of activeTools) {
    if (tool && typeof tool === 'object') activeCandidateRefs.add(tool);
    appendToolSnapshot(stage, tool);
  }
  return {
    provider,
    session,
    tools: activeTools.slice(),
    nativeTools: nativeTools.slice(),
    mcpNames: mcpNames && mcpNames.slice(),
    names: stage.names,
    activeCandidateRefs,
    nativePrefixCount,
    result: finalizeProviderRequestTools(stage.snapshots, nativePrefixCount),
    discovery: { refs: [], found: [], counts: new Map() },
    deferred: null,
  };
}

function messageToolReferences(message, provider) {
  const native = message?.nativeToolSearch;
  const source = clean(native?.provider).toLowerCase();
  if (
    source &&
    source !== provider &&
    !(ANTHROPIC_NATIVE_PROVIDERS.has(source) && ANTHROPIC_NATIVE_PROVIDERS.has(provider))
  )
    return null;
  const names = parseToolSelection(native?.toolReferences);
  return names.length ? names : null;
}

function countNames(counts, names, direction) {
  for (const name of names || NO_ENTRIES) {
    const next = (counts.get(name) || 0) + direction;
    if (next > 0) counts.set(name, next);
    else counts.delete(name);
  }
}

// Transcript-discovered tool names, folded in per message: an entry confirmed
// by identity keeps the references parsed when it was appended.
function syncDiscoveredReferences(discovery, provider, messages) {
  const { refs, found, counts } = discovery;
  const list = entriesOf(messages);
  const previousCount = refs.length;
  for (let index = 0; index < list.length; index += 1) {
    const message = list[index];
    if (index < previousCount && refs[index] === message) continue;
    const names = messageToolReferences(message, provider);
    if (index < previousCount) countNames(counts, found[index], -1);
    refs[index] = message;
    found[index] = names;
    countNames(counts, names, 1);
  }
  for (let index = list.length; index < previousCount; index += 1) countNames(counts, found[index], -1);
  refs.length = list.length;
  found.length = list.length;
  return counts;
}

// Claude-compatible deferred loading: the catalog stays metadata-only until
// tool_search/load_tool selects a name. Only selected schemas join the next
// request, marked defer_loading; active schemas continue to win by name.
function deferredToolSnapshot(base, session, discovered) {
  const catalog = entriesOf(session?.deferredToolCatalog);
  const lateCatalog = entriesOf(session?.deferredLateToolCatalog);
  const cached = base.deferred;
  if (
    cached &&
    sameEntries(cached.catalog, catalog) &&
    sameEntries(cached.lateCatalog, lateCatalog) &&
    sameNames(cached.discovered, discovered)
  )
    return cached.result;
  const stage = snapshotStage(session, new Set(base.names), base.result.slice());
  const seenCatalogRefs = new WeakSet();
  const catalogByName = new Map();
  for (const tool of [...catalog, ...lateCatalog]) {
    // `name` is read once per entry: a getter may answer differently on a later read.
    const capturedName = tool?.name;
    const name = typeof capturedName === 'string' ? clean(capturedName) : '';
    if (name) catalogByName.set(name, { tool, capturedName });
  }
  for (const [selectionName, { tool, capturedName }] of catalogByName) {
    if (tool && typeof tool === 'object') {
      if (base.activeCandidateRefs.has(tool) || seenCatalogRefs.has(tool)) continue;
      seenCatalogRefs.add(tool);
    }
    if (!discovered.has(selectionName) || stage.names.has(selectionName)) continue;
    appendToolSnapshot(stage, tool, capturedName, true);
  }
  const result = finalizeProviderRequestTools(stage.snapshots, base.nativePrefixCount);
  base.deferred = { catalog: catalog.slice(), lateCatalog: lateCatalog.slice(), discovered, result };
  return result;
}

// Tool array → last snapshot built from it. Producers replace descriptors
// (MCP reload, policy refresh, catalog rebuild) and grow/shrink the arrays in
// place, so a stage is reused while every input list holds the same entries.
const requestToolSnapshotMemo = new WeakMap();

// Establish one immutable request-attempt snapshot. Nested schema records are
// cloned before freezing, so a catalog refresh or in-place schema mutation
// after this boundary cannot change either provider bytes or their signature.
export function snapshotProviderRequestTools(options = {}) {
  const { provider, tools, nativeTools, messages, session } = options;
  const normalizedProvider = clean(provider || session?.provider).toLowerCase();
  const anthropic = ANTHROPIC_NATIVE_PROVIDERS.has(normalizedProvider);
  const activeTools = entriesOf(tools);
  const nativeList = anthropic ? entriesOf(nativeTools) : NO_ENTRIES;
  const mcpNames = Array.isArray(session?.deferredMcpToolNames) ? session.deferredMcpToolNames : null;
  let base = Array.isArray(tools) ? requestToolSnapshotMemo.get(tools) : null;
  if (
    !base ||
    base.provider !== normalizedProvider ||
    base.session !== session ||
    !sameEntries(base.tools, activeTools) ||
    !sameEntries(base.nativeTools, nativeList) ||
    !sameEntries(base.mcpNames, mcpNames)
  ) {
    base = baseToolSnapshot(normalizedProvider, activeTools, nativeList, session, mcpNames);
    if (Array.isArray(tools)) requestToolSnapshotMemo.set(tools, base);
  }
  if (
    !anthropic ||
    session?.deferredNativeTools !== true ||
    // Native definitions preserve their historical prepend behavior, but they
    // do not make an otherwise all-deferred catalog eligible for expansion.
    base.names.size === 0
  ) {
    return base.result;
  }
  const discovered = new Set(parseToolSelection(session?.deferredDiscoveredTools));
  for (const name of syncDiscoveredReferences(base.discovery, normalizedProvider, messages).keys()) {
    discovered.add(name);
  }
  if (discovered.size === 0) return base.result;
  return deferredToolSnapshot(base, session, discovered);
}
