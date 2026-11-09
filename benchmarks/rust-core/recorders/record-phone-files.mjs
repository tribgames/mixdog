#!/usr/bin/env node
// What Node's host (b6f10295a) answers the paired phone for the "Files and editor" and "Project list" calls, recorded from an exact
// export: the relay's own frame executor (`executeRemoteFrame` over `createRemoteMethods`, remote-methods.ts) on top of a real
// `SessionHost` (project registry, project files, search) and the real desktop operations (`createDesktopOperations`), run on a scratch
// world. Per call the recording holds the params the phone sent, the frame the relay sent back (value, or error with its `errorCode`)
// and what the PC's window was asked (trash, snapshot, local page). The script is lib/phone-files-script.mjs; the world's final tree
// is recorded whole.
//
//   node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-phone-files.mjs --tree <git archive of b6f10295a with node_modules>
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitStage, exactProductIdentity, importFrom, parseArgs, REPO_ROOT, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { filesRelayScript, filesScript, filesWorld, play, treeOf, windowAnswers } from './lib/phone-files-script.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const FIXTURES = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'phone-files');
const args = parseArgs();
const REPLAY = args.get('replay') ?? null;
const tree = resolveTree(args);
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

const world = filesWorld();
// Nothing of the signed-in profile is read or written: the project registry and the data dir live beside the world, before any module loads.
const STATE = `${world.root}-state`;
rmSync(STATE, { recursive: true, force: true });
mkdirSync(join(STATE, 'home'), { recursive: true });
mkdirSync(join(STATE, 'data'), { recursive: true });
process.env.MIXDOG_HOME = join(STATE, 'home');
process.env.MIXDOG_DATA_DIR = join(STATE, 'data');
process.env.MIXDOG_PROJECTS_FILE = join(STATE, 'projects.json');

if (REPLAY) {
  const { replayFiles } = await import('./lib/phone-files-replay.mjs');
  process.exit(await replayFiles({ exe: REPLAY, world, golden: JSON.parse(readFileSync(join(FIXTURES, 'golden.json'), 'utf8')) }));
}

const main = (name) => importFrom(tree, `apps/desktop/src/main/${name}.ts`);
const { SessionHost } = await main('session-host');
const { createDesktopOperations } = await main('desktop-operations');
const { createRemoteMethods, executeRemoteFrame, createSelectedFileGrants } = await main('remote-methods');
const { codeGraphModuleUrl } = await main('desktop-support');
const store = await importFrom(tree, 'src/runtime/shared/projects.mjs');

/** One scenario on a fresh world: its own host, project registry, grants and window. */
async function record(make) {
  const scenario = make(world);
  rmSync(process.env.MIXDOG_PROJECTS_FILE, { force: true });
  world.build();
  const sessionClient = { list: async () => ({ sessions: [] }), close: async () => {} };
  const host = await SessionHost.create(
    { userDataPath: world.userData, resourcesPath: world.root, appPath: join(tree, 'apps', 'desktop'), packaged: false },
    {
      attachSessionClient: async () => sessionClient,
      loadProjects: async () => store,
      loadSessionStore: async () => ({ listStoredAgentWorkers: () => [] }),
      loadStatuslineSegments: async () => ({}),
      executeCodeGraphTool: async (name, toolArgs, cwd) => (await import(codeGraphModuleUrl(false, world.root, join(tree, 'apps', 'desktop')))).executeCodeGraphTool(name, toolArgs, cwd),
    }
  );
  const operations = createDesktopOperations({ userDataPath: world.userData, packaged: false, resourcesPath: '', appPath: join(tree, 'apps', 'desktop'), loadConfig: async () => ({}), loadDocumentPreview: () => importFrom(tree, 'src/runtime/office/pdf/document-preview.mjs'), emit() {} });
  host.invokeDesktopOperation = (name, operationArgs) => operations.invoke(name, operationArgs);

  // The PC's window answers as the script scripts it (lib/phone-files-script.mjs); what it was asked is recorded.
  const hostLog = [];
  const hostRequest = async (method, requestArgs) => {
    hostLog.push({ method, args: clone(requestArgs) });
    return windowAnswers[method](...requestArgs);
  };
  const grants = createSelectedFileGrants(() => false);
  const tables = {
    without: createRemoteMethods({ host, userDataPath: world.userData, selectedFileGrants: grants }),
    with: createRemoteMethods({ host, userDataPath: world.userData, selectedFileGrants: grants, hostRequest }),
  };
  let windowUp = false;
  let frameId = 0;
  const driver = {
    async call(name, params) {
      hostLog.length = 0;
      const frame = await executeRemoteFrame(tables[windowUp ? 'with' : 'without'], JSON.stringify({ id: ++frameId, method: name, params }));
      const { id: _id, ...answer } = clone(frame);
      if (process.env.FILES_DEBUG) console.log(name, JSON.stringify(params).slice(0, 120), '=>', JSON.stringify(answer).slice(0, 300));
      return { frame: answer, hostCalls: hostLog.splice(0) };
    },
    grant: (path) => grants.rememberFileGrant(path, ''),
    host: (on) => {
      windowUp = on;
    },
    pin: (path, ms) => utimesSync(path, ms / 1000, ms / 1000),
    write: (path, text) => writeFileSync(path, text),
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    mkdir: (path) => mkdirSync(path, { recursive: true }),
  };
  const trace = await play(scenario, driver);
  await host.dispose();
  await operations.dispose();
  return { ...trace, finalTree: treeOf(world.root) };
}

const scenarios = { main: await record(filesScript), relay: await record(filesRelayScript) };
const out = stageSet(FIXTURES);
writeJson(join(out, 'golden.json'), {
  note: 'Node host answers to the phone for the Files and editor and Project list calls: per call its frame (value, or error with errorCode) and what the PC window was asked; the world tree after the script.',
  root: world.root,
  scenarios,
});
writeSetManifest(out, {
  set: 'phone-files',
  recorder: 'benchmarks/rust-core/recorders/record-phone-files.mjs',
  command: `node benchmarks/rust-core/recorders/record-phone-files.mjs --tree <git archive of ${REF} (src, apps) with node_modules>`,
  identity: exactProductIdentity(tree, REF),
  extra: { steps: scenarios.main.steps.length + scenarios.relay.steps.length },
});
commitStage(out, FIXTURES);
console.log(`phone-files: ${scenarios.main.steps.length} + ${scenarios.relay.steps.length} steps`);
process.exit(0);