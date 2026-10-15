// Guard: the PC-side send-option allowlist (model-proxy-host.ts) must never
// silently drop an option a provider adapter reads, and must bridge only
// callbacks it knows. Every option key the adapters read from their send
// options is collected from their syntax trees and has to be allowlisted,
// deliberately dropped (with a reason) or shown — for that file — not to be a
// send option at all.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

import {
  MODEL_PROXY_CALLBACKS,
  MODEL_PROXY_DROPPED_SEND_OPTIONS,
  MODEL_PROXY_SEND_OPTION_KEYS,
  MODEL_PROXY_SESSION_KEYS,
  serverSendOptions,
} from './model-proxy-host.ts';

const PROVIDERS = fileURLToPath(new URL('../../../../src/runtime/agent/orchestrator/providers/', import.meta.url));

/** `file::key` reads the scan finds on objects that are NOT provider send
 *  options in that file (helper arguments that share a name), with the reason. */
const NOT_SEND_OPTIONS = new Map([
  ['auto-effort.mjs::map', '`options` is the array of supported effort levels'],
  [
    'effort-configuration.mjs::protocol',
    "the custom route's wire protocol, set by the adapter itself from its own provider config",
  ],
  ['mimo-oauth-tokens.mjs::persist', 'token probe argument'],
  ['model-list-sanitize.mjs::provider', 'model-list helper argument'],
  ['oauth-usage.mjs::allowStale', 'usage-snapshot read options'],
  ['oauth-usage.mjs::expectedOfferRevision', 'usage-offer helper argument'],
  ['oauth-usage.mjs::force', 'usage refresh helper argument'],
  ['openai-compat-wire.mjs::includeSystem', 'message-conversion helper argument'],
  ['openai-compat-wire.mjs::model', 'message-conversion helper argument'],
  ['openai-compat-wire.mjs::provider', 'message-conversion helper argument'],
  [
    'openai-oauth.mjs::model',
    'startup prewarm options built by the adapter (the model is a positional send parameter)',
  ],
  ['openai-ws-send/send-context.mjs::body', 'internal WS send context'],
  ['openai-ws-send/send-context.mjs::cacheKey', 'internal WS send context'],
  ['openai-ws-send/send-context.mjs::displayModel', 'internal WS send context'],
  ['openai-ws-send/send-context.mjs::externalSignal', 'internal WS send context'],
  ['openai-ws-send/send-context.mjs::handshakeErrorPolicy', 'internal WS send context'],
  ['openai-ws-send/send-context.mjs::includeResponseId', 'internal WS send context'],
  ['openai-ws-send/send-context.mjs::poolKey', 'internal WS send context'],
  ['openai-ws-send/send-context.mjs::sendOpts', 'internal WS send context carrying the send options themselves'],
  ['openai-ws-send/send-context.mjs::traceProvider', 'internal WS send context'],
  ['openai-ws-send/send-context.mjs::useModel', 'internal WS send context'],
  ['openai-compat-wire.mjs::cacheControl', 'toOpenAIMessages internal options built by the adapter'],
  ['openai-compat-wire.mjs::nativeDeferredTools', 'toOpenAIMessages internal options built by the adapter'],
  ['openai-compat-wire.mjs::developerRole', 'toOpenAIMessages internal options built by the adapter'],
  ['openai-compat-wire.mjs::reasoningShape', 'toOpenAIMessages internal options built by the adapter'],
  [
    'wire-gateway.mjs::messagesEffortProjection',
    "the gateway's own effort projection function, set by the adapter from its provider config",
  ],
  ['openai-compat-wire.mjs::nativeLowering', 'toOpenAIMessages internal options built by the Responses adapter'],
  ['openai-compat-wire.mjs::providerName', 'toOpenAIMessages internal options built by the adapter from its own name'],
  ['openai-compat-wire.mjs::serverToolSearch', 'toOpenAIMessages internal options built by the adapter'],
  ['openai-responses-input.mjs::includeSystem', 'message-lowering helper argument built by the adapter'],
  ['openai-responses-input.mjs::reasoningByMessageIndex', 'message-lowering helper argument built by the adapter'],
  ['openai-responses-input.mjs::replayOwnedReasoning', 'message-lowering helper argument built by the adapter'],
  ['openai-responses-input.mjs::splitToolContent', 'message-lowering helper argument built by the adapter'],
  ['openai-responses-input.mjs::startIndex', 'message-lowering helper argument built by the adapter'],
  ['openai-ws.mjs::enabled', 'HTTP-fallback policy helper argument'],
  ['registry.mjs::force', 'registry refresh helper argument'],
  ['retry-executor.mjs::backoffMs', 'withRetry helper argument built by the adapter'],
  ['retry-executor.mjs::model', 'withRetry helper argument built by the adapter'],
  ['retry-executor.mjs::onRetry', 'withRetry helper callback built by the adapter, never a send option'],
  ['retry-executor.mjs::sleepFn', 'withRetry test seam argument'],
  ['retry-executor.mjs::adviceAtLeastBackoff', 'withRetry retry-policy argument built by the adapter'],
  ['retry-executor.mjs::honorShouldRetryTrue', 'withRetry retry-policy argument built by the adapter'],
  ['retry-executor.mjs::overloadState', 'withRetry per-send overload counter built by the adapter'],
  ['retry-executor.mjs::retry499', 'withRetry retry-policy argument built by the adapter'],
  ['retry-executor.mjs::retryAfterJitterRatio', 'withRetry retry-policy argument built by the adapter'],
  ['retry-executor.mjs::stopAfterRepeated529', 'withRetry retry-policy argument built by the adapter'],
  ['retry-executor.mjs::overloadFallbackAfter', 'withRetry retry-policy argument built by the adapter'],
  ['retry-executor.mjs::finalOnExhaust', 'withRetry retry-policy argument built by the adapter'],
  ['retry-executor.mjs::recycleDispatcherOn5xx', 'withRetry retry-policy argument built by the adapter'],
  ['retry-classification.mjs::retry499', 'classifyError policy argument, never a send option'],
  ['account-pool.mjs::useCredits', 'account-exhaustion helper option built from the pool, never a send option'],
  ['provider-error-kind.mjs::legacyQuotaWording', 'providerErrorKind presentation option, never a send option'],
  ['provider-error-kind.mjs::quotaFlags', 'providerErrorKind classifier option, never a send option'],
  ['provider-error-kind.mjs::text', 'providerErrorKind classifier option, never a send option'],
]);

/** `file::key` session reads the scan finds in a file whose `session` variable
 *  is also the daemon's full session (not the projected send-option one). */
const NOT_PROJECTED_SESSION_READS = new Map([
  [
    'wire-route.mjs::messages',
    'read by pinSessionWireRoute (daemon-side session) AND by the send path (legacy detection, lowering count), which on a projected session falls back to the request messages',
  ],
]);

/** `file::expression` computed reads off send options, with why they are safe. */
const DYNAMIC_READS = new Map([
  [
    'account-pool.mjs::options[key]',
    'keys from the literal list onStreamDelta/onTextDelta/onToolCall (bridged callbacks) and onThinkingDelta (no caller supplies it)',
  ],
  ['account-pool.mjs::opts[key]', 'writes the wrapped callbacks of that same literal list onto a copy'],
  ['effort-rejection.mjs::opts?.[key]', 'EFFORT_OPT_KEYS: xai/openRouter/deepseek reasoning effort, all allowlisted'],
  ['effort-rejection.mjs::next[key]', 'writes EFFORT_OPT_KEYS onto a copy'],
  ['effort-rejection.mjs::opts?.[name]', 'STREAM_CALLBACKS: onStreamDelta/onTextDelta/onToolCall, all bridged'],
  ['effort-rejection.mjs::tracked[name]', 'writes the wrapped STREAM_CALLBACKS onto a copy'],
  ['mimo-oauth-profile.mjs::opts[key]', 'keys from the literal list topP/topK, both allowlisted'],
  ['model-proxy-channel.mjs::options[key]', 'the daemon-side split writing a fresh wire object'],
]);

// ── The scanner (TypeScript's parser over the adapters' JavaScript) ─────────

/** Names that hold a send-options object wherever they appear, plus the 4th
 *  parameter of every `send` function or method, whatever it is called. */
const SEEDS = ['sendOpts', 'sendOptions', 'opts', 'options'];
const FALLBACK_OPERATORS = new Set([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);

/** Every key read off a send-options object in `text`: member reads,
 *  literal element reads, destructuring (declarations and `send` params,
 *  nested `session` patterns), through aliases (`const o = opts`,
 *  `opts || {}`, `{ ...opts }`, `...rest`, reassignment). An element read with
 *  a computed key is reported as dynamic. */
export function scanSendOptionReads(text, fileName = 'fixture.mjs') {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const aliases = new Set(SEEDS);
  const sessionAliases = new Set();
  let keys;
  let sessionKeys;
  let dynamic;
  const unwrap = (node) => {
    for (;;) {
      if (!node) return node;
      if (
        ts.isParenthesizedExpression(node) ||
        ts.isNonNullExpression(node) ||
        ts.isAwaitExpression(node) ||
        ts.isAsExpression(node)
      ) {
        node = node.expression;
      } else if (ts.isBinaryExpression(node) && FALLBACK_OPERATORS.has(node.operatorToken.kind)) {
        node = node.left;
      } else if (
        ts.isObjectLiteralExpression(node) &&
        node.properties[0] &&
        ts.isSpreadAssignment(node.properties[0])
      ) {
        node = node.properties[0].expression;
      } else {
        return node;
      }
    }
  };
  /** 'options' | 'session' | null: what an expression evaluates to. */
  const kindOf = (expression) => {
    const node = unwrap(expression);
    if (!node) return null;
    if (ts.isIdentifier(node)) {
      if (aliases.has(node.text)) return 'options';
      if (sessionAliases.has(node.text)) return 'session';
      return null;
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'session' && kindOf(node.expression) === 'options') {
      return 'session';
    }
    return null;
  };
  const read = (kind, key) => (kind === 'options' ? keys : sessionKeys).add(key);
  const alias = (kind, name) => (kind === 'options' ? aliases : sessionAliases).add(name);
  const bind = (pattern, kind) => {
    if (!ts.isObjectBindingPattern(pattern)) return;
    for (const element of pattern.elements) {
      if (element.dotDotDotToken) {
        if (ts.isIdentifier(element.name)) alias(kind, element.name.text);
        continue;
      }
      const property = element.propertyName ?? element.name;
      let key = null;
      if (ts.isIdentifier(property) || ts.isStringLiteral(property)) key = property.text;
      else if (ts.isComputedPropertyName(property) && ts.isStringLiteralLike(property.expression)) {
        key = property.expression.text;
      } else {
        dynamic.add(element.getText(source));
        continue;
      }
      read(kind, key);
      if (kind === 'options' && key === 'session') {
        if (ts.isIdentifier(element.name)) sessionAliases.add(element.name.text);
        else bind(element.name, 'session');
      }
    }
  };
  const sendFunctionName = (node) => {
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
      return node.name.text;
    }
    if ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && node.parent) {
      const owner = node.parent;
      if ((ts.isPropertyAssignment(owner) || ts.isVariableDeclaration(owner)) && ts.isIdentifier(owner.name)) {
        return owner.name.text;
      }
    }
    return null;
  };
  const visit = (node) => {
    if (ts.isFunctionLike(node) && sendFunctionName(node) === 'send' && node.parameters?.[3]) {
      const parameter = node.parameters[3].name;
      if (ts.isIdentifier(parameter)) aliases.add(parameter.text);
      else bind(parameter, 'options');
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const kind = kindOf(node.initializer);
      if (kind) {
        if (ts.isIdentifier(node.name)) alias(kind, node.name.text);
        else bind(node.name, kind);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const kind = kindOf(node.right);
      if (kind) alias(kind, node.left.text);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const kind = kindOf(node.expression);
      if (kind) read(kind, node.name.text);
    }
    if (ts.isElementAccessExpression(node)) {
      const kind = kindOf(node.expression);
      if (kind) {
        const argument = node.argumentExpression;
        if (ts.isStringLiteralLike(argument)) read(kind, argument.text);
        else dynamic.add(node.getText(source));
      }
    }
    ts.forEachChild(node, visit);
  };
  // Aliases can be declared after their first use in source order: walk
  // until no new alias appears; the last walk's reads are the answer.
  for (let pass = 0; pass < 8; pass += 1) {
    const before = aliases.size + sessionAliases.size;
    keys = new Set();
    sessionKeys = new Set();
    dynamic = new Set();
    visit(source);
    if (aliases.size + sessionAliases.size === before) break;
  }
  return { keys, sessionKeys, dynamic };
}

function adapterFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...adapterFiles(path));
    else if (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) out.push(path);
  }
  return out;
}

/** key → files reading it, session key → files, and `file::expression` dynamic reads. */
function scanAdapters() {
  const options = new Map();
  const session = new Map();
  const dynamic = new Set();
  const add = (map, key, file) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(file);
  };
  for (const path of adapterFiles(PROVIDERS)) {
    const file = relative(PROVIDERS, path).replace(/\\/g, '/');
    const found = scanSendOptionReads(readFileSync(path, 'utf8'), file);
    for (const key of found.keys) add(options, key, file);
    for (const key of found.sessionKeys) add(session, key, file);
    for (const expression of found.dynamic) dynamic.add(`${file}::${expression}`);
  }
  return { options, session, dynamic };
}

const { options: readKeys, session: readSessionKeys, dynamic: dynamicReads } = scanAdapters();

test('the scan sees the adapters (a broken scan must not pass vacuously)', () => {
  for (const key of [
    'effort',
    'toolChoice',
    'sessionId',
    'promptCacheKey',
    'onStageChange',
    'baseURL',
    'requestHeaders',
  ]) {
    assert.ok(readKeys.has(key), `scan no longer finds "${key}"`);
  }
  assert.ok(readSessionKeys.has('deferredToolCatalog'));
});

/** Allowlisted, dropped with a reason, or a known callback: true for any file. */
function classified(key) {
  if (/^on[A-Z]/.test(key)) return MODEL_PROXY_CALLBACKS.has(key);
  // `_`-prefixed keys are process-local seams: the daemon never sends them and
  // the PC allowlist has none.
  return MODEL_PROXY_SEND_OPTION_KEYS.has(key) || MODEL_PROXY_DROPPED_SEND_OPTIONS.has(key) || key.startsWith('_');
}

test('every send option or callback an adapter reads is classified, exemptions only for their file', () => {
  const unclassified = [];
  for (const [key, files] of readKeys) {
    if (classified(key)) continue;
    for (const file of files) if (!NOT_SEND_OPTIONS.has(`${file}::${key}`)) unclassified.push(`${file}::${key}`);
  }
  assert.deepEqual(
    unclassified.sort(),
    [],
    'Classify each in model-proxy-host.ts: allow it in MODEL_PROXY_SEND_OPTION_KEYS (callbacks: ' +
      'MODEL_PROXY_CALLBACKS with an argument projection), or drop it in MODEL_PROXY_DROPPED_SEND_OPTIONS ' +
      'with the reason; list `file::key` in NOT_SEND_OPTIONS only when that file reads a non-send-option object.'
  );
});

test('every computed read off send options is reviewed', () => {
  const unreviewed = [...dynamicReads].filter((entry) => !DYNAMIC_READS.has(entry));
  assert.deepEqual(unreviewed.sort(), [], 'Review each computed read and list it in DYNAMIC_READS with the reason.');
});

test('every session field an adapter reads crosses with the projected session', () => {
  const missing = [];
  for (const [key, files] of readSessionKeys) {
    if (MODEL_PROXY_SESSION_KEYS.has(key)) continue;
    for (const file of files) if (!NOT_PROJECTED_SESSION_READS.has(`${file}::${key}`)) missing.push(`${file}::${key}`);
  }
  assert.deepEqual(missing.sort(), []);
});

test('the classification lists stay disjoint, reasoned and current', () => {
  for (const key of MODEL_PROXY_DROPPED_SEND_OPTIONS.keys()) {
    assert.equal(MODEL_PROXY_SEND_OPTION_KEYS.has(key), false, `${key} is both allowed and dropped`);
    assert.ok(MODEL_PROXY_DROPPED_SEND_OPTIONS.get(key), `${key} needs a reason`);
  }
  for (const [entry, reason] of NOT_SEND_OPTIONS) {
    const [file, key] = entry.split('::');
    assert.equal(classified(key), false, `${entry} is classified; the exemption is not needed`);
    assert.ok(reason, `${entry} needs a reason`);
    assert.ok(readKeys.get(key)?.has(file), `${entry} is no longer read; remove it from NOT_SEND_OPTIONS`);
  }
  for (const [entry, reason] of NOT_PROJECTED_SESSION_READS) {
    const [file, key] = entry.split('::');
    assert.equal(MODEL_PROXY_SESSION_KEYS.has(key), false, `${entry} is projected; the exemption is not needed`);
    assert.ok(reason, `${entry} needs a reason`);
    assert.ok(readSessionKeys.get(key)?.has(file), `${entry} is no longer read; remove it from NOT_PROJECTED_SESSION_READS`);
  }
  for (const [entry, reason] of DYNAMIC_READS) {
    assert.ok(reason, `${entry} needs a reason`);
    assert.ok(dynamicReads.has(entry), `${entry} is no longer read; remove it from DYNAMIC_READS`);
  }
});

test('the scanner follows aliases, destructuring and session patterns, and flags computed reads', () => {
  const found = scanSendOptionReads(`
    function viaAlias(sendOpts) { const o = sendOpts; return o.aliasRead; }
    function viaFallback(opts) { const o2 = opts ?? {}; const o3 = (opts || null); return [o2.fallbackRead, o3?.orRead]; }
    function viaSpread(options) { const copy = { ...options, extra: 1 }; return copy.spreadRead; }
    function viaDestructure(opts) {
      const { plain, renamed: local, withDefault = 1, ['quoted']: q, session: { id }, ...rest } = opts;
      return rest.restRead;
    }
    class P {
      async send(messages, model, tools, settings) { return settings.namedFourthParam; }
    }
    const adapter = { send: async (m, model, tools, { destructuredParam, onTextDelta }) => onTextDelta };
    function viaReassign(opts) { let later; later = opts; return later.reassignedRead; }
    function viaSession(opts) {
      const session = opts.session || {};
      const { session: s2 } = opts;
      return [session.sessionField, s2.otherSessionField, opts.session?.directSessionField];
    }
    function literal(opts) { return opts['literalElement']; }
    function computed(opts, key) { return opts[key]; }
    function unrelated(config) { return config.notAnOption; }
    // opts.commentedOut
  `);
  for (const key of [
    'aliasRead',
    'fallbackRead',
    'orRead',
    'spreadRead',
    'plain',
    'renamed',
    'withDefault',
    'quoted',
    'session',
    'restRead',
    'namedFourthParam',
    'destructuredParam',
    'onTextDelta',
    'reassignedRead',
    'literalElement',
  ]) {
    assert.ok(found.keys.has(key), `missed ${key}`);
  }
  for (const key of ['id', 'sessionField', 'otherSessionField', 'directSessionField']) {
    assert.ok(found.sessionKeys.has(key), `missed session ${key}`);
  }
  assert.equal(found.keys.has('notAnOption'), false);
  assert.equal(found.keys.has('commentedOut'), false);
  assert.deepEqual([...found.dynamic], ['opts[key]']);
});

test('credential- and network-redirecting options never cross, legitimate ones do', () => {
  const sent = {
    baseURL: 'https://attacker.example/v1',
    requestHeaders: { authorization: 'Bearer x' },
    extraBody: { model: 'other' },
    auth: { token: 'x' },
    installationId: 'spoofed',
    codexInstallationId: 'spoofed',
    signal: 'not-a-signal',
    _fetchFn: 'seam',
    effort: 'high',
    toolChoice: 'auto',
    outputTokens: 1024,
    serverFallback: false,
    admissionOwner: 'session-a',
    session: { id: 's1', deferredToolCatalog: ['read'], apiKey: 'leak', baseURL: 'https://x', messages: ['big'] },
  };
  assert.deepEqual(serverSendOptions(sent), {
    effort: 'high',
    toolChoice: 'auto',
    outputTokens: 1024,
    serverFallback: false,
    admissionOwner: 'session-a',
    session: { id: 's1', deferredToolCatalog: ['read'] },
  });
});
