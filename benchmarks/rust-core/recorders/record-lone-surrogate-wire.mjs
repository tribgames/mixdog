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
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { CASES, PORT, PROJECT, ROOT, loneRefusal } from './lib/lone-surrogate-wire-cases.mjs';
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
 *  model, everything else is 404. */
export async function startServer() {
  const log = [];
  const server = createServer((req, res) => {
    const at = req.rawHeaders.findIndex((name, index) => index % 2 === 0 && name.toLowerCase() === 'x-token');
    log.push({ method: req.method, url: req.url, xToken: at < 0 ? null : Buffer.from(req.rawHeaders[at + 1], 'latin1').toString('hex') });
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

export function buildWorld() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
  writeFileSync(join(PROJECT, 'a.rs'), 'fn main() {}\n');
}

if (REPLAY) {
  const { replay } = await import('./lib/lone-surrogate-wire-replay.mjs');
  process.exit(await replay({ exe: REPLAY, golden: JSON.parse(readFileSync(join(SET, 'golden.json'), 'utf8')), only: ONLY, startServer, buildWorld }));
}

const tree = resolveTree(args);
const identity = exactProductIdentity(tree, COMMIT);
// Nothing of the signed-in profile is read or written.
const STATE = `${ROOT}-node-state`;
rmSync(STATE, { recursive: true, force: true });
for (const dir of ['home', 'data', 'userData', 'profile']) mkdirSync(join(STATE, dir), { recursive: true });
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = join(STATE, 'profile');
Object.assign(process.env, { MIXDOG_HOME: join(STATE, 'home'), MIXDOG_DATA_DIR: join(STATE, 'data'), MIXDOG_SKIP_USER_DATA_BACKUP: '1' });
buildWorld();

const at = (path) => importFrom(tree, path);
const mcpClient = await at('src/runtime/agent/orchestrator/mcp/client.mjs');
const { createMixdogSessionRuntime } = await at('src/mixdog-session-runtime.mjs');
const { probeMcpServerAuth } = await at('src/runtime/agent/orchestrator/mcp/oauth-probe.mjs');
const admin = await at('src/session-runtime/services/provider-admin.mjs');
const { createHuggingFaceCatalog } = await at('src/runtime/local-provider/hugging-face.mjs');
const { createDesktopOperations } = await at('apps/desktop/src/main/desktop-operations.ts');

// The language server: the echo stub, found on PATH as `rust-analyzer` (the product resolves it like any server).
const stubBin = join(ROOT, 'stub-bin');
mkdirSync(stubBin);
const stubScript = fileURLToPath(new URL('./lib/lsp-echo-stub.mjs', import.meta.url));
writeFileSync(join(stubBin, 'rust-analyzer.cmd'), `@"${process.execPath}" "${stubScript}" %*\r\n`);
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
    ...recorderProvenance(import.meta.url),
    exclusions: [],
    // The MCP cases' config read after the call: Node keeps the header value with its lone unit; the core holds it as U+FFFD (the
    // accepted echo difference, decisions.md "frame-lone-surrogate"). Its status, error text included, is compared unchanged.
    normalisations: [{ cases: CASES.filter((entry) => entry.after).map((entry) => entry.name), field: 'node.config.value.config.headers.*', how: 'each lone surrogate read as U+FFFD before comparing' }],
    // Cases the core refuses by decision: the field is not free text (mixdog-app-protocol free_text.rs, tests/it/free_text_fields.json).
    // Node's answer and what reached the local server are recorded (golden.json cases[].node, cases[].requests).
    refusedByRule: {
      decision: 'decisions.md "frame-lone-surrogate": a lone surrogate outside the free-text fields refuses the request whole before any service runs',
      cases: CASES.filter((entry) => entry.refused).map((entry) => ({
        case: entry.name,
        field: entry.refused,
        nodeAnswered: cases.find((recorded) => recorded.name === entry.name).node,
        nodeRequests: cases.find((recorded) => recorded.name === entry.name).requests,
        coreMustAnswer: loneRefusal(entry.refused),
      })),
      check: 'the client failure detail equals coreMustAnswer whole; the local server got no request; for an MCP server, mcp/getMcpServerConfig answers for its name as for a name never added',
    },
    // Compared outside the replay: the Hugging Face search URL, by mixdog-services local_provider/hugging_face.rs (its HTTP is
    // a trait there; the core's catalog has no address but huggingface.co).
    replayedByRustTest: [{ case: 'hf-search-lone', test: 'mixdog-services local_provider::hugging_face::tests::a_query_holding_a_lone_surrogate_is_the_url_node_fetched' }],
  },
});
commitStage(stage, SET);
console.log(`lone-surrogate-wire: ${cases.length} cases`);
process.exit(0);
