#!/usr/bin/env node
// Corpus of the inputs the clients send to the core (x-client-input-corpus).
//
//   node scripts/collect-client-inputs.mjs --check   re-derive the methods each client sends; fail on a method without a row
//   node scripts/collect-client-inputs.mjs --write   regenerate the fixture from the protocol schema and the edge rows below
//
// Fixture: native/core/crates/mixdog-app-protocol/src/boundary/validate/fixtures/clients-accepted.json
//   [{ client: "tui"|"phone"|"protocol-client"|"desktop", method, params, source: "file:symbol", case? }]
// Every row is an input a client sends today and the core must accept: the Rust validators (s2a-core-val-*) and the
// TypeScript parity replay it. `params` is absent for a notification the protocol gives no params (`initialized`).
//
// Where the rows come from: the method list of each client is re-derived from its sender files (`SENDERS`: a literal
// method name that the protocol's method table lists) and from the session actions of packages/protocol-client
// (`SESSION_ACTIONS` resolved by `resolveAction`, the function the clients call). The param shapes come from the
// protocol's JSON schema (schema/client_request.json, client_notification.json), so a row is schema-valid by
// construction (`validate` below re-checks every row on --check); `EDGES` adds the shapes a schema example does not
// show: null against absent, unicode, a prompt at the inbound frame limit, attachments, every window and kind.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROTOCOL_DIR = 'native/core/crates/mixdog-app-protocol';
const FIXTURE = `${PROTOCOL_DIR}/src/boundary/validate/fixtures/clients-accepted.json`;
const CLIENTS = ['tui', 'phone', 'protocol-client', 'desktop'];

/** Sender files per client: [directory or file, file-name filter]. Tests, recorders and fixtures are not senders. */
const NOT_SENDER = /(\.test\.|\.record\.|\.scenario\.|[/\\]tests?[/\\]|[/\\]fixtures?[/\\]|[/\\]mock\.|\.d\.m?ts$|\.generated\.)/;
const SENDERS = {
  tui: [
    ['native/core/crates/mixdog-cli/src', /\.rs$/],
    ['native/core/crates/mixdog-app-server-client/src', /\.rs$/],
  ],
  phone: [
    ['apps/mobile/src', /\.ts$/],
    ['apps/desktop/src/renderer', /^remote-.*\.(ts|tsx)$/],
    ['apps/desktop/src/shared/core-lanes/service-route.ts', null],
    ['apps/desktop/src/shared/core-lanes/capability-route.ts', null],
  ],
  'protocol-client': [['packages/protocol-client/src/client.ts', null]],
  desktop: [
    ['apps/desktop/src/main', /\.(ts|tsx)$/],
    ['apps/desktop/src/renderer', /\.(ts|tsx)$/],
    ['apps/desktop/src/shared/core-lanes', /\.(ts|tsx)$/],
  ],
};

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

function filesOf([entry, filter]) {
  const abs = path.join(ROOT, entry);
  if (!fs.existsSync(abs)) throw new Error(`sender path missing: ${entry}`);
  if (fs.statSync(abs).isFile()) return [entry];
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(rel);
      } else if (filter.test(e.name) && !NOT_SENDER.test(rel)) out.push(rel);
    }
  };
  walk(entry);
  return out;
}

// ── protocol schema ──

const requestSchema = readJson(`${PROTOCOL_DIR}/schema/client_request.json`);
const notificationSchema = readJson(`${PROTOCOL_DIR}/schema/client_notification.json`);

/** method -> { kind: 'request'|'notification', defs, params: schema | null } */
const METHODS = new Map();
for (const [kind, doc] of [['request', requestSchema], ['notification', notificationSchema]]) {
  for (const o of doc.oneOf) {
    const method = o.properties.method.enum[0];
    METHODS.set(method, { kind, defs: doc.definitions, params: o.properties.params ?? null });
  }
}

const deref = (defs, s) => {
  let cur = s;
  while (cur && cur.$ref) cur = defs[cur.$ref.replace('#/definitions/', '')];
  return cur ?? {};
};

const typesOf = (s) => (Array.isArray(s.type) ? s.type : s.type ? [s.type] : []);
const isNullable = (defs, s) => {
  s = deref(defs, s);
  if (typesOf(s).includes('null')) return true;
  return [...(s.anyOf ?? []), ...(s.oneOf ?? [])].some((b) => typesOf(deref(defs, b)).includes('null'));
};

/** Validates `v` against the schema the way serde reads it: enough of draft-07 for the protocol's schemas. */
function validate(defs, schema, v, at = '$') {
  if (schema === true || schema === undefined) return [];
  schema = deref(defs, schema);
  const branches = schema.anyOf ?? schema.oneOf;
  if (branches) {
    const fails = branches.map((b) => validate(defs, b, v, at));
    return fails.some((f) => f.length === 0) ? [] : [`${at}: matches no branch (${fails.map((f) => f[0]).join(' | ')})`];
  }
  if (schema.enum) return schema.enum.includes(v) ? [] : [`${at}: ${JSON.stringify(v)} is not one of ${schema.enum.join(',')}`];
  const types = typesOf(schema);
  if (v === null) return types.length === 0 || types.includes('null') ? [] : [`${at}: null`];
  if (types.length === 0) return [];
  const t = Array.isArray(v) ? 'array' : typeof v;
  const okType = types.some((x) => x === t || (x === 'integer' && Number.isInteger(v)) || (x === 'number' && t === 'number'));
  if (!okType) return [`${at}: ${t} where ${types.join('|')}`];
  const errs = [];
  if (typeof v === 'number' && schema.minimum !== undefined && v < schema.minimum) errs.push(`${at}: below minimum`);
  if (t === 'array') {
    if (schema.minItems !== undefined && v.length < schema.minItems) errs.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems} items`);
    v.forEach((x, i) => errs.push(...validate(defs, schema.items, x, `${at}[${i}]`)));
  } else if (t === 'object') {
    for (const k of schema.required ?? []) if (!(k in v)) errs.push(`${at}.${k}: required`);
    for (const [k, x] of Object.entries(v)) {
      if (schema.properties && k in schema.properties) errs.push(...validate(defs, schema.properties[k], x, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}.${k}: not allowed`);
      else if (schema.additionalProperties && schema.additionalProperties !== true) errs.push(...validate(defs, schema.additionalProperties, x, `${at}.${k}`));
    }
  }
  return errs;
}

// ── schema -> example ──

const OP_ID = (n) => `0190f3c2-7a31-7c00-8000-${String(n).padStart(12, '0')}`;
/** A blob digest the core deserializes (`BlobDigest`: `sha256:` and 64 lowercase hex digits); the schema only says string. */
const DIGEST = `sha256:${'0'.repeat(64)}`;
let opCounter = 0;

/** A value the schema accepts. `full` includes every optional property except the host-only ones (a connection's request
 *  carrying one is `invalidParams`). */
const CYCLE = Symbol('cycle');

function example(defs, schema, full, name = '', stack = []) {
  if (schema && schema.$ref) {
    if (stack.includes(schema.$ref)) return CYCLE;
    stack = [...stack, schema.$ref];
  }
  schema = deref(defs, schema);
  if (schema.enum) return schema.enum[0];
  const branches = schema.anyOf ?? schema.oneOf;
  if (branches) {
    for (const b of branches.filter((x) => deref(defs, x).type !== 'null')) {
      const v = example(defs, b, full, name, stack);
      if (v !== CYCLE) return v;
    }
    return CYCLE;
  }
  const types = typesOf(schema).filter((t) => t !== 'null');
  const t = types[0];
  if (!t) return {};
  if (t === 'string') return name === 'opId' ? OP_ID(++opCounter) : name === 'digest' ? DIGEST : `${name || 'text'}-1`;
  if (t === 'integer') return Math.max(1, schema.minimum ?? 1);
  if (t === 'number') return 1;
  if (t === 'boolean') return true;
  if (t === 'array') {
    if (schema.items === undefined || schema.items === true) return [{}];
    const item = example(defs, schema.items, full, name, stack);
    return item === CYCLE ? [] : Array.from({ length: Math.max(1, schema.minItems ?? 1) }, () => item);
  }
  if (t === 'object') {
    const out = {};
    if (schema.properties) {
      const req = new Set(schema.required ?? []);
      for (const [k, p] of Object.entries(schema.properties)) {
        const hostOnly = /host-only/i.test(`${p.description ?? ''} ${deref(defs, p).description ?? ''}`);
        if (!req.has(k) && (!full || hostOnly)) continue;
        const v = example(defs, p, full, k, stack);
        if (v !== CYCLE) out[k] = v;
      }
    } else if (schema.additionalProperties && schema.additionalProperties !== true) {
      const v = example(defs, schema.additionalProperties, full, name, stack);
      if (v !== CYCLE) out.key = v;
    }
    return out;
  }
  return {};
}

function paramsExample(method, full) {
  const m = METHODS.get(method);
  if (!m.params) return undefined;
  const v = example(m.defs, m.params, full, '', []);
  return v === CYCLE ? {} : v;
}

function validateRow(row) {
  const m = METHODS.get(row.method);
  if (!m) return [`method ${row.method} is not in the protocol's client method table`];
  if (!m.params) return row.params === undefined ? [] : ['params given for a method without params'];
  return validate(m.defs, m.params, row.params);
}

// ── session actions (packages/protocol-client) ──

const ACTION_ROUTE = 'packages/protocol-client/src/actions';
const OVERRIDE_ARGS = {
  // today's positional arguments of the actions whose method or params are not the verbatim form
  clear: [],
  compact: [{ mode: 'manual' }],
  rewindToItem: ['item-1', { restoreFiles: false }],
  renameSessionTitle: ['thread-1', 'Renamed'],
  deleteSession: ['thread-1'],
  deleteSessionIfIdle: ['thread-1', true],
  stopShellJob: ['task-1'],
  releaseShellJob: ['task-1'],
  stopShellJobs: [],
  scheduleQuotaResume: ['thread-1'],
  cancelQuotaResume: ['thread-1'],
  retryFailedTurn: ['thread-1', 'turn-1'],
  continueSessionInModel: ['thread-1', { provider: 'p', model: 'm' }],
  inheritFrom: ['thread-2', { compact: true }],
  goalControl: [{ action: 'set', objective: 'ship it' }],
  listProviderModels: [{ providerId: 'p' }],
  setFast: [true],
  setRoute: [{ provider: 'p', model: 'm' }],
};

/** Argument values a client sends where the schema says only "string" or "integer" and the core (like the desktop's
 *  ipc-validation.ts before it) takes a fixed vocabulary or range: a placeholder there is an input no client sends. */
const SAMPLE_ARGS = {
  setInstructionFiles: { mode: 'all' },
  setHeartbeatInterval: { minutes: 30 },
  setAutoEffortBase: { level: 'medium' },
  setBuiltinToolEnabled: { name: 'git' },
  installBuiltinFeature: { name: 'tidy', options: { engines: ['ruff'] } },
  setNetworkProxy: { patch: { mode: 'system' } },
  setMediaAssetBoard: { boardId: 'board-1' },
  saveProviderApiKey: { providerId: 'vertex-ai', options: { authMode: 'api-key' } },
  saveCustomProviderKey: { providerId: 'custom-0190f3c2-7a31-7c00-8000-000000000001' },
  startLocalProviderInstallation: { phase: 'model' },
  discardLocalProviderInstallation: { phase: 'model' },
  setLocalProviderContext: { tokens: 16384 },
  startLocalProviderModelMaintenance: { operation: 'verify' },
};

async function sessionActionRows() {
  const { SESSION_ACTIONS, resolveAction } = await import(pathToFileURL(path.join(ROOT, ACTION_ROUTE, 'action-route.mjs')).href);
  const { ACTION_OVERRIDES } = await import(pathToFileURL(path.join(ROOT, ACTION_ROUTE, 'action-overrides.mjs')).href);
  const { METHOD_ARGS } = await import(pathToFileURL(path.join(ROOT, ACTION_ROUTE, 'method-args.generated.mjs')).href);
  const { ACTION_NAMESPACES } = await import(pathToFileURL(path.join(ROOT, ACTION_ROUTE, 'action-namespaces.mjs')).href);
  const namespaceOf = new Map(Object.entries(ACTION_NAMESPACES).flatMap(([ns, actions]) => actions.map((a) => [a, ns])));
  const ctx = { threadId: 'thread-1' };
  const out = [];
  const problems = [];
  const unrouted = [];
  for (const action of SESSION_ACTIONS) {
    let args;
    if (ACTION_OVERRIDES[action]) args = OVERRIDE_ARGS[action];
    else {
      const method = `${namespaceOf.get(action)}/${action}`;
      const spec = METHOD_ARGS[method];
      const m = METHODS.get(method);
      if (!spec || !m) {
        // the client itself answers this action with `unknownMethod` before anything is sent: no input to accept
        unrouted.push(action);
        continue;
      }
      const props = deref(m.defs, m.params).properties ?? {};
      args = spec.args.map((a) => {
        if (SAMPLE_ARGS[action] && a in SAMPLE_ARGS[action]) return SAMPLE_ARGS[action][a];
        const v = props[a] ? example(m.defs, props[a], true, a) : undefined;
        return v === CYCLE ? undefined : v;
      });
    }
    if (args === undefined) {
      problems.push(`session action ${action}: no sample arguments (OVERRIDE_ARGS)`);
      continue;
    }
    const { method, params } = resolveAction(action, args, ctx);
    const m = METHODS.get(method);
    if (!m) {
      problems.push(`session action ${action}: method ${method} is not in the protocol's method table`);
      continue;
    }
    const mutation = deref(m.defs, m.params).required?.includes('opId');
    out.push({
      client: 'protocol-client',
      method,
      params: mutation ? { ...params, opId: OP_ID(++opCounter) } : params,
      source: `${ACTION_OVERRIDES[action] ? `${ACTION_ROUTE}/action-overrides.mjs` : `${ACTION_ROUTE}/action-namespaces.mjs`}:${action}`,
      case: `session action ${action}`,
    });
  }
  return { rows: out, problems, unrouted };
}

// ── what each client sends today ──

const QUOTE = '[\'"`]';
function literalsIn(text) {
  const found = new Set();
  for (const m of text.matchAll(new RegExp(`${QUOTE}([a-z][A-Za-z0-9]*(?:/[A-Za-z0-9]+)+)${QUOTE}`, 'g'))) if (METHODS.has(m[1])) found.add(m[1]);
  // a method without a namespace (`initialize`, `initialized`) only where it is the method of a call
  for (const m of text.matchAll(new RegExp(`(?:rpc|rpc_inline|call|run|request|notify|send)[A-Za-z_]*\\(\\s*\\{?\\s*(?:method:\\s*)?${QUOTE}([a-z][A-Za-z0-9]*)${QUOTE}|method\\s*[:=]\\s*${QUOTE}([a-z][A-Za-z0-9]*)${QUOTE}`, 'g'))) {
    const name = m[1] ?? m[2];
    if (METHODS.has(name)) found.add(name);
  }
  return found;
}

/** client -> method -> source ("file:method") of the first sender file naming it. */
function derivedSenders() {
  const out = Object.fromEntries(CLIENTS.map((c) => [c, new Map()]));
  for (const client of CLIENTS) {
    for (const spec of SENDERS[client]) {
      for (const file of filesOf(spec)) {
        for (const method of literalsIn(read(file))) if (!out[client].has(method)) out[client].set(method, `${file}:${method}`);
      }
    }
  }
  return out;
}

// ── edge rows ──

const LONG_PROMPT = `${'Refactor the module and explain every step. '.repeat(5600)}END`.slice(0, 250_000);
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const TURN = { threadId: 'thread-1', opId: OP_ID(900) };
const UNICODE_PROMPT = '안녕하세요, 이 파일을 고쳐 주세요 \u{1F680}\u{1F468}\u200D\u{1F469}\u200D\u{1F467} é ñ \u202Eabc\u202C \u0000'.replace('\u0000', '\u00a0');

const EDGES = [
  // turn/start: the prompt in each form the TUI, the phone composer and the desktop composer send
  ['phone', 'turn/start', 'prompt string', { ...TURN, input: { prompt: 'fix the failing test' } }],
  ['phone', 'turn/start', 'options null', { ...TURN, input: { prompt: 'hello', options: null } }],
  ['phone', 'turn/start', 'options empty', { ...TURN, input: { prompt: 'hello', options: {} } }],
  ['phone', 'turn/start', 'unicode prompt', { ...TURN, input: { prompt: UNICODE_PROMPT } }],
  ['desktop', 'turn/start', 'prompt at the inbound frame limit', { ...TURN, input: { prompt: LONG_PROMPT } }],
  ['desktop', 'turn/start', 'multi-line prompt', { ...TURN, input: { prompt: 'line one\r\nline two\n\n\tindented\n' } }],
  ['phone', 'turn/start', 'parts: text, image, file', {
    ...TURN,
    input: {
      prompt: [
        { type: 'text', text: 'what is in this picture and file?' },
        { type: 'image', mimeType: 'image/png', data: PNG_1PX, filename: 'shot.png', sizeBytes: 70 },
        { type: 'file', mimeType: 'text/plain', data: 'aGVsbG8=', filename: 'a.txt', sizeBytes: 5 },
      ],
    },
  }],
  ['desktop', 'turn/start', 'parts: stored attachments by reference', {
    ...TURN,
    input: {
      prompt: [
        { type: 'text', attachmentRef: 'att-1', textKind: 'paste', filename: 'paste.txt', mimeType: 'text/plain', sizeBytes: 90000 },
        { type: 'image', attachmentRef: 'att-2', mimeType: 'image/jpeg', data: null },
        { type: 'text', text: null },
      ],
    },
  }],
  ['desktop', 'turn/start', 'submit options', {
    ...TURN,
    input: {
      prompt: 'queued follow-up',
      options: {
        clientSubmissionId: 'sub-1', displayText: 'queued follow-up', goalCommand: null, kickoff: false, priority: 'next',
        retryFailedTurn: true, retryTurnId: 'turn-9', retryAttemptId: 'att-9', submittedAt: 1_760_000_000_000,
        pastedTexts: { '[Pasted text #1]': { id: 1, text: 'pasted', chars: 6, source: 'clipboard' } },
        pastedImages: { '[Image #1]': { id: 1, type: 'image', mediaType: 'image/png', filename: null, content: PNG_1PX } },
      },
    },
  }],
  ['tui', 'turn/start', 'priority now', { ...TURN, input: { prompt: 'stop and do this', options: { priority: 'now' } } }],
  ['tui', 'turn/start', 'priority later', { ...TURN, input: { prompt: 'when idle', options: { priority: 'later' } } }],
  // thread/start
  ...['project', 'projectTask', 'task', 'control'].map((kind) => ['desktop', 'thread/start', `kind ${kind}`, { kind, opId: OP_ID(910) }]),
  ['phone', 'thread/start', 'project path null', { kind: 'task', projectPath: null, opId: OP_ID(911) }],
  ['phone', 'thread/start', 'initial input null', { kind: 'task', initialInput: null, draft: null, session: null, opId: OP_ID(912) }],
  ['desktop', 'thread/start', 'initial input and project path', {
    kind: 'projectTask', projectPath: 'C:\\Users\\dev\\project', opId: OP_ID(913),
    initialInput: { prompt: '프로젝트 구조를 설명해 줘' },
  }],
  ['tui', 'thread/start', 'headless exec session', {
    kind: 'task', opId: OP_ID(914),
    session: { approvalMode: 'implicit', toolMode: 'readonly', toolProfile: 'headless', autoWakeCompletions: false, disallowDelegation: true, memory: false, webSearch: false },
  }],
  ['tui', 'thread/start', 'headless exec, every option null', {
    kind: 'task', opId: OP_ID(915),
    session: { approvalMode: null, toolMode: null, toolProfile: null, autoWakeCompletions: null, disallowDelegation: null, memory: null, webSearch: null },
  }],
  // thread/resume windows
  ['protocol-client', 'thread/resume', 'window lastItems max', { threadId: 'thread-1', window: { lastItems: 512 } }],
  ['protocol-client', 'thread/resume', 'window lastTurns', { threadId: 'thread-1', window: { lastTurns: 8 } }],
  ['phone', 'thread/resume', 'window none', { threadId: 'thread-1', window: { none: true } }],
  ['protocol-client', 'thread/resume', 'resume from position', {
    threadId: 'thread-1', window: { lastItems: 64 }, resumeFrom: { epoch: 'e-1', seq: 0, window: { lastItems: 64 } },
  }],
  ['protocol-client', 'thread/resume', 'resumeFrom null', { threadId: 'thread-1', window: { lastTurns: 2 }, resumeFrom: null }],
  // feeds
  ['protocol-client', 'app/subscribe', 'no resume position', {}],
  ['protocol-client', 'app/subscribe', 'resumeFrom null', { resumeFrom: null }],
  ['protocol-client', 'app/subscribe', 'resume position', { resumeFrom: { epoch: 'e-1', seq: 41 } }],
  ['phone', 'feed/subscribe', 'resumeFrom null', { feedId: 'login:flow-1', resumeFrom: null }],
  ['phone', 'feed/subscribe', 'resume position', { feedId: 'media:job-1', resumeFrom: { epoch: 'e-2', seq: 0 } }],
  // op status and blobs
  ['protocol-client', 'op/status', 'no ids, no fence', { scope: 'thread:thread-1', opIds: [], fence: false }],
  ['protocol-client', 'op/status', 'several ids, fenced', { scope: 'domain:config', opIds: [OP_ID(920), OP_ID(921)], fence: true }],
  ['protocol-client', 'blob/read', 'offset and length null', { digest: DIGEST, offset: null, length: null }],
  ['protocol-client', 'blob/read', 'page at an offset', { digest: DIGEST, offset: 262144, length: 65536 }],
  ['protocol-client', 'blob/put', 'first chunk', { digest: DIGEST, offset: 0, bytesB64: 'AAAA' }],
  ['protocol-client', 'blob/put', 'empty last chunk', { digest: DIGEST, offset: 3, bytesB64: '' }],
  // initialize: every client kind, capabilities absent against null
  ['tui', 'initialize', 'tui, no capabilities', { clientInfo: { kind: 'tui', name: 'mixdog-tui', version: '0.0.0' } }],
  ['tui', 'initialize', 'cli, capabilities null', { clientInfo: { kind: 'cli', name: 'mixdog-exec', version: '0.0.0', title: null, build: null }, capabilities: null }],
  ['phone', 'initialize', 'phone', {
    clientInfo: { kind: 'phone', name: 'mixdog-phone', title: 'Phone', version: '0.0.0', build: '1' },
    capabilities: { approvalsInbox: true, feedRanges: true, optOutNotificationMethods: ['thread/tokenUsage/updated'] },
  }],
  ['phone', 'initialize', 'remote desktop', { clientInfo: { kind: 'remoteDesktop', name: 'mixdog-desktop', version: '0.0.0' }, capabilities: { optOutNotificationMethods: [] } }],
  ['desktop', 'initialize', 'desktop, every capability null', {
    clientInfo: { kind: 'desktop', name: 'mixdog-desktop', version: '0.0.0' },
    capabilities: { approvalsInbox: null, experimentalApi: null, feedRanges: null, host: null, modelProxy: null, optOutNotificationMethods: null },
  }],
  ['protocol-client', 'initialize', 'channel bridge', { clientInfo: { kind: 'channelBridge', name: 'bridge', version: '0.0.0' }, capabilities: { modelProxy: true, experimentalApi: false } }],
];

// ── the fixture ──

function edgeRows(derived) {
  return EDGES.map(([client, method, label, params]) => ({
    client,
    method,
    params,
    source: derived[client].get(method) ?? `edge:${method}`,
    case: label,
  }));
}

async function buildRows() {
  const derived = derivedSenders();
  const { rows: actionRows, problems, unrouted } = await sessionActionRows();
  const rows = [];
  const seen = new Set();
  const push = (r) => {
    const key = `${r.client}\0${r.method}\0${r.case}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(r);
  };
  for (const client of CLIENTS) {
    for (const [method, source] of derived[client]) {
      const params = paramsExample(method, false);
      push({ client, method, ...(params === undefined ? {} : { params }), source, case: 'required fields' });
    }
  }
  // one row with every optional field for each method, under the first client that sends it
  const fullDone = new Set();
  for (const client of CLIENTS) {
    for (const [method, source] of derived[client]) {
      if (fullDone.has(method) || !METHODS.get(method).params) continue;
      fullDone.add(method);
      push({ client, method, params: paramsExample(method, true), source, case: 'every optional field' });
    }
  }
  for (const r of actionRows) push(r);
  for (const r of edgeRows(derived)) push(r);
  return { rows, problems, unrouted };
}

function checkRows(rows) {
  const errors = [];
  for (const [i, r] of rows.entries()) {
    const at = `row ${i} (${r.client} ${r.method}${r.case ? `, ${r.case}` : ''})`;
    if (!CLIENTS.includes(r.client)) errors.push(`${at}: unknown client`);
    for (const e of validateRow(r)) errors.push(`${at}: ${e}`);
    const [file, ...sym] = String(r.source).split(':');
    const symbol = sym.join(':');
    if (file === 'edge') continue;
    if (!fs.existsSync(path.join(ROOT, file))) errors.push(`${at}: source file ${file} is missing`);
    else if (!read(file).includes(symbol)) errors.push(`${at}: ${file} does not contain ${symbol}`);
  }
  return errors;
}

async function main() {
  const mode = process.argv.includes('--write') ? 'write' : 'check';
  if (mode === 'write') {
    const { rows, problems, unrouted } = await buildRows();
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    const errors = checkRows(rows);
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(path.join(ROOT, FIXTURE)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, FIXTURE), `${JSON.stringify(rows, null, 2)}\n`);
    console.log(`wrote ${rows.length} rows to ${FIXTURE}; ${unrouted.length} session actions have no protocol method (the client rejects them before sending)`);
    return;
  }
  const rows = readJson(FIXTURE);
  const errors = checkRows(rows);
  const derived = derivedSenders();
  const { rows: actionRows, problems } = await sessionActionRows();
  const have = new Set(rows.map((r) => `${r.client}\0${r.method}`));
  const missing = [];
  for (const client of CLIENTS) for (const method of derived[client].keys()) if (!have.has(`${client}\0${method}`)) missing.push(`${client} ${method}`);
  for (const r of actionRows) if (!have.has(`${r.client}\0${r.method}`)) missing.push(`${r.client} ${r.method} (session action)`);
  const perClient = CLIENTS.map((c) => `${c} ${new Set(rows.filter((r) => r.client === c).map((r) => r.method)).size}`).join(', ');
  console.log(`rows: ${rows.length}; methods per client: ${perClient}`);
  for (const line of [...problems, ...errors, ...missing.map((m) => `missing: ${m}`)]) console.error(line);
  console.log(`${missing.length} missing, ${errors.length + problems.length} invalid`);
  if (missing.length || errors.length || problems.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
