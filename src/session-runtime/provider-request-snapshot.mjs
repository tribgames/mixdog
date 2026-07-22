// Provider request-tool resolution + JSON-safe snapshot machinery, extracted from tool-catalog.mjs.
import { clean, LATE_TOOL_ANNOUNCEMENT_SENTINEL } from './session-text.mjs';
import { estimateToolSchemaTokens, toolSchemaSignature } from '../runtime/agent/orchestrator/session/context-utils.mjs';
import {
  applyInitialDeferredToolManifestToBp1,
  buildDeferredToolManifest,
  stripDeferredToolManifestBlock,
} from '../runtime/agent/orchestrator/context/collect.mjs';
import { getMcpServerInstructionsMap } from '../runtime/agent/orchestrator/mcp/client.mjs';
import {
  isResponsesFreeformTool,
  toResponsesCustomTool,
} from '../runtime/agent/orchestrator/providers/custom-tool-wire.mjs';
import {
  finalizeProviderRequestTools,
  providerNativeToolPrefixCount,
} from './provider-request-tools.mjs';
import {
  DEFERRED_DEFAULT_FULL_TOOLS,
  DEFERRED_DEFAULT_LEAD_TOOLS,
  DEFERRED_DEFAULT_READONLY_TOOLS,
  DEFERRED_SELECT_ALIASES,
  MEASURED_TOOL_ORDER,
  MEASURED_TOOL_USAGE,
  READONLY_TOOL_NAMES,
} from './tool-catalog-data.mjs';
import { parseToolSelection, ANTHROPIC_NATIVE_PROVIDERS } from './tool-catalog-schema.mjs';

export function resolveProviderRequestTools({
  provider,
  tools,
  messages,
  session,
} = {}) {
  const activeTools = Array.isArray(tools) ? tools : [];
  const normalizedProvider = clean(provider || session?.provider).toLowerCase();
  if (!ANTHROPIC_NATIVE_PROVIDERS.has(normalizedProvider)
    || session?.deferredNativeTools !== true
    || activeTools.length === 0) {
    return activeTools;
  }
  const discovered = new Set(
    parseToolSelection(session?.deferredDiscoveredTools),
  );
  for (const message of Array.isArray(messages) ? messages : []) {
    const native = message?.nativeToolSearch;
    const source = clean(native?.provider).toLowerCase();
    if (source && source !== normalizedProvider
      && !(ANTHROPIC_NATIVE_PROVIDERS.has(source)
        && ANTHROPIC_NATIVE_PROVIDERS.has(normalizedProvider))) continue;
    for (const name of parseToolSelection(native?.toolReferences)) discovered.add(name);
  }
  if (discovered.size === 0) return activeTools;
  const activeNames = new Set(activeTools.map((tool) => clean(tool?.name)).filter(Boolean));
  const catalog = Array.isArray(session?.deferredToolCatalog) ? session.deferredToolCatalog : [];
  const deferredTools = catalog
    .filter((tool) => {
      const name = clean(tool?.name);
      return name && discovered.has(name) && !activeNames.has(name);
    })
    .map((tool) => ({ ...tool, deferLoading: true }));
  return deferredTools.length ? [...activeTools, ...deferredTools] : activeTools;
}

export const OMIT_REQUEST_TOOL_VALUE = Symbol('omit-request-tool-value');
export const MAX_PROVIDER_SNAPSHOT_ARRAY_LENGTH = 1_000_000;

export function defineEnumerableDataProperty(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: false,
    writable: false,
  });
}

export function boxedJsonPrimitive(value) {
  try { return { matched: true, value: Number.prototype.valueOf.call(value) }; } catch {}
  try { return { matched: true, value: String.prototype.valueOf.call(value) }; } catch {}
  try { return { matched: true, value: Boolean.prototype.valueOf.call(value) }; } catch {}
  try { return { matched: true, value: BigInt.prototype.valueOf.call(value) }; } catch {}
  return { matched: false, value: null };
}

export function providerSnapshotLengthPrimitive(value) {
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

export function providerSnapshotArrayLength(rawLength) {
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
      `provider tool snapshot: array length exceeds safe limit ${MAX_PROVIDER_SNAPSHOT_ARRAY_LENGTH}`,
    );
  }
  const effectiveLength = Math.floor(numeric);
  if (effectiveLength > MAX_PROVIDER_SNAPSHOT_ARRAY_LENGTH) {
    throw new RangeError(
      `provider tool snapshot: array length exceeds safe limit ${MAX_PROVIDER_SNAPSHOT_ARRAY_LENGTH}`,
    );
  }
  return effectiveLength;
}

export function normalizeRequestToolJson(value, state, {
  arrayEntry = false,
  key = '',
  applyToJSON = true,
  seededProperties = null,
} = {}) {
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
        normalized.push(normalizeRequestToolJson(entry, state, {
          arrayEntry: true,
          key: String(index),
        }));
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
        const entry = capturedProperties && Object.hasOwn(capturedProperties, key)
          ? capturedProperties[key]
          : value[key];
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

// Establish one immutable request-attempt snapshot. Nested schema records are
// cloned before freezing, so a catalog refresh or in-place schema mutation
// after this boundary cannot change either provider bytes or their signature.
export function snapshotProviderRequestTools(options = {}) {
  const {
    provider,
    tools,
    nativeTools,
    messages,
    session,
  } = options;
  const activeTools = Array.isArray(tools) ? tools : [];
  const state = { active: new WeakSet(), memo: new WeakMap() };
  const snapshots = [];
  const names = new Set();
  const activeCandidateRefs = new WeakSet();
  // Anthropic native definitions are already provider-wire objects. Preserve
  // their prior prepend order and duplicate behavior, but freeze the exact
  // bytes into the same request snapshot used for accounting and retries.
  if (ANTHROPIC_NATIVE_PROVIDERS.has(clean(provider || session?.provider).toLowerCase())) {
    for (const nativeTool of Array.isArray(nativeTools) ? nativeTools : []) {
      if (!nativeTool || typeof nativeTool !== 'object') continue;
      const normalized = normalizeRequestToolJson(nativeTool, state);
      if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
        snapshots.push(normalized);
      }
    }
  }
  const nativePrefixCount = snapshots.length;
  const finish = () => finalizeProviderRequestTools(snapshots, nativePrefixCount);
  const appendSnapshot = (candidate, selectedName = null, deferred = false) => {
    const normalized = normalizeRequestToolJson(candidate, state, {
      seededProperties: selectedName === null ? null : { name: selectedName },
    });
    if (deferred && (
      !normalized
      || typeof normalized !== 'object'
      || Array.isArray(normalized)
      || typeof normalized.name !== 'string'
      || !clean(normalized.name)
      || normalized.name !== selectedName
    )) {
      throw new TypeError(`provider tool snapshot: selected tool identity mismatch for ${JSON.stringify(selectedName)}`);
    }
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return;
    const name = clean(normalized.name);
    if (!name || names.has(name)) return;
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
  };

  // Active candidates are provider-visible by definition: normalize each once,
  // then perform all validation/dedupe from the plain snapshot only.
  for (const tool of activeTools) {
    if (tool && typeof tool === 'object') activeCandidateRefs.add(tool);
    appendSnapshot(tool);
  }

  const normalizedProvider = clean(provider || session?.provider).toLowerCase();
  if (!ANTHROPIC_NATIVE_PROVIDERS.has(normalizedProvider)
    || session?.deferredNativeTools !== true
    // Native definitions preserve their historical prepend behavior, but they
    // do not make an otherwise all-deferred catalog eligible for expansion.
    || names.size === 0) {
    return finish();
  }
  const discovered = new Set(parseToolSelection(session?.deferredDiscoveredTools));
  for (const message of Array.isArray(messages) ? messages : []) {
    const native = message?.nativeToolSearch;
    const source = clean(native?.provider).toLowerCase();
    if (source && source !== normalizedProvider
      && !(ANTHROPIC_NATIVE_PROVIDERS.has(source)
        && ANTHROPIC_NATIVE_PROVIDERS.has(normalizedProvider))) continue;
    for (const name of parseToolSelection(native?.toolReferences)) discovered.add(name);
  }
  if (discovered.size === 0) return finish();

  // Catalog arrays have no separate key map, so `name` is their explicit
  // selection key contract: capture it once, skip undiscovered/duplicate
  // entries without touching schemas, and seed selected normalization with the
  // captured value to avoid a second getter evaluation.
  const seenCatalogRefs = new WeakSet();
  for (const tool of Array.isArray(session?.deferredToolCatalog) ? session.deferredToolCatalog : []) {
    if (tool && typeof tool === 'object') {
      if (activeCandidateRefs.has(tool) || seenCatalogRefs.has(tool)) continue;
      seenCatalogRefs.add(tool);
    }
    const capturedName = tool?.name;
    const selectionName = typeof capturedName === 'string' ? clean(capturedName) : '';
    if (!selectionName || !discovered.has(selectionName) || names.has(selectionName)) continue;
    appendSnapshot(tool, capturedName, true);
  }
  return finish();
}
