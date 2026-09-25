import { createHash } from 'node:crypto';

const COMPACTION_INTENTS = new Set([
  'automatic_compaction',
  'deferred_body_compaction',
  'manual_compaction',
  'post_turn_compaction',
]);

function digest(value) {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string') {
    throw new TypeError('provider prefix value is not serializable');
  }
  return createHash('sha256').update(encoded).digest('hex');
}

// Stored transcript rows keep their identity across requests but can still be
// rewritten in place (e.g. deferred-tools strips manifest blocks from system
// rows), so identity alone never proves a digest current. Each memo entry
// keeps a structural token list of the plain-JSON value it hashed; a lookup
// re-walks the message and reuses the digest only when every key, length and
// primitive is unchanged. The walk compares references and never serializes
// or hashes, so settled history costs a node walk instead of stringify+sha256.
const messageDigestMemo = new WeakMap();
const OBJECT_TOKEN = {};
const ARRAY_TOKEN = {};

// Plain objects/arrays whose JSON form is fully determined by own enumerable
// keys and primitives; anything else (Buffer, Date, class instances, toJSON
// hooks, functions) keeps being hashed on every request.
function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function recordShape(value, tokens) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') return false;
    tokens.push(value);
    return true;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    tokens.push(ARRAY_TOKEN, value.length);
    for (let index = 0; index < value.length; index += 1) {
      if (!recordShape(value[index], tokens)) return false;
    }
    return true;
  }
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  tokens.push(OBJECT_TOKEN, keys.length);
  for (const key of keys) {
    tokens.push(key);
    if (!recordShape(value[key], tokens)) return false;
  }
  return true;
}

// Returns the next token cursor, or -1 when the value no longer matches.
function matchShape(value, tokens, cursor) {
  if (cursor < 0 || cursor >= tokens.length) return -1;
  if (value === null || typeof value !== 'object') {
    return Object.is(tokens[cursor], value) ? cursor + 1 : -1;
  }
  if (Array.isArray(value)) {
    if (tokens[cursor] !== ARRAY_TOKEN || tokens[cursor + 1] !== value.length) return -1;
    let next = cursor + 2;
    for (let index = 0; index < value.length && next >= 0; index += 1) {
      next = matchShape(value[index], tokens, next);
    }
    return next;
  }
  if (tokens[cursor] !== OBJECT_TOKEN || !isPlainObject(value)) return -1;
  const keys = Object.keys(value);
  if (tokens[cursor + 1] !== keys.length) return -1;
  let next = cursor + 2;
  for (let index = 0; index < keys.length && next >= 0; index += 1) {
    const key = keys[index];
    if (tokens[next] !== key) return -1;
    next = matchShape(value[key], tokens, next + 1);
  }
  return next;
}

function messageDigest(message) {
  if (message === null || typeof message !== 'object') return digest(message);
  const memo = messageDigestMemo.get(message);
  if (memo && matchShape(message, memo.tokens, 0) === memo.tokens.length) return memo.hash;
  const hash = digest(message);
  const tokens = [];
  if (recordShape(message, tokens)) messageDigestMemo.set(message, { hash, tokens });
  else messageDigestMemo.delete(message);
  return hash;
}

function cacheRelevantRequestPrefix(requestPrefix, provider) {
  const prefix = requestPrefix && typeof requestPrefix === 'object' ? requestPrefix : {};
  const anthropic = /^(?:anthropic|anthropic-oauth)$/i.test(String(provider || ''));
  const cacheRelevantTools = (tools) =>
    Array.isArray(tools)
      ? tools.filter((tool) => !anthropic || (tool?.deferLoading !== true && tool?.defer_loading !== true))
      : [];
  return {
    ...prefix,
    tools: cacheRelevantTools(prefix.tools),
    nativeTools: cacheRelevantTools(prefix.nativeTools),
  };
}

function snapshot(messages, requestPrefix, options = {}) {
  const provider = String(options.provider || '');
  const model = String(options.model || '');
  const relevantPrefix = cacheRelevantRequestPrefix(requestPrefix, provider);
  return {
    messageHashes: messages.map(messageDigest),
    requestPrefixHash: digest({ provider, model, requestPrefix: relevantPrefix }),
    provider,
    model,
    toolSchemaHash: digest(relevantPrefix.tools),
    nativeToolSchemaHash: digest(relevantPrefix.nativeTools),
  };
}

function firstChangedMessageIndex(previousHashes, nextHashes) {
  const limit = Math.min(previousHashes.length, nextHashes.length);
  for (let index = 0; index < limit; index += 1) {
    if (previousHashes[index] !== nextHashes[index]) return index;
  }
  return nextHashes.length < previousHashes.length ? nextHashes.length : null;
}

function notifyCacheBreak(options, details) {
  try {
    options.onCacheBreak?.(details);
  } catch {
    /* observability only */
  }
}

function requestPrefixChangeReason(previous, next) {
  if (previous.provider !== undefined && previous.provider !== next.provider) return 'provider_changed';
  if (previous.model !== undefined && previous.model !== next.model) return 'model_changed';
  if (previous.toolSchemaHash !== undefined && previous.toolSchemaHash !== next.toolSchemaHash) {
    return 'tool_schema_changed';
  }
  if (previous.nativeToolSchemaHash !== undefined && previous.nativeToolSchemaHash !== next.nativeToolSchemaHash) {
    return 'native_tool_schema_changed';
  }
  return 'request_properties_changed';
}

export class ProviderPrefixMutationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProviderPrefixMutationError';
    this.code = 'PROVIDER_PREFIX_MUTATION';
    this.details = details;
  }
}

function isCompactionPrefixReset(intent) {
  return COMPACTION_INTENTS.has(String(intent || ''));
}

export function prepareProviderPrefixGuard(previous, messages, requestPrefix, options = {}) {
  const next = snapshot(Array.isArray(messages) ? messages : [], requestPrefix, options);
  if (!previous) return next;

  const previousHashes = Array.isArray(previous.messageHashes) ? previous.messageHashes : [];
  const nextHashes = next.messageHashes;
  const changedIndex = firstChangedMessageIndex(previousHashes, nextHashes);
  const requestPrefixChanged = previous.requestPrefixHash !== next.requestPrefixHash;
  if (isCompactionPrefixReset(options.cacheBreakIntent)) {
    if (changedIndex !== null || requestPrefixChanged) {
      notifyCacheBreak(options, {
        classification: 'intentional',
        reason: String(options.cacheBreakIntent),
        source: 'compaction',
        provider: options.provider || null,
        model: options.model || null,
        index: changedIndex,
        previousCount: previousHashes.length,
        nextCount: nextHashes.length,
        previousHash: changedIndex === null ? null : previousHashes[changedIndex],
        nextHash: changedIndex === null ? null : nextHashes[changedIndex],
        previousRequestPrefixHash: previous.requestPrefixHash,
        nextRequestPrefixHash: next.requestPrefixHash,
        requestPrefixChanged,
      });
    }
    return next;
  }

  const mutationDetails = (kind, index, previousHash, nextHash) => ({
    classification: 'unexpected',
    reason: kind,
    provider: options.provider || null,
    model: options.model || null,
    kind,
    source: options.mutationSource || null,
    index,
    previousCount: previousHashes.length,
    nextCount: nextHashes.length,
    previousHash,
    nextHash,
    previousRequestPrefixHash: previous.requestPrefixHash,
    nextRequestPrefixHash: next.requestPrefixHash,
    requestPrefixChanged,
  });
  if (nextHashes.length < previousHashes.length) {
    const details = mutationDetails(
      'history_shrink',
      nextHashes.length,
      previousHashes[nextHashes.length] || null,
      null
    );
    notifyCacheBreak(options, details);
    throw new ProviderPrefixMutationError('provider message history shrank outside compaction', details);
  }
  // History did not shrink, so changedIndex is the first rewritten message.
  if (changedIndex !== null) {
    const details = mutationDetails(
      'message_prefix',
      changedIndex,
      previousHashes[changedIndex],
      nextHashes[changedIndex]
    );
    notifyCacheBreak(options, details);
    throw new ProviderPrefixMutationError('provider message prefix changed outside compaction', details);
  }
  if (requestPrefixChanged) {
    notifyCacheBreak(options, {
      classification: 'intentional',
      reason: requestPrefixChangeReason(previous, next),
      source: 'request_configuration',
      provider: options.provider || null,
      model: options.model || null,
      index: null,
      previousCount: previousHashes.length,
      nextCount: nextHashes.length,
      previousHash: null,
      nextHash: null,
      previousRequestPrefixHash: previous.requestPrefixHash,
      nextRequestPrefixHash: next.requestPrefixHash,
      requestPrefixChanged: true,
    });
    // Tool schemas are request metadata, not durable conversation state.
    // App updates may change them between turns, so rebaseline the provider
    // cache prefix after the transcript itself has passed integrity checks.
  }
  return next;
}
