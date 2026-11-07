// Records the rows the Node call sites write when DRIVEN with stubbed inputs, for
// native/core/fixtures/agent-trace/sites-golden.json (same case format as builders-golden.json).
//
//   MIXDOG_REPO=<node tree> node record-agent-trace-sites.mjs <out.json>
//
// Sites that are exported run as they are. A site inside a private function or a closure runs from a
// MIRROR of `src/` in a temp directory (node_modules linked in) where the file is patched only to
// expose that function or closure (an `export`, or a `globalThis` assignment next to it); one
// dependency (the tool-result cache) is replaced by a stub in that mirror. The call-site code
// that builds the row is Node's own. The shared tree is never written. MIXDOG_DATA_DIR/HOME/APPDATA
// point at a temp dir set before any Mixdog module is imported; Date.now is fixed.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const T0 = 1700000000000;

if (process.argv[2] === '--child') {
  Date.now = () => T0;
  const repo = resolve(process.env.MIXDOG_REPO);
  const mirror = join(process.env.MIXDOG_DATA_DIR, '..', `mirror-${process.pid}`);
  mkdirSync(mirror, { recursive: true });
  cpSync(join(repo, 'src'), join(mirror, 'src'), { recursive: true });
  cpSync(join(repo, 'package.json'), join(mirror, 'package.json'));
  symlinkSync(join(repo, 'node_modules'), join(mirror, 'node_modules'), 'junction');
  const orchDir = join(mirror, 'src/runtime/agent/orchestrator');
  const patch = (rel, fn) => {
    const p = join(orchDir, rel);
    const before = readFileSync(p, 'utf8');
    const after = fn(before);
    if (after === before) throw new Error(`patch of ${rel} changed nothing`);
    writeFileSync(p, after);
  };
  const must = (text, needle) => {
    if (!text.includes(needle)) throw new Error(`mirror patch anchor missing: ${needle}`);
  };
  patch('session/send-with-recovery.mjs', (t) => `${t}\nexport { traceLoop as __traceLoop };\n`);
  patch('session/tool-batch/pre-dispatch.mjs', (t) => {
    must(t, 'function crossTurnStub(');
    return `${t.replace("from '../cache/tool-result-reuse.mjs'", "from '../../../../../../__stub-reuse.mjs'")}\nexport { crossTurnStub as __crossTurnStub };\n`;
  });
  writeFileSync(
    join(mirror, '__stub-reuse.mjs'),
    "export const lookupToolResultReuse = () => ({ kind: 'read', entry: { firstToolUseId: 'tu1' } });\n",
  );
  patch('providers/openai-oauth-dispatch.mjs', (t) => {
    const anchor = '  // A 401 is recoverable once per send';
    must(t, anchor);
    return t.replace(anchor, `  globalThis.__dispatch = { traceTransportError, get dispatchHttp() { return dispatchHttp; } };\n${anchor}`);
  });
  patch('session/loop/no-tool-turn.mjs', (t) => {
    const anchor = '  const ladder = {';
    must(t, anchor);
    return t.replace(anchor, `  globalThis.__noToolTrace = trace;\n${anchor}`);
  });

  const mod = (rel) => import(pathToFileURL(join(orchDir, rel)).href);
  const io = await mod('agent-trace-io.mjs');
  const watchdog = await mod('agent-runtime/agent-progress-watchdog.mjs');
  const dispatchMod = await mod('providers/openai-oauth-dispatch.mjs');
  const prepare = await mod('session/manager/ask-turn-prepare.mjs');
  const preDispatch = await mod('session/tool-batch/pre-dispatch.mjs');
  const wsWatchdogs = await mod('providers/openai-ws-watchdogs.mjs');
  const xai = await mod('providers/openai-compat-xai.mjs');
  const recovery = await mod('session/send-with-recovery.mjs');
  const noTool = await mod('session/loop/no-tool-turn.mjs');
  const cursor = await mod('providers/cursor-wire-stream-messages.mjs');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const traceFile = join(process.env.MIXDOG_DATA_DIR, 'history', 'agent-trace.jsonl');
  const read = () => {
    try {
      return readFileSync(traceFile, 'utf8');
    } catch {
      return '';
    }
  };

  const cases = [];
  // `rust(row)` gets the parsed row Node wrote and returns the builder input; values that only the
  // call site computes (byte counts, payload objects) are taken from it.
  const add = (name, builder, source, run, rust) => cases.push({ name, builder, source, run, rust });

  add('stall-abort', 'stall_abort', 'agent-runtime/agent-progress-watchdog.mjs:255', () =>
    watchdog.abortAgentProgressWatchdog(new AbortController(), {
      sessionId: 'sa', agent: 'w', error: new Error('stalled'), snapshot: { stage: 'send', lastProgressAt: T0 - 900000 }, policy: {}, now: T0, iteration: 2,
    }), () => ({ sessionId: 'sa', iteration: 2, agent: 'w', elapsed_ms: 900000, message: 'stalled', stage: 'send' }));

  const dispatchErr = {
    code: 'E', httpStatus: 0, wsCloseCode: 1006, retryClassifier: 'c', midstreamRetries: 2, liveTextEmitted: true,
    message: `${'x'.repeat(499)}😀tail`,
  };
  const makeDispatch = () => {
    dispatchMod.createOpenAiOAuthDispatch({
      provider: { _httpFallbackUntilByPoolKey: new Map(), _refreshModelCache() {} }, opts: { sessionId: 'pk' }, body: {}, authState: { tokens: {} },
      poolKey: 'pk', cacheKey: 'ck', iteration: 1, useModel: 'm', externalSignal: null, sendWs: async () => ({}), sendHttp: async () => ({}),
      startedAt: T0, httpFallbackEnabled: true,
    });
    return globalThis.__dispatch;
  };
  add('transport-error', 'transport_error', 'providers/openai-oauth-dispatch.mjs:118', () =>
    makeDispatch().traceTransportError({ ...dispatchErr }, 'connect', 'websocket'),
  () => ({
    sessionId: 'pk', iteration: 1, model: 'm', transport: 'websocket', stage: 'connect', error_code: 'E', error_http_status: 0,
    error_ws_close_code: 1006, error_classifier: 'c', ws_retries: 2, live_text_emitted: true, message: dispatchErr.message,
  }));
  add('oauth-fallback', 'transport_fallback', 'providers/openai-oauth-dispatch.mjs:153', async () => {
    try {
      await makeDispatch().dispatchHttp('ws_failed', { code: 'X', httpStatus: 426, midstreamClassifier: 'mc' });
    } catch {}
  }, () => ({
    sessionId: 'pk', iteration: 1, provider: 'openai-oauth', model: 'm', transport: 'http', from: 'websocket', to: 'http', reason: 'ws_failed',
    error_code: 'X', error_http_status: 426, error_classifier: 'mc',
  }));
  add('context', 'context', 'session/manager/ask-turn-prepare.mjs:273', () =>
    prepare.traceTurnContext({
      sessionId: 'cx', session: { model: 'm', provider: 'p' }, context: 'abc', explicitPrefetchResult: 'xy', prompt: 'hello',
      userTurnContent: 'hello world', historyMessages: [{ role: 'user', content: 'a' }],
    }), (row) => ({ sessionId: 'cx', model: 'm', provider: 'p', totalBytes: row.totalBytes, breakdown: row.breakdown }));
  add('steer', 'steer', 'session/tool-batch/pre-dispatch.mjs:83', () => {
    const batch = {
      sessionId: 'st', iterations: 5, sessionAgent: 'w', dedupStubTotal: 0, cwd: process.cwd(), sessionRef: null,
      crossTurnCalls: new Map([['sig', { firstIteration: 2, count: 1, toolUseId: 'tu1' }]]),
    };
    preDispatch.__crossTurnStub(batch, { id: 'c1', name: 'read', arguments: { path: '/a' } }, 'sig');
  }, (row) => ({ sessionId: 'st', iteration: 5, payload: row.payload, agent: 'w' }));
  add('ws-timeout', 'ws_timeout', 'providers/openai-ws-watchdogs.mjs:66', async () => {
    const dogs = wsWatchdogs.createWsStreamWatchdogs({
      midState: { sessionId: 'ws1', iteration: 3, attemptIndex: 1, sawResponseCreated: true, model: 'gpt', traceProvider: 'openai-oauth' },
      traceProvider: 'openai-oauth', streamingStart: T0 - 500, currentModel: () => 'gpt',
      timeouts: { preResponseCreatedMs: 0, firstMeaningfulMs: 0, interChunkMs: 5, semanticIdleMs: 0, semanticIdleEnabled: false },
      firstOutput: { outputSeen: false, timeoutMs: 0, arm() {}, clear() {}, noteOutput() {} }, attachPartialState: (e) => e, fail() {},
    });
    dogs.resetIdle();
    await sleep(60);
    dogs.clearAll();
  }, (row) => ({ sessionId: 'ws1', iteration: 3, payload: row.payload }));
  add('cache-context', 'cache_context', 'providers/openai-compat-xai.mjs:564', () => {
    process.env.MIXDOG_XAI_CACHE_TRACE = '1';
    xai.traceXaiResponsesCacheContext({
      model: 'grok', opts: { sessionId: 'xc', iteration: 1 }, params: { instructions: 'be brief', prompt_cache_key: 'k', input: [] }, rawTools: [],
      response: { usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 8 } } }, cacheRouting: null,
      previousResponseId: null, inputStartIndex: 0, continuationResetReason: null, transport: 'http', cacheLane: null,
    });
  }, (row) => ({ sessionId: 'xc', iteration: 1, payload: row.payload }));
  add('trace-loop', 'trace_loop', 'session/send-with-recovery.mjs:317', () =>
    recovery.__traceLoop({ sessionId: '', nextIteration: 2 }, 'retry', { attempt: 1 }),
  () => ({ kind: 'retry', sessionId: '', iteration: 2, fields: { attempt: 1 } }));
  add('no-tool', 'no_tool', 'session/loop/no-tool-turn.mjs:102', () => {
    noTool.createNoToolTurnResolver({ messages: [], opts: {}, sessionId: 'nt', sessionAgent: 'w', drainSteering: () => [] });
    globalThis.__noToolTrace(3, 'provider_continuation', { signal: 's', count: 1 });
  }, () => ({ sessionId: 'nt', iteration: 3, kind: 'provider_continuation', payload: { signal: 's', count: 1 }, agent: 'w' }));
  add('cursor-unknown', 'cursor_unknown_field', 'providers/cursor-wire-stream-messages.mjs (traceUnknownFields)', () => {
    try {
      cursor.processServerMessage(Uint8Array.from([0x98, 0x06, 0x01]), { state: {}, filter: {}, emit() {}, conversation: {}, tools: [], cloudRule: null, bridge: {}, sessionId: 'cu' });
    } catch {}
  }, (row) => ({ sessionId: 'cu', payload: row.payload }));

  const results = [];
  const lines = [];
  for (const c of cases) {
    const before = read();
    await c.run();
    await io.drainAgentTrace();
    const added = read().slice(before.length).trimEnd();
    if (!added) throw new Error(`${c.name}: the driven call site wrote no row`);
    if (added.split('\n').length !== 1) throw new Error(`${c.name}: expected one row, got ${added.split('\n').length}`);
    lines.push(added);
    results.push({ name: c.name, builder: c.builder, how: 'driven', source: c.source, rust: c.rust(JSON.parse(added)), emits: true });
  }
  writeFileSync(process.argv[3], `${JSON.stringify({ note: 'recorded by benchmarks/rust-core/recorders/record-agent-trace-sites.mjs by driving the Node call sites', now: T0, cases: results, jsonl: `${lines.join('\n')}\n` }, null, 1)}\n`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'agent-trace-sites-'));
const data = join(dir, 'data');
mkdirSync(data);
const env = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  MIXDOG_REPO: process.env.MIXDOG_REPO,
  MIXDOG_DATA_DIR: data,
  HOME: dir,
  USERPROFILE: dir,
  APPDATA: dir,
  LOCALAPPDATA: dir,
  MIXDOG_DIAGNOSTICS: '1',
  MIXDOG_QUIET_MEMORY_LOG: '1',
};
const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', process.argv[2]], { env, encoding: 'utf8' });
rmSync(dir, { recursive: true, force: true });
if (run.status !== 0) throw new Error(`child failed: ${run.stderr || run.stdout}`);
