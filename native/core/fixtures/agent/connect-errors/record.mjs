// Records what Node does with a provider call that fails before any response byte arrives, end to end through the real
// `OpenAICompatProvider.send` (an unprofiled `custom` provider on the `openai-chat` protocol, the harness's provider) and
// the agent loop's `sendWithRecovery` + `applyRetryAction` retry driver:
//
//   node native/core/fixtures/agent/connect-errors/record.mjs --tree D:\mixdog-build\tmp\real-turn-harness\node-tree
// (a Node tree with its `node_modules`, like the other recorders)
//
// Cases, each against a real socket:
//   refused    a loopback port nobody listens on (ECONNREFUSED)
//   dns        a name that does not resolve (`.invalid`, ENOTFOUND)
//   reset      a server that accepts, reads the request and resets the socket before any header (ECONNRESET)
//   badPort    `127.0.0.1:9`: fetch refuses the port itself ("bad port", no errno), so nothing connects
//   cut        a server that answers 200 with an event stream (one comment, nothing reaches the user) and resets the
//              socket after the headers, every time: repeated post-header cuts, the stream-retry budget across replays
//   cutRole    the same with a first chunk that carries only the assistant role (a model event, nothing shown)
//
// `--only cut` records the two cut cases alone into the existing golden (the port scan of `badPorts` is slow).
// `--only probes` records `probes` alone: what the settings page's two custom-provider probes show for the same
// endpoints (refused, badPort, dns), through the real `discoverCustomProviderModels` and `testCustomProvider` of
// `provider-admin.mjs` with a stub config module: the discovery error view (`discoveryErrorView` + `sanitizeCustomError`,
// a raw `fetch` => "fetch failed"), the connection test that gets as far as discovery (its `phase: 'discovery'` result) and
// the one that sends (a manual model, the SDK => the thrown "Connection error.").
//
// `--only transports` records `transports` alone: for each failure kind (refused, dns, reset, badPort, tls, response and
// connect timeout) what each class of Node call (the SDKs, and the raw `fetch` under each kind of timer) throws; see
// `recordTransports`.
//
// `--only sites` records `sites` alone: the real Node function of each production call site that bounds its request with
// a timer of its own, run with that timer ended at once against a server that never answers; see `recordSites`.
//
// The loop is driven the way `send-phase.mjs` drives it: a `retry_transport` verdict adds one to `transportRetriesUsed`
// and carries `transportRetryMax` into the next call; a thrown error ends the turn. Waits are recorded, not served
// (the timers `sleepWithAbort` arms are armed at 0 ms), and `Math.random` is pinned to 0.5 so every jittered wait is
// its bare step.
//
// `golden/connect_errors.json`: per case, the error's chain as the provider throws it, and per loop lap (one
// `sendWithRecovery` call) the provider-level waits (attempts = waits + 1), the loop's own wait, and the verdict.
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const treeAt = args.indexOf('--tree');
const nodeRoot = resolve(treeAt >= 0 ? args[treeAt + 1] : (process.env.MIXDOG_BENCH_TREE ?? join(here, '..', '..', '..', '..', '..')));
const scratch = mkdtempSync(join(tmpdir(), 'mixdog-connect-golden-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'MIXDOG_DESKTOP_USER_DATA', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = join(scratch, key);
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
for (const name of ['MIXDOG_TRANSPORT_RETRY_BACKOFF_MS', 'MIXDOG_CONNECTION_RETRY_BACKOFF_MS', 'MIXDOG_RECOVERY_RETRY_BACKOFF_MS']) delete process.env[name];
mkdirSync(join(here, 'golden'), { recursive: true });
Math.random = () => 0.5;

// Every wait the retry code arms goes through `retry-backoff.mjs` (`timerSleepWithAbort` for the loop's own wait,
// `_defaultAbortSleep` for the provider's `withRetry`); it is recorded against the code that asked for it and armed at
// 0 ms. The sockets' own timers are left alone.
const waits = [];
const realSetTimeout = globalThis.setTimeout;
// While a call site runs for `recordSites`, the timers that bound its request (a `createTimeoutSignal`, a bare
// `setTimeout(() => controller.abort())`, `AbortSignal.timeout`) are recorded and armed at 1 ms, against a server that
// never answers: the site's own code throws what it throws when the timer fires, without waiting its 30 s.
let site = null;
const SITE_TIMER_CALLERS = ['stall-policy.mjs', 'anthropic-oauth-credentials.mjs', 'provider-admin.mjs', 'openai-oauth-tokens.mjs', 'cursor-wire-transport.mjs', 'opencode-go-usage.mjs'];
globalThis.setTimeout = (callback, ms, ...rest) => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  if (site && ms >= 1000 && SITE_TIMER_CALLERS.some((file) => stack.includes(file))) {
    site.armed.push({ via: 'setTimeout', ms });
    return realSetTimeout(callback, 1, ...rest);
  }
  if (!stack.includes('timerSleepWithAbort') && !stack.includes('_defaultAbortSleep')) return realSetTimeout(callback, ms, ...rest);
  waits.push({ by: stack.includes('scheduleTransportReplay') ? 'loop' : 'provider', ms });
  return realSetTimeout(callback, 0, ...rest);
};

const load = (rel) => import(pathToFileURL(join(nodeRoot, rel)).href);
const orchestrator = 'src/runtime/agent/orchestrator';
const { sendWithRecovery, TRANSPORT_RETRY_MAX } = await load(`${orchestrator}/session/send-with-recovery.mjs`);
const { applyRetryAction } = await load(`${orchestrator}/session/loop/send-phase.mjs`);
const { OpenAICompatProvider } = await load(`${orchestrator}/providers/openai-compat.mjs`);
const { isProviderRecoveryExhausted, isProviderRecoveryTerminal } = await load(`${orchestrator}/providers/retry-executor.mjs`);
const { isConnectFailure } = await load(`${orchestrator}/providers/retry-classification.mjs`);

const admin = await load('src/session-runtime/services/provider-admin.mjs');

const MAX_LAPS = 30;

const chainOf = (error) => {
  const chain = [];
  for (let item = error, depth = 0; item && depth < 6; item = item.cause, depth += 1) {
    chain.push({ name: item.name ?? null, code: item.code ?? null, message: String(item.message ?? '').replace(/127\.0\.0\.1:\d+/, '127.0.0.1:<port>') });
  }
  return chain;
};

async function record(baseURL) {
  const provider = new OpenAICompatProvider('custom-harness', { apiKey: 'fixture', baseURL, preconnect: false });
  const state = { transportRetriesUsed: 0, transportRetryMax: 0 };
  const laps = [];
  let ended = null;
  for (let lap = 0; lap < MAX_LAPS && !ended; lap += 1) {
    waits.length = 0;
    const stages = [];
    const ctx = {
      messages: [{ role: 'user', content: 'hi' }],
      model: 'm',
      sendTools: [],
      tools: [],
      sessionId: 'connect-errors',
      nextIteration: 1,
      provider,
      opts: { onStageChange: (stage, detail) => stages.push({ stage, detail }) },
      transportRetriesUsed: state.transportRetriesUsed,
      transportRetryMax: state.transportRetryMax,
    };
    const entry = { providerWaitsMs: [], loopWaitMs: null, verdict: null, transportRetryMax: null };
    try {
      const result = await sendWithRecovery(ctx);
      entry.verdict = result.action;
      if (applyRetryAction(state, result)) entry.transportRetryMax = result.transportRetryMax ?? null;
      else ended = { kind: 'result', action: result.action };
    } catch (error) {
      entry.verdict = 'threw';
      // What `providerRecoveryEnded` (`send-with-recovery.mjs:190`) tells apart: a terminal verdict, an exhausted
      // ladder, and a connect failure (which the loop keeps waiting out).
      ended = {
        kind: 'threw',
        message: String(error.message).replace(/127\.0\.0\.1:\d+/, '127.0.0.1:<port>'),
        chain: chainOf(error),
        providerRecoveryExhausted: isProviderRecoveryExhausted(error),
        providerRecoveryTerminal: isProviderRecoveryTerminal(error),
        connectFailure: isConnectFailure(error),
      };
    }
    entry.providerWaitsMs = waits.filter((wait) => wait.by === 'provider').map((wait) => wait.ms);
    const loop = waits.filter((wait) => wait.by === 'loop');
    entry.loopWaitMs = loop.length ? loop[0].ms : null;
    // What the loop's reconnect stage showed for the replay it scheduled.
    const shown = stages.filter((item) => item.stage === 'reconnecting').at(-1);
    entry.shown = entry.verdict === 'retry_transport' && shown
      ? {
          attempt: shown.detail.attempt ?? null,
          max: shown.detail.max ?? shown.detail.maxAttempts ?? null,
          waitingForNetwork: shown.detail.waitingForNetwork === true,
        }
      : null;
    laps.push(entry);
  }
  return { laps, ended: ended ?? { kind: 'capped' } };
}

const portless = (value) => JSON.parse(JSON.stringify(value ?? null).replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>'));
const cfgMod = { loadConfig: () => ({ providers: {} }), saveConfig() {} };

// The same unsaved input through both probes; the connection test once with a manual model (it sends, no discovery) and
// once without (it discovers first and stops at the discovery error).
async function recordProbes(baseURL) {
  const input = { name: 'Probe', protocol: 'openai-chat', baseURL, apiKey: 'sk-DUMMY-probe-secret-0123456789' };
  const manual = { ...input, schemaVersion: 2, modelOverrides: { 'm-manual': { manual: true } } };
  const attempt = async (run) => {
    try {
      return { result: portless(await run()) };
    } catch (error) {
      return { thrown: portless(String(error.message)) };
    }
  };
  return {
    discover: await attempt(() => admin.discoverCustomProviderModels(cfgMod, input)),
    testDiscovery: await attempt(() => admin.testCustomProvider(cfgMod, input)),
    testSend: await attempt(() => admin.testCustomProvider(cfgMod, manual)),
  };
}

const closedPort = () =>
  new Promise((done) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

const resetServer = () =>
  new Promise((done) => {
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.once('data', () => socket.resetAndDestroy());
      socket.on('error', () => {});
    }).listen(0, '127.0.0.1', () => done({ server, port: server.address().port, count: () => connections }));
  });

// Answers every request with a 200 event stream and resets the socket 50 ms after the headers.
const cutServer = (first) =>
  new Promise((done) => {
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.on('error', () => {});
      socket.once('data', () => {
        socket.write(`HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\n\r\n${first}`);
        setTimeout(() => socket.resetAndDestroy(), 50);
      });
    }).listen(0, '127.0.0.1', () => done({ server, port: server.address().port, count: () => connections }));
  });

// The ports `fetch` refuses itself, found by asking it for every port of loopback: the refusal is a plain "bad port" at the
// end of the error chain, where a port nobody listens on ends in ECONNREFUSED.
async function badPorts() {
  const found = [];
  let next = 1;
  const worker = async () => {
    while (next <= 65535) {
      const port = next++;
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
      } catch (error) {
        let last = error;
        while (last.cause) last = last.cause;
        if (last.message === 'bad port') found.push(port);
      }
    }
  };
  await Promise.all(Array.from({ length: 200 }, worker));
  return found.sort((a, b) => a - b);
}

// --- transports: what each way Node issues a request shows for each way the request can fail ---------------------
// Classes (the Node call site decides which a Rust `Exchange` is; `transport/deadlines.rs`):
//   sdkOpenAI / sdkAnthropic  the pinned SDKs' `chat.completions.create` / `messages.create` on the provider's own client
//   fetchDispatcher           a raw `fetch` with no timer of its own, on the shared undici dispatcher
//   fetchSignal               a raw `fetch` under `AbortSignal.timeout`
//   fetchLabeled              a raw `fetch` under `createTimeoutSignal(…, label)` (`stall-policy.mjs:384`)
//   fetchAborted              a raw `fetch` whose caller aborts a controller on a bare `setTimeout`
// Kinds: refused, dns, reset, badPort, tls (a plain server answering the TLS handshake with HTTP), responseTimeout (the
// server accepts and never answers) and connectTimeout (an address no one answers: 192.0.2.1, TEST-NET-1).
// Every timer is TRANSPORT_TIMEOUT_MS so the recording takes seconds; the undici connector's own 10 s is waited out once.
const TRANSPORT_TIMEOUT_MS = 400;
// A server that accepts and never answers.
const silent = () =>
  new Promise((done) => {
    const server = createServer((socket) => socket.on('error', () => {})).listen(0, '127.0.0.1', () => done({ server, port: server.address().port }));
  });
async function recordTransports() {
  process.env.MIXDOG_LLM_HEADERS_TIMEOUT_MS = String(TRANSPORT_TIMEOUT_MS);
  process.env.MIXDOG_LLM_BODY_TIMEOUT_MS = String(TRANSPORT_TIMEOUT_MS);
  const { getLlmDispatcher } = await load('src/runtime/shared/llm/http-agent.mjs');
  const { createTimeoutSignal } = await load(`${orchestrator}/stall-policy.mjs`);
  const { AnthropicProvider } = await load(`${orchestrator}/providers/anthropic.mjs`);
  const dispatcher = getLlmDispatcher();
  const messages = [{ role: 'user', content: 'hi' }];
  const clients = {
    sdkOpenAI: async (base) => {
      const client = new OpenAICompatProvider('custom-harness', { apiKey: 'fixture', baseURL: base, preconnect: false })._createClient('fixture');
      client.timeout = TRANSPORT_TIMEOUT_MS;
      return client.chat.completions.create({ model: 'm', messages });
    },
    sdkAnthropic: async (base) => {
      const client = new AnthropicProvider({ name: 'custom-harness-a', apiKey: 'fixture', baseURL: base })._createClient('fixture');
      client.timeout = TRANSPORT_TIMEOUT_MS;
      return client.messages.create({ model: 'm', max_tokens: 16, messages });
    },
    fetchDispatcher: (base) => fetch(`${base}/models`, { dispatcher }),
    fetchSignal: (base) => fetch(`${base}/models`, { dispatcher, signal: AbortSignal.timeout(TRANSPORT_TIMEOUT_MS) }),
    fetchLabeled: async (base) => {
      const timer = createTimeoutSignal(null, TRANSPORT_TIMEOUT_MS, 'probe label');
      try {
        return await fetch(`${base}/models`, { dispatcher, signal: timer.signal });
      } finally {
        timer.cleanup();
      }
    },
    fetchAborted: async (base) => {
      const controller = new AbortController();
      const timer = realSetTimeout(() => controller.abort(), TRANSPORT_TIMEOUT_MS);
      try {
        return await fetch(`${base}/models`, { dispatcher, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    },
  };
  const plainOnTls = () =>
    new Promise((done) => {
      const server = createServer((socket) => {
        socket.on('error', () => {});
        socket.once('data', () => socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n'));
      }).listen(0, '127.0.0.1', () => done({ server, port: server.address().port }));
    });
  const reset = await resetServer();
  const quiet = await silent();
  const tls = await plainOnTls();
  const kinds = {
    refused: `http://127.0.0.1:${await closedPort()}/v1`,
    dns: 'https://connect-errors-no-such-host.invalid/v1',
    reset: `http://127.0.0.1:${reset.port}/v1`,
    badPort: 'http://127.0.0.1:9/v1',
    tls: `https://127.0.0.1:${tls.port}/v1`,
    responseTimeout: `http://127.0.0.1:${quiet.port}/v1`,
    connectTimeout: 'https://192.0.2.1/v1',
  };
  const out = {};
  for (const [kind, base] of Object.entries(kinds)) {
    out[kind] = {};
    for (const [name, run] of Object.entries(clients)) {
      try {
        await run(base);
        out[kind][name] = { resolved: true };
      } catch (error) {
        out[kind][name] = { name: error.name ?? null, message: portless(String(error.message)), chain: chainOf(error) };
      }
    }
  }
  reset.server.close();
  quiet.server.close();
  tls.server.close();
  return { timeoutMs: TRANSPORT_TIMEOUT_MS, kinds: out };
}

// --- sites: what each production call site throws when its own timer ends the request ----------------------------------
// Every site is the real Node function (nothing is stubbed but where the request goes: a server that never answers,
// `site.port`). Per site: `armed`, the timers that bound the request (`via`, `ms`); `fetchRejected`, what the raw `fetch`
// rejected with (the call class's text); `thrown`, what the site's own code throws after it (equal to the fetch's text
// where the site passes it on, a wrapper's text where it does not); `value`, the result of a site that answers.
async function recordSites() {
  process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
  const providers = `${orchestrator}/providers`;
  const grokTokens = await load(`${providers}/grok-oauth-tokens.mjs`);
  const grokLogin = await load(`${providers}/grok-oauth-login.mjs`);
  const anthropicCredentials = await load(`${providers}/anthropic-oauth-credentials.mjs`);
  const antigravityTokens = await load(`${providers}/antigravity-oauth-tokens.mjs`);
  const geminiCatalog = await load(`${providers}/lib/gemini-model-catalog.mjs`);
  const mimoTokens = await load(`${providers}/mimo-oauth-tokens.mjs`);
  const commandCodeTokens = await load(`${providers}/command-code-oauth-tokens.mjs`);
  const museTokens = await load(`${providers}/muse-code-oauth-tokens.mjs`);
  const devinAuth = await load(`${providers}/devin-auth.mjs`);
  const compatModels = await load(`${providers}/openai-compat-models.mjs`);
  const { AnthropicProvider } = await load(`${providers}/anthropic.mjs`);
  const { createCustomProvider } = await load(`${providers}/custom-provider.mjs`);
  const cursorAuth = await load(`${providers}/cursor-auth.mjs`);
  const cursorTransport = await load(`${providers}/cursor-wire-transport.mjs`);
  const openaiTokens = await load(`${providers}/openai-oauth-tokens.mjs`);
  const openaiCatalog = await load(`${providers}/openai-oauth-catalog.mjs`);
  const museLogin = await load(`${providers}/muse-code-oauth-login.mjs`);
  const antigravityLogin = await load(`${providers}/antigravity-oauth-login.mjs`);
  const opencodeTokens = await load(`${providers}/opencode-go-oauth-tokens.mjs`);
  const vertexAuth = await load(`${providers}/vertex-ai-auth.mjs`);
  const npmVersion = await load(`${providers}/npm-cli-version.mjs`);
  const stall = await load(`${orchestrator}/stall-policy.mjs`);
  const devinWire = await load(`${providers}/devin-wire-transport.mjs`);
  const modelCatalog = await load('src/runtime/shared/llm/model-catalog.mjs');
  const openaiLogin = await load(`${providers}/openai-oauth-login.mjs`);
  const opencodeUsage = await load(`${providers}/opencode-go-usage.mjs`);
  process.env.MIXDOG_LLM_HEADERS_TIMEOUT_MS = String(TRANSPORT_TIMEOUT_MS);
  process.env.MIXDOG_LLM_BODY_TIMEOUT_MS = String(TRANSPORT_TIMEOUT_MS);
  // The credential files the refresh sites read, in the scratch tree.
  const cursorFile = join(scratch, 'cursor-oauth.json');
  const openaiFile = join(scratch, 'openai-oauth.json');
  process.env.CURSOR_OAUTH_CREDENTIALS_PATH = cursorFile;
  process.env.OPENAI_OAUTH_CREDENTIALS_PATH = openaiFile;
  const signedIn = { access_token: 'a', refresh_token: 'r', expires_at: 1 };

  const xaiToken = 'https://auth.x.ai/oauth2/token';
  const input = (protocol, path, port) => ({ name: 'Probe', protocol, baseURL: `http://127.0.0.1:${port}${path}`, apiKey: 'sk-DUMMY-probe-secret-0123456789' });
  // The settings page's probe: the discovery under its own 60 s `withTimeout` (armed first, so it ends the wait) ...
  const probe = (protocol, path) => async ({ port }) => portless(await admin.discoverCustomProviderModels(cfgMod, input(protocol, path, port)));
  // ... and the provider's own discovery, as the runtime refresh runs it (the default 10 s window).
  const listing = (protocol, path) => async ({ port }) => {
    const provider = await createCustomProvider('custom-listing', input(protocol, path, port));
    return provider.listModels();
  };
  const sites = {
    grokDiscovery: () => grokTokens.fetchDiscovery(),
    grokRefresh: () => grokTokens.refreshTokens({ access_token: 'a', refresh_token: 'r', token_endpoint: xaiToken }, { force: true }),
    grokCodeExchange: () => grokLogin.exchangeAuthorizationCode({ discovery: { token_endpoint: xaiToken }, pkce: { verifier: 'v', challenge: 'c' }, code: 'abc' }),
    anthropicRefresh: () =>
      anthropicCredentials.refreshOAuthCredentials({ path: join(scratch, 'anthropic-credentials.json'), accessToken: 'a', refreshToken: 'r', expiresAt: 0 }),
    antigravityRefresh: async () => {
      await antigravityTokens.saveTokens({ access_token: 'a', refresh_token: 'r', expires_at: 0 });
      return antigravityTokens.refreshTokens();
    },
    geminiModelList: () => geminiCatalog.fetchGeminiModelPages('k'),
    mimoProbe: () => mimoTokens.probeTokenPlanBaseUrl('k'),
    commandCodeIdentity: () => commandCodeTokens.requestCommandCodeJson(commandCodeTokens.WHOAMI_URL, 'k'),
    museKey: () => museTokens.requestMuseCodeKey('t', { onboard: true }),
    devinExchange: () => devinAuth.exchangeDevinCode('c', 'v'),
    compatModelList: ({ port }) => compatModels.fetchCompatModelItems({ name: 'groq', baseURL: `http://127.0.0.1:${port}/v1`, config: {} }, { keyless: true }),
    anthropicModelList: ({ port }) => new AnthropicProvider({ name: 'custom-harness-a', apiKey: 'fixture', baseURL: `http://127.0.0.1:${port}` }).listModels(),
    customOpenaiChatListing: listing('openai-chat', '/v1'),
    customAnthropicListing: listing('anthropic', ''),
    customOpenaiChatProbe: probe('openai-chat', '/v1'),
    customAnthropicProbe: probe('anthropic', ''),
    // Requests that arm no timer of their own: they end at the shared dispatcher's headers timeout (`http-agent.mjs:413`,
    // 600_000 by default, shortened below for the recording).
    devinUnary: ({ port }) =>
      devinWire.devinUnary({
        baseUrl: `http://127.0.0.1:${port}`,
        path: '/exa.auth_pb.AuthService/GetUserJwt',
        requestType: 'GetUserJwtRequest',
        responseType: 'GetUserJwtResponse',
        message: { metadata: { apiKey: 'k' } },
      }),
    vertexToken: async () => {
      const adc = join(scratch, 'adc.json');
      writeFileSync(adc, JSON.stringify({ type: 'authorized_user', client_id: 'c', client_secret: 's', refresh_token: 'r' }));
      const manager = new vertexAuth.VertexAccessTokenManager({
        authMode: vertexAuth.VERTEX_ADC_MODE,
        env: { GOOGLE_APPLICATION_CREDENTIALS: adc },
        fetchFn: fetch,
      });
      return manager.getAccessToken();
    },
    antigravityVersion: () => antigravityTokens.ensureAntigravityVersion(),
    // The catalog loader swallows the failure and logs it: the logged line is what shows.
    modelsDev: () => modelCatalog.loadModelsDevCatalog({ force: true }),
    cursorRefresh: async () => {
      writeFileSync(cursorFile, JSON.stringify(signedIn));
      return cursorAuth.resolveCursorOAuthAccessToken({ forceRefresh: true });
    },
    openaiRefresh: async () => {
      writeFileSync(openaiFile, JSON.stringify(signedIn));
      return openaiTokens.refreshStoredTokens({ force: true });
    },
    openaiCatalog: () => openaiCatalog.refreshCodexCatalog(async () => ({ access_token: 'a', account_id: 'x' })),
    museDeviceAuth: () => museLogin.requestDeviceAuthorization(),
    antigravityCodeExchange: () => antigravityLogin.exchangeAuthorizationCode({ code: 'abc', verifier: 'v' }),
    antigravityProject: () => antigravityLogin.discoverAccount('tok'),
    opencodeConsole: () => opencodeTokens.consoleRequest('https://opencode.ai/auth/device/token', { method: 'POST', body: {} }),
    // The pasted-code path of the login: the exchange is not exported, `completeCode` runs it.
    openaiCodeExchange: async () => {
      const login = await openaiLogin
        .createOpenAIOAuthLogin({
          clientId: 'c',
          originator: 'o',
          extractAccountId: () => null,
          identityFromTokens: () => null,
          expiryFromAccessToken: () => 0,
          saveTokens: async () => {},
        })
        .beginOAuthLogin({ openBrowser: false });
      const settled = login.waitForCallback.catch(() => {});
      try {
        return await login.completeCode('abc');
      } finally {
        login.cancel();
        await settled;
      }
    },
    // The status read of the OpenCode Go usage meter: a bare `AbortController` timer, `redirect: 'error'`.
    opencodeGoUsage: () => opencodeUsage.fetchOpenCodeGoOAuthUsageSnapshot({ access_token: 'a', refresh_token: 'r', org_id: 'o' }),
    vertexMetadataProbe: () => vertexAuth.probeVertexMetadata(),
    npmVersion: () => npmVersion.fetchRemoteVersion('https://registry.npmjs.org/@openai/codex/latest', npmVersion.parseNpmLatest),
    // Node's `callCursorUnary` against a server that never answers the handshake: its own timer ends it
    // (`cursor-wire-transport.mjs:274`), the dashboard reads at the default 5_000, the model list at 15_000
    // (`cursor-wire-models.mjs:30`). The connect timer of `openCursorStream` ends the stream with its `close` error (`:151`).
    cursorUsageCall: ({ port }) =>
      cursorTransport.callCursorUnary({ accessToken: 'a', path: cursorTransport.USAGE_PATH, body: new Uint8Array(), url: `https://127.0.0.1:${port}` }),
    cursorModelsCall: ({ port }) =>
      cursorTransport.callCursorUnary({ accessToken: 'a', path: cursorTransport.USAGE_PATH, body: new Uint8Array(), url: `https://127.0.0.1:${port}`, timeoutMs: 15_000 }),
    cursorConnect: ({ port }) =>
      new Promise((_, reject) => {
        cursorTransport.openCursorStream({ accessToken: 'a', url: `https://127.0.0.1:${port}` }).onClose((error) => reject(error));
      }),
  };

  const realFetch = globalThis.fetch;
  const realAbortTimeout = AbortSignal.timeout.bind(AbortSignal);
  const out = {};
  for (const [name, run] of Object.entries(sites)) {
    const quiet = await silent();
    site = { armed: [], rejected: [], port: quiet.port };
    AbortSignal.timeout = (ms) => {
      site.armed.push({ via: 'AbortSignal.timeout', ms });
      return realAbortTimeout(1);
    };
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      try {
        return await realFetch(`http://127.0.0.1:${site.port}${url.pathname}${url.search}`, init);
      } catch (error) {
        site.rejected.push({ name: error.name ?? null, message: portless(String(error.message)) });
        throw error;
      }
    };
    const entry = { armed: null, fetchRejected: null, thrown: null };
    const realWrite = process.stderr.write.bind(process.stderr);
    const logged = [];
    process.stderr.write = (chunk, ...rest) => {
      if (String(chunk).startsWith('[model-catalog]')) logged.push(portless(String(chunk).trimEnd()));
      return realWrite(chunk, ...rest);
    };
    try {
      const value = await run({ port: quiet.port });
      entry.thrown = { resolved: true };
      if (value !== undefined && name.endsWith('Probe')) entry.value = value;
    } catch (error) {
      entry.thrown = { name: error.name ?? null, code: error.code ?? null, message: portless(String(error.message)) };
    }
    process.stderr.write = realWrite;
    if (logged.length) entry.logged = logged;
    Object.assign(entry, { armed: site.armed, fetchRejected: site.rejected });
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realAbortTimeout;
    site = null;
    quiet.server.close();
    out[name] = entry;
  }
  return out;
}

const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const goldenFile = join(here, 'golden', 'connect_errors.json');
const golden = only ? JSON.parse(readFileSync(goldenFile, 'utf8')) : { transportRetryMax: TRANSPORT_RETRY_MAX, badPorts: await badPorts(), cases: {} };
if (!only) {
  golden.cases.refused = await record(`http://127.0.0.1:${await closedPort()}/v1`);
  golden.cases.dns = await record('https://connect-errors-no-such-host.invalid/v1');
  const reset = await resetServer();
  golden.cases.reset = await record(`http://127.0.0.1:${reset.port}/v1`);
  golden.cases.reset.connections = reset.count();
  reset.server.close();
  golden.cases.badPort = await record('http://127.0.0.1:9/v1');
}
if (!only || only === 'probes') {
  golden.probes = {
    refused: await recordProbes(`http://127.0.0.1:${await closedPort()}/v1`),
    badPort: await recordProbes('http://127.0.0.1:9/v1'),
    dns: await recordProbes('https://connect-errors-no-such-host.invalid/v1'),
  };
}
if (!only || only === 'transports') golden.transports = await recordTransports();
if (!only || only === 'sites') golden.sites = await recordSites();
for (const [name, first] of only && only !== 'cut' ? [] : [
  ['cut', ': open\n\n'],
  ['cutRole', `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { role: 'assistant' } }] })}\n\n`],
]) {
  const cut = await cutServer(first);
  golden.cases[name] = await record(`http://127.0.0.1:${cut.port}/v1`);
  golden.cases[name].connections = cut.count();
  cut.server.close();
}

writeFileSync(goldenFile,`${JSON.stringify(golden, null, 2)}\n`);
console.log(
  Object.entries(golden.cases)
    .map(([name, item]) => `${name}: ${item.laps.length} laps, ends ${item.ended.kind}`)
    .join('\n')
);
process.exit(0);
