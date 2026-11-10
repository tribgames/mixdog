#!/usr/bin/env node
// What Node's host (b6f10295a) answered a paired phone for the browser and capability calls the Rust core must refuse or narrow
// for a relay connection, and which visualize panes it rendered as pages: the relay's own frame executor (`executeRemoteFrame` over
// `createRemoteMethods`, remote-methods.ts) with stand-ins only for what the table forwards to (`browserRemote`,
// `host.invokeCapability`, the window's visualize state and `invokeDesktopOperation`), each forwarded call recorded. Per call the
// recording holds the params the phone sent, the frame the relay answered (value, or error with its `errorCode`) and what was
// forwarded.
//
//   node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-phone-guards.mjs --tree <git archive of b6f10295a with node_modules> [--only <scenario>]
// Output: native/core/fixtures/phone-guards/golden.json (the full run only; `--only` prints the one scenario).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const WORLD = 'D:\\mixdog-build\\tmp\\w23-phone-guards';
const args = parseArgs();
const ONLY = args.get('only') ?? null;
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, REF);
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));
const main = (name) => importFrom(tree, `apps/desktop/src/main/${name}.ts`);
const { createRemoteMethods, executeRemoteFrame } = await main('remote-methods');
const { createRemoteVisualizeMirror, createRemoteVisualizeMethods } = await main('remote-visualize');

/** One frame through the executor; the forwarded calls the frame caused. */
async function frameOf(methods, forwarded, method, params) {
  forwarded.length = 0;
  const frame = await executeRemoteFrame(methods, JSON.stringify({ id: 1, method, params }));
  const { id: _id, ...answer } = clone(frame);
  return { method, params: clone(params), frame: answer, forwarded: forwarded.splice(0) };
}

/** The browser rows: the phone's eight browser methods, refused session ids, and names outside the phone's table (the host's
 *  agent and runtime-only browser actions, and the window's own `browserRemote` names). */
async function browser() {
  const forwarded = [];
  const browserRemote = async (method, callArgs) => {
    forwarded.push({ method, args: clone(callArgs) });
    return { forwarded: method };
  };
  const methods = createRemoteMethods({ host: {}, browserRemote });
  const calls = [
    ['browserRemoteControl', ['s1', { type: 'back' }]],
    ['browserRemoteControl', [' s1 ', { type: 'reload' }]],
    ['browserRemoteControl', [42, { type: 'back' }]],
    ['browserRemoteControl', [null, { type: 'back' }]],
    ['browserRemoteControl', ['', { type: 'back' }]],
    ['browserRemoteControl', ['   ', { type: 'back' }]],
    ['browserRemoteControl', ['bad id', { type: 'back' }]],
    ['browserRemoteControl', ['../s1', { type: 'back' }]],
    ['browserRemoteControl', ['x'.repeat(256), { type: 'back' }]],
    ['browserRemoteControl', ['x'.repeat(257), { type: 'back' }]],
    ['browserRemoteControl', [42, { type: 'bogus' }]],
    ['browserRemoteTabOpen', ['https://example.test/']],
    ['browserRemoteTabClose', ['main-browser-1']],
    ['browserReleasePage', ['main-browser-1']],
    ['browserHistorySearch', ['query']],
    ['browserCredentialSuggestions', ['s1']],
    ['browserCredentialFill', ['s1', 'a'.repeat(24)]],
    ['browserProfileImportSources', []],
    ['browserProfileImportStart', [{ jobId: 'job-12345', sourceId: 'chrome', profileId: 'Default', items: ['history'] }]],
    ...[
      'navigate',
      'snapshot',
      'click',
      'type',
      'evaluate',
      'saved_login_admit',
      'saved_login_value',
      'saved_login_check',
      'saved_login_type',
      'saved_login_release',
      'secret_precheck',
      'secret_fill',
      'begin_turn',
      'finish_turn',
      'control',
      'stream',
      'tabsWatch',
      'webrtcSignal',
      'screenAccess',
      'constructor',
      '',
    ].map((name) => [name, [{ session_id: 's1', turn_id: 1 }]]),
  ];
  const steps = [];
  for (const [method, params] of calls) steps.push(await frameOf(methods, forwarded, method, params));
  return steps;
}

/** `invokeCapability` for the capabilities Node refused or narrowed over remote access, each with arguments that pass its
 *  argument rules, and the ones it forwarded with `{ noWiden: true }`. */
async function capability() {
  const forwarded = [];
  const host = {
    invokeCapability: async (name, callArgs, sessionId) => {
      forwarded.push({ capability: name, args: clone(callArgs), ...(sessionId === undefined ? {} : { sessionId }) });
      return { value: { ran: name } };
    },
    invokeDesktopOperation: async () => null,
  };
  const methods = createRemoteMethods({ host });
  const requests = [
    { capability: 'resolveMediaFile', args: ['asset-1'] },
    { capability: 'listImportableConversations', args: [{ source: 'codex' }] },
    { capability: 'getConversationImportJobs', args: [] },
    { capability: 'registerConversationImportFile', args: [{ source: 'claude', path: 'C:\\x\\a.jsonl' }] },
    { capability: 'startConversationImport', args: [{ requestId: 'r1', selection: { ids: ['a'] } }] },
    { capability: 'cancelConversationImport', args: [{ jobId: 'j1' }] },
    { capability: 'recordAgentApprovalAudit', args: ['alpha', 'email', 'allow'] },
    { capability: 'setAgentPermission', args: ['alpha', 'email', 'allow'] },
    { capability: 'setAgentPermission', args: ['alpha', 'email', 'ask'] },
    { capability: 'setAgentPermission', args: ['alpha', 'email', 'block'] },
    { capability: 'setAgentPermission', args: ['alpha', 'email', 'Allow'] },
    { capability: 'setDeveloperOption', args: ['allowAllActions', true] },
    { capability: 'setDeveloperOption', args: ['allowAllActions', false] },
    { capability: 'setDeveloperOption', args: ['otherOption', true] },
    { capability: 'setAgentConnectors', args: ['alpha', { off: [] }] },
    { capability: 'setAgentConnectorEnabled', args: ['alpha', 'gmail', true] },
    { capability: 'setAgentConnectorToolPermission', args: ['alpha', 'gmail', 'send_email', 'auto'] },
    { capability: 'setProjectConnectorEnabled', args: ['C:\\p', 'gmail', true] },
    { capability: 'saveAgentDefinition', args: [{ id: 'alpha', name: 'Alpha', body: 'x' }] },
    { capability: 'setAgentConnectorEnabled', args: ['alpha', 'gmail', true, { noWiden: false }] },
  ];
  const steps = [];
  for (const request of requests) steps.push(await frameOf(methods, forwarded, 'invokeCapability', [request]));
  return steps;
}

/** `visualizePanePages` over the daemon's mirror of one snapshot: which panes Node rendered as pages (the file the conversion was
 *  given, by its bytes) and which it refused. */
async function visualize() {
  rmSync(WORLD, { recursive: true, force: true });
  const cwd = join(WORLD, 'cwd');
  const kept = join(WORLD, 'kept');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(kept, { recursive: true });
  const files = {
    [join(cwd, 'report.pdf')]: 'report pdf bytes',
    [join(cwd, 'page.html')]: '<p>page</p>',
    [join(cwd, 'img.png')]: 'png bytes',
    [join(kept, 'notes.docx')]: 'kept docx bytes',
  };
  for (const [path, text] of Object.entries(files)) writeFileSync(path, text);
  const pane = (kind, path, extra = {}) => ({ kind, label: kind, target: path, path, remoteTarget: kind, ...extra });
  const snapshot = [
    {
      sessionId: 's1',
      tabs: [
        {
          id: 't1',
          label: 'Tab',
          remoteLabel: 'Tab',
          revision: 1,
          cwd,
          panes: [
            pane('pdf', join(cwd, 'report.pdf')),
            pane('html', join(cwd, 'page.html')),
            pane('document', join(kept, 'notes.docx'), { root: kept, version: 1 }),
            pane('image', join(cwd, 'img.png')),
          ],
        },
      ],
      active: 't1',
    },
  ];
  const forwarded = [];
  const mirror = createRemoteVisualizeMirror();
  const hostRequest = async (method) => {
    if (method === 'visualizeState') return clone(snapshot);
    throw new Error(`unexpected ${method}`);
  };
  const invokeDesktopOperation = async (name, callArgs) => {
    // The conversion gets a private copy of the authorized file: its bytes name the pane's file.
    forwarded.push({ operation: name, bytes: readFileSync(join(callArgs[0], callArgs[1]), 'utf8'), options: clone(callArgs[2]) });
    return { pageCount: 1, pages: [] };
  };
  mirror.replace(clone(snapshot));
  const methods = createRemoteVisualizeMethods({ mirror, hostRequest, invokeDesktopOperation });
  const steps = [];
  for (const index of [0, 1, 2, 3, 4]) {
    steps.push(await frameOf(methods, forwarded, 'visualizePanePages', ['s1', 't1', index, { pages: [1] }]));
  }
  return { snapshot, steps };
}

const SCENARIOS = { browser, capability, visualize };
if (ONLY) {
  if (!SCENARIOS[ONLY]) throw new Error(`no scenario ${ONLY}; one of ${Object.keys(SCENARIOS).join(', ')}`);
  const text = `${JSON.stringify(await SCENARIOS[ONLY](), null, 2)}\n`;
  // The stream's own completion callback, which also carries its error.
  await new Promise((written, failed) => process.stdout.write(text, (error) => (error ? failed(error) : written())));
  process.exit(0);
}
const scenarios = {};
for (const [name, run] of Object.entries(SCENARIOS)) scenarios[name] = await run();
const finalDir = join(FIXTURES_ROOT, 'phone-guards');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), {
  note: 'Node host frames to a paired phone for the browser and capability calls a relay connection is refused or narrowed on, and the visualize panes it renders as pages; each with what the table forwarded.',
  scenarios,
});
writeSetManifest(stage, {
  set: 'phone-guards',
  recorder: 'benchmarks/rust-core/recorders/record-phone-guards.mjs',
  command: `node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs benchmarks/rust-core/recorders/record-phone-guards.mjs --tree <git archive of ${REF} (src, apps) with node_modules>`,
  identity,
  extra: { steps: scenarios.browser.length + scenarios.capability.length + scenarios.visualize.steps.length },
});
commitStage(stage, finalDir);
console.log(`phone-guards: ${scenarios.browser.length} browser, ${scenarios.capability.length} capability, ${scenarios.visualize.steps.length} visualize steps`);
process.exit(0);
