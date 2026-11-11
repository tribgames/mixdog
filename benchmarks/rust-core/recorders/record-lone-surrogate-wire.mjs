#!/usr/bin/env node
// What Node (b6f10295a, an exact export) does with a client's string holding an unpaired UTF-16 surrogate where the string
// becomes an HTTP header, a URL query or a language-server request, or where its serialised size is limited
// (lib/lone-surrogate-wire-cases.mjs). Each case runs Node's own code for that request:
//   - mcpRuntime: `addMcpServer` / `saveMcpServer` of Node's own session runtime (`createMixdogSessionRuntime`, its home, data and
//     profile folders in the scratch world), which saves the server and connects it (the SDK's streamable HTTP transport); then
//     what a client reads after the call: `mcpStatus` and `getMcpServerConfig` of the server;
//   - mcpProbe: `probeMcpServerAuth` (mcp/oauth-probe.mjs);
//   - custom: `saveCustomProvider` / `testCustomProvider` / `discoverCustomProviderModels` (services/provider-admin.mjs) over a
//     config holding no provider;
//   - hfSearch: the Hugging Face catalog's `search` (local-provider/hugging-face.mjs) with its fetch recorded;
//   - lsp: the desktop operation `lspRequest` (desktop-operations.ts, language-server-manager) against a scripted server found
//     on PATH as `rust-analyzer` (lib/lsp-echo-stub.mjs), which answers with the params it read.
// A local HTTP server (lib/lone-surrogate-wire-cases.mjs ORIGIN) logs every request each case made, with the bytes of its
// X-Token header.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-lone-surrogate-wire.mjs --tree D:\mixdog-build\tmp\b6f-tree [--only <case>]
//   ... --replay <path to mixdogd.exe>     (the core's answers to the same requests, compared whole)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES_ROOT, REPO_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { CASES, PORT, PROJECT, ROOT, loneRefusal } from './lib/lone-surrogate-wire-cases.mjs';
import { LONE_MAPPING, lonePlaces } from './lib/lone-mapping.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const SET = join(FIXTURES_ROOT, 'lone-surrogate-wire');
const args = parseArgs();
const ONLY = args.get('only') ?? null;
const REPLAY = args.get('replay') ?? null;
const WAIT_MS = 60_000;

/** `promise`, or a failure naming `what` at the deadline. */
function within(promise, what) {
  let timer;
  const late = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: nothing within ${WAIT_MS} ms`)), WAIT_MS)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** The local HTTP server: every request logged (method, path, the X-Token header's bytes as sent, hex); `/v1/models` lists one
 *  model, everything else is 404. A `POST /lsp` is the language server's report of a request it received (lib/lsp-echo-stub.mjs):
 *  logged once its body is read, with that request (`received`, JSON.parse: an escaped lone unit stays one). */
export async function startServer() {
  const log = [];
  const server = createServer((req, res) => {
    const at = req.rawHeaders.findIndex((name, index) => index % 2 === 0 && name.toLowerCase() === 'x-token');
    const entry = { method: req.method, url: req.url, xToken: at < 0 ? null : Buffer.from(req.rawHeaders[at + 1], 'latin1').toString('hex') };
    if (req.method === 'POST' && req.url === '/lsp') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        log.push({ ...entry, received: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        res.writeHead(204);
        res.end();
      });
      return;
    }
    log.push(entry);
    req.resume();
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'm1', object: 'model' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await within(new Promise((resolve, reject) => server.once('error', reject).listen(PORT, '127.0.0.1', resolve)), `the local server listening on ${PORT}`);
  return { log, close: () => within(new Promise((resolve) => server.close(resolve)), 'the local server closing') };
}

/** The project and the language server: the echo stub, as `rust-analyzer` in the returned folder (put first on PATH, the products
 *  resolve it like any server). */
export function buildWorld() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
  writeFileSync(join(PROJECT, 'a.rs'), 'fn main() {}\n');
  const stubBin = join(ROOT, 'stub-bin');
  mkdirSync(stubBin);
  const stubScript = fileURLToPath(new URL('./lib/lsp-echo-stub.mjs', import.meta.url));
  writeFileSync(join(stubBin, 'rust-analyzer.cmd'), `@"${process.execPath}" "${stubScript}" %*\r\n`);
  return stubBin;
}

if (REPLAY) {
  const { replay } = await import('./lib/lone-surrogate-wire-replay.mjs');
  process.exit(await replay({ exe: REPLAY, golden: JSON.parse(readFileSync(join(SET, 'golden.json'), 'utf8')), manifest: JSON.parse(readFileSync(join(SET, 'MANIFEST.json'), 'utf8')), only: ONLY, startServer, buildWorld }));
}

const tree = resolveTree(args);
const identity = exactProductIdentity(tree, COMMIT);
// Nothing of the signed-in profile is read or written.
const STATE = `${ROOT}-node-state`;
rmSync(STATE, { recursive: true, force: true });
for (const dir of ['home', 'data', 'userData', 'profile']) mkdirSync(join(STATE, dir), { recursive: true });
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = join(STATE, 'profile');
Object.assign(process.env, { MIXDOG_HOME: join(STATE, 'home'), MIXDOG_DATA_DIR: join(STATE, 'data'), MIXDOG_SKIP_USER_DATA_BACKUP: '1' });
const stubBin = buildWorld();

const at =(path) => importFrom(tree, path);
const mcpClient = await at('src/runtime/agent/orchestrator/mcp/client.mjs');
const { createMixdogSessionRuntime } = await at('src/mixdog-session-runtime.mjs');
const { probeMcpServerAuth } = await at('src/runtime/agent/orchestrator/mcp/oauth-probe.mjs');
const admin = await at('src/session-runtime/services/provider-admin.mjs');
const { createHuggingFaceCatalog } = await at('src/runtime/local-provider/hugging-face.mjs');
const { createDesktopOperations } = await at('apps/desktop/src/main/desktop-operations.ts');

const hostPath = process.env.PATH;
process.env.PATH = stubBin;
const operations = createDesktopOperations({
  userDataPath: join(STATE, 'userData'),
  packaged: false,
  resourcesPath: '',
  appPath: join(tree, 'apps', 'desktop'),
  loadConfig: async () => ({}),
  loadDocumentPreview: () => at('src/runtime/office/pdf/document-preview.mjs'),
  emit() {},
});

const outcome = async (run) => {
  try {
    const value = await run();
    return { ok: true, value: value === undefined ? null : value };
  } catch (error) {
    return { ok: false, error: error.message };
  }
};
const config = { providers: {} };
const cfgMod = { loadConfig: () => structuredClone(config), saveConfig: () => {} };
const CUSTOM = { save: admin.saveCustomProvider, test: admin.testCustomProvider, discover: admin.discoverCustomProviderModels };
// One session runtime for the MCP cases, made at the first: they run in order on it, as the core's replay runs them on one core.
let runtime = null;
const RUN = {
  async mcpRuntime({ op, input }) {
    runtime ??= await within(createMixdogSessionRuntime({ cwd: PROJECT, toolMode: 'full' }), 'the session runtime');
    const answer = await within(outcome(() => runtime[op](input)), `${op} of ${input.name}`);
    const status = await within(outcome(() => runtime.mcpStatus()), 'mcpStatus');
    const config = await within(outcome(() => runtime.getMcpServerConfig(input.name)), `getMcpServerConfig of ${input.name}`);
    return { answer, status, config };
  },
  mcpProbe: ({ cfg }) => outcome(() => probeMcpServerAuth(cfg)),
  custom: ({ op, input }) => within(outcome(() => CUSTOM[op](cfgMod, input)), `custom ${op}`),
  async hfSearch({ query }) {
    const fetched = [];
    const catalog = createHuggingFaceCatalog({
      dataDir: join(ROOT, 'hf'),
      hardwareFn: async () => ({ gpus: [] }),
      fetchFn: async (url) => {
        fetched.push(String(url));
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    return { answer: await outcome(() => catalog.search(query)), fetched };
  },
  lsp: ({ input }) =>
    within(
      outcome(() => operations.invoke('lspRequest', [input.projectPath, input.root, input.relPath, input.languageId, input.method, input.params])),
      `the language server's answer to ${input.method}`,
    ),
};

const server = await startServer();
const cases = [];
try {
  for (const entry of CASES) {
    if (ONLY && entry.name !== ONLY) continue;
    server.log.splice(0);
    const node = await RUN[entry.node.run](entry.node);
    // `asked`: what Node's code was given; `coreText`: the params of the core's request as a client's JSON.stringify writes them
    // (a lone unit as its escape), for the core's own tests.
    cases.push({
      name: entry.name,
      asked: entry.node,
      ...(entry.core ? { coreMethod: entry.core.method, coreText: JSON.stringify(entry.core.params) } : {}),
      node,
      requests: server.log.splice(0),
    });
  }
} finally {
  await operations.dispose();
  if (runtime) await within(runtime.close(), 'the session runtime closing');
  await mcpClient.disconnectAll();
  await server.close();
  process.env.PATH = hostPath;
}

if (ONLY) {
  process.stdout.write(`${JSON.stringify(cases, null, 2)}\n`);
  process.exit(0);
}
// Node's first custom provider built for an origin warms it with a fire-and-forget `HEAD /` (openai-compat.mjs `preconnect`,
// once per origin and process): exactly one in the recording, declared with its position; the replay leaves out that request
// only, on Node's side only.
const heads = cases.flatMap((entry) => (entry.requests ?? []).flatMap((request, index) => (request.method === 'HEAD' ? [{ case: entry.name, index, request }] : [])));
if (heads.length !== 1 || heads[0].request.url !== '/') throw new Error(`expected one warm-up HEAD / in the recording, got ${JSON.stringify(heads)}`);
const warmup = {
  ...heads[0],
  reason: "Node's first custom provider for an origin sends a fire-and-forget HEAD / (openai-compat.mjs preconnect, once per origin and process); the core does not warm a custom origin here. A difference of provider construction, not of the string under test",
  replayedBySet: 'provider-setup-warmup',
};
// The inventory's refused fields of the language-server request and of an MCP server's header values, with its reasons.
const INVENTORY = 'native/core/crates/mixdog-app-protocol/tests/it/free_text_fields.json';
const DECLARED = (field) => field.startsWith('request lsp/request ') || /^request mcp\/(add|save)McpServer \/input\/headers\/\*$/.test(field);
const refusedFields = JSON.parse(readFileSync(join(REPO_ROOT, INVENTORY), 'utf8'))
  .classes.filter((entry) => entry.class === 'refused')
  .flatMap((entry) => entry.fields.filter(DECLARED).map((field) => ({ field, reason: entry.reason })))
  .sort((a, b) => (a.field < b.field ? -1 : 1));
const WORLD_FILES_SKIP = [
  {
    path: 'core/data/daemon-owner.lock',
    reason: "the core's ownership of its data folder: an OS-held exclusive lock for its whole life (Node's daemon-owner.lock likewise), so its bytes cannot be read while it runs; written once at the start",
  },
  {
    path: 'core/home/backups/user-data',
    reason:
      "the barrier's own config write (worldFiles.barrier) adds a pre- and a post-config-write copy of the config here each time, as every config write does (Node's user-data-backup likewise); a config write by the refused call would change the config file itself (mixdog-config.json), which is compared",
  },
  {
    path: 'core/data/daemon.log',
    reason: "the core's diagnostic log: lines from its own timers and events (a language server it stops when idle, for one), not stored state; a refused call is answered before any service runs, so it logs nothing a service would",
  },
  {
    path: 'core/data/modelsdev-catalog.json',
    atomicTemp: true,
    reason:
      "the models.dev catalog cache: refreshed by the core on its own schedule from models.dev (not a stand-in server), as Node's catalog refresh does; no client call writes it",
  },
  {
    path: 'core/data/modelsdev-catalog.json.lock',
    lockStaging: true,
    reason:
      "the lock the models.dev catalog's refresh holds while it writes the cache (the entry above), with the record it stages and the guard it takes to reclaim a stale one (mixdog-statefile lock.rs publish_lock, reclaim)",
  },
  {
    path: 'core/data/update-check-cache.json',
    atomicTemp: true,
    reason:
      "the npm registry's latest version, cached 24 h by the core's own update check (mixdog-core-domains update.rs, Node's self-update.mjs) from registry.npmjs.org (not a stand-in server), written whenever that check, started by the core at its start, answers",
  },
  {
    path: 'core/data/client-versions.json',
    atomicTemp: true,
    reason:
      "the last answer of each provider CLI's live version lookup (mixdog-ai client_versions.rs, Node's live CLI versions): written when a lookup the core started on its own answers, from the providers' sites (not a stand-in server); no client call writes it",
  },
  {
    path: 'core/data/client-versions.json.lock',
    lockStaging: true,
    reason:
      "the lock the live version lookup holds while it writes its cache (the entry above), with the record it stages and the guard it takes to reclaim a stale one (mixdog-statefile lock.rs publish_lock, reclaim)",
  },
];
// The language server's closing handshake: the core shuts down an idle language server on its own timer (Node's manager likewise),
// so its `shutdown` and `exit` may reach the stub during any call of the sweep; any other message is a call's.
const LANGUAGE_SERVER_LIFECYCLE = ['shutdown', 'exit'];
// The methods of the inventory's refused request fields that a desktop may not call (the method table's origins): the sweep sends
// them from a paired phone.
const METHOD_TABLE = 'native/core/crates/mixdog-app-protocol/schema/method_table.json';
const desktopMethods = new Set(
  JSON.parse(readFileSync(join(REPO_ROOT, METHOD_TABLE), 'utf8'))
    .clientMethods.filter((row) => row.origins.includes('local'))
    .map((row) => row.method),
);
const phoneOnly = [
  ...new Set(
    JSON.parse(readFileSync(join(REPO_ROOT, INVENTORY), 'utf8'))
      .classes.filter((entry) => entry.class === 'refused')
      .flatMap((entry) => entry.fields)
      .filter((field) => field.startsWith('request '))
      .map((field) => field.split(' ')[1])
      .filter((method) => !desktopMethods.has(method)),
  ),
].sort();
const stage = stageSet(SET);
writeJson(join(stage, 'golden.json'), {
  note: 'What Node b6f10295a did with a client string holding a lone surrogate where it becomes an HTTP header, a URL query or a language-server request, or where its serialised size is limited; and every request each case sent to the local server.',
  cases,
});
writeSetManifest(stage, {
  set: 'lone-surrogate-wire',
  recorder: 'benchmarks/rust-core/recorders/record-lone-surrogate-wire.mjs',
  command: 'node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs benchmarks/rust-core/recorders/record-lone-surrogate-wire.mjs --tree D:\\mixdog-build\\tmp\\b6f-tree',
  identity,
  extra: {
    exact: true,
    ...recorderProvenance(import.meta.url, ['benchmarks/rust-core/recorders/lib/lsp-echo-stub.mjs', INVENTORY]),
    exclusions: [],
    // The only change made to Node's values before comparing: at each listed place (a JSON pointer into the case's
    // {node, requests}) Node holds a lone unit where the core holds U+FFFD. Every place of a compared case holding one is listed.
    mapping: {
      ...LONE_MAPPING,
      at: Object.fromEntries(
        CASES.filter((entry) => entry.core && !entry.refused)
          .map((entry) => cases.find((recorded) => recorded.name === entry.name))
          .map((recorded) => [recorded.name, lonePlaces({ node: recorded.node, requests: recorded.requests })])
          .filter(([, places]) => places.length),
      ),
    },
    // Cases the core refuses by decision: the field is not free text (mixdog-app-protocol free_text.rs, tests/it/free_text_fields.json).
    // Node's answer and what reached the local server are recorded (golden.json cases[].node, cases[].requests).
    refusedByRule: {
      decision:
        'decisions.md "Lone UTF-16 surrogates in client strings": a field whose value becomes a header, a URL, a path, a command or an identifier refuses the call naming the field, before anything is stored or sent; Node may store or forward it, and the refusal without side effect is the accepted difference',
      // Every such field of the requests these cases reach, as the inventory classes them (`refused`).
      fields: refusedFields,
      cases: CASES.filter((entry) => entry.refused).map((entry) => ({
        case: entry.name,
        field: entry.refused,
        nodeAnswered: cases.find((recorded) => recorded.name === entry.name).node,
        nodeRequests: cases.find((recorded) => recorded.name === entry.name).requests,
        coreMustAnswer: loneRefusal(entry.refused),
      })),
      check:
        "the client failure detail equals coreMustAnswer whole; the local server got no request (nor the language server, which reports each request it receives there); for an MCP server, mcp/mcpStatus and mcp/getMcpServerConfig of its name answer after the call what they answered before it; worldFiles have the bytes they had before the call",
    },
    // Compared outside the replay: the Hugging Face search URL, by mixdog-services local_provider/hugging_face.rs (its HTTP is
    // a trait there; the core's catalog has no address but huggingface.co).
    replayedByRustTest: [{ case: 'hf-search-lone', test: 'mixdog-services local_provider::hugging_face::tests::a_query_holding_a_lone_surrogate_is_the_url_node_fetched' }],
    nodeOnlyRequests: [warmup],
    // What "nothing stored" is checked on: the bytes of every file of the core's folders (`core/`: runtime, data, home, config)
    // and of the cases' world (`world/`: the project the language server opens), read before and after each refused call; a file
    // added, removed or changed fails it. Not read, with the reason:
    worldFiles: {
      skip: WORLD_FILES_SKIP,
      // Each entry's `path` is one file or folder exactly (a folder: everything in it); `atomicTemp` adds the temporary file of an
      // atomic write of that file, `<path>.mixdog-tmp-<16 hex>` exactly, and nothing else.
      skipForm: 'exact path (a folder: everything under it); atomicTemp: also <path>.mixdog-tmp-<16 lowercase hex>',
      // Before each look at the files (before and after the call), after the call's answer: one step per store a call can write,
      // in this order, each answer required to be the expected one.
      barrier: {
        config:
          "the config file (core/data/mixdog-config.json): config/setTheme with the theme config/getTheme answered at the first look, which mixdog-core-config writes through the config's one writer (config/mod.rs Config::update on its write lane, written even when unchanged, as Node's updateConfig) and answers once written; a config write the refused call queued is written before it. Its answer must name the theme",
        mcpServerList:
          "in the config file: mcp/addMcpServer and mcp/saveMcpServer write the list through that same writer (mixdog-mcp mcp_service.rs save_servers -> save_config -> Config::update), so the config step covers it",
        sessionStore:
          "replay/storesSettled, sent as a raw frame from the paired phone after the config step's answer (the desktop's protocol client sends only the method table's methods), a development-build control (mixdog-cli feature replay-controls; refused in a release build by build.rs): each thread loaded when it arrives takes its accept watermark then (the last record its actor accepted, the prompt-history appends pushed) and answers once every record up to it is committed - written and synced by the store, which acks it (mixdog-store log.rs append_barrier sync_file; mixdog-core-session actor.rs on_durability -> Outbox::acked) - and every append up to it is written (prompt_history.rs AppendQueue::marks); records accepted later neither hold nor hasten it, a thread loaded later is not asked, and one unloaded meanwhile counts once its close flushed (directory.rs SessionDirectory::durability_settled, actor.rs answer_settled). A record or append from before it that failed (outbox.rs Outbox::note_failed) answers an error naming the thread. Within a 20 s deadline that fails the call with what it waited for (mixdog-app-server-daemon replay_stores_settled.rs). Its answer must hold the number of threads asked; an error fails the replay with its message",
        writeBehind:
          "the same replay/storesSettled call, around the session step, with one shape for every writer (mixdog-rt write_marks.rs WriteMarks: each write numbered as accepted and reported written or failed; the call takes each writer's accepted count as it arrives and waits for its committed count to reach it, so writes accepted later neither hold nor hasten it, and a write from before it that failed answers an error naming the store): the agent index's row writes (mixdog-core-session agent_registry StoreWorkers::marks, which hand header changes to the threads before the session step), the read-state snapshots under core/data/read-snapshots (mixdog-tools read_state.rs ReadState::marks, their debounce cut short by ReadState::flush_pending), the gateway usage events in core/data/gateway-usage.local.jsonl (gateway_usage store.rs GatewayUsage::marks, then GatewayUsage::compact_scheduled_now), and the usage ledger when it is open (mixdog-ledger writer.rs UsageWriter::marks)",
        prompts:
          "the prompt-history files (core/data/tui-prompt-history): part of the session step (the appends a thread pushed before the call are written)",
        secretsStore:
          "no step: a secret is written on the durability lane inside the call that writes it and before that call answers (mixdog-secrets lib.rs on_lane, windows.rs DpapiStore::set); nothing is queued past the answer",
      },
    },
    // After the cases: every field the inventory refuses in a request or a notification, sent with a lone unit there and nothing
    // else (a frame is refused before its params are read). An answer's fields are not here: an answer only exists to a request
    // the core sent, and inventory_rule.rs fails each such request as classed.
    inventorySweep: {
      inventory: INVENTORY,
      methodTable: METHOD_TABLE,
      phoneOnly: {
        methods: phoneOnly,
        reason:
          'only a paired phone may call these (the method table: origins without local): they are sent by a phone paired through the replay\'s relay (lib/phone-relay-core.mjs openRawPhone), so the lone unit is what is refused; the answer is the JSON-RPC error frame of loneRefusal (code, message, data)',
      },
      languageServerLifecycle: {
        methods: LANGUAGE_SERVER_LIFECYCLE,
        reason:
          "the language server's closing handshake: the core shuts down a language server idle for 30 s on its own timer (Node: apps/desktop/src/main/language-server-process.ts LANGUAGE_SERVER_IDLE_MS), so it may reach the stub during any call of the sweep; these reports, and only these, are left out of the sweep's requests",
      },
      check:
        "a desktop request's client failure detail equals loneRefusal of `<method>.params<pointer>` whole; a phone-only request's answer frame is that refusal's JSON-RPC error with the phone's id; a notification is followed by the barrier, read after it; for each, no request reached the local server, the language server reported no message (it reports every request and notification it receives but the handshake), and worldFiles are unchanged across the barrier",
    },
  },
});
commitStage(stage, SET);
console.log(`lone-surrogate-wire: ${cases.length} cases`);
process.exit(0);
