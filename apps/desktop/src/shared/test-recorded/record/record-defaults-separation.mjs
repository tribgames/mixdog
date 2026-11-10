// Records what Node's own boot wrote for a failed defaults separation. Nothing here writes a boot line itself: the two functions that
// do (`startDesktopDiagnostics`, `reportDaemonServiceStart` of apps/desktop/src/main/index.ts) are cut out of the pinned source by the
// TypeScript AST and run unchanged beside the pinned writer (apps/desktop/src/main/desktop-diagnostics.ts).
//
//   node record-defaults-separation.mjs --node-repo <repository that has the Node commit>
//
// Both files come from `git show b6f10295a:<path>`, never the index or a working tree. Each function is the one top-level
// FunctionDeclaration of that name, sliced as `source.slice(node.getStart(sourceFile), node.end)` and transpiled with no rewrite.
// They run in one factory closure that owns the names the functions mutate (`diagnostics`, `daemonServiceStartedAt`,
// `daemonServiceBootReported`) and is given every other free name as an input: isolated temp directories, a rejected
// `separateDefaults()` carrying the recorded error, no-op sink setters and watchers, and the pinned writer wrapped only to learn
// when the failure line has been handed to it (the wrapper forwards the call first). Time is the test runner's virtual Date.
// Writes ../defaults-separation.node-boot.json: an `exact: true` manifest of inputs and provenance, and the complete JSONL bytes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import { NODE_COMMIT, NODE_TREE } from './node-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const flag = process.argv.indexOf('--node-repo');
if (flag < 0 || !process.argv[flag + 1]) throw new Error('usage: node record-defaults-separation.mjs --node-repo <repository with ' + NODE_COMMIT + '>');
const nodeRepo = resolve(process.argv[flag + 1]);

const git = (...args) => {
  const run = spawnSync('git', ['-C', nodeRepo, ...args], { encoding: 'buffer', maxBuffer: 1 << 26 });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
};
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const treeId = git('rev-parse', `${NODE_COMMIT}^{tree}`).toString().trim();
if (treeId !== NODE_TREE) throw new Error(`${NODE_COMMIT} has tree ${treeId}, expected ${NODE_TREE}`);

const INDEX = 'apps/desktop/src/main/index.ts';
const WRITER = 'apps/desktop/src/main/desktop-diagnostics.ts';
const files = Object.fromEntries([INDEX, WRITER].map((path) => {
  const bytes = git('show', `${NODE_COMMIT}:${path}`);
  return [path, { path, blob: git('rev-parse', `${NODE_COMMIT}:${path}`).toString().trim(), sha256: sha256(bytes), text: bytes.toString('utf8') }];
}));

const sourceFile = ts.createSourceFile(INDEX, files[INDEX].text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const transpile = (text) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const extract = (name) => {
  const found = sourceFile.statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (found.length !== 1) throw new Error(`${INDEX} has ${found.length} top-level function declarations named ${name}, expected exactly 1`);
  const [node] = found;
  const slice = sourceFile.text.slice(node.getStart(sourceFile), node.end);
  const line = (pos) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  return { name, file: INDEX, lines: [line(node.getStart(sourceFile)), line(node.end)], sha256: sha256(slice), js: transpile(slice) };
};
const functions = [extract('reportDaemonServiceStart'), extract('startDesktopDiagnostics')];

// Inputs. Process metadata is the recording machine's own (what the functions read from `process`), kept in the manifest.
const T0 = Date.UTC(2026, 0, 2, 3, 4, 0);
const inputs = {
  desktopProcessStartedAt: T0,
  daemonServiceStartedAt: T0 + 300,
  appReadyAt: T0 + 900,
  now: T0 + 1500,
  appVersion: '1.2.3',
  packaged: true,
  desktopBootId: 'boot-1',
  desktopBootScenario: 'defaults-failure',
  softwareRenderingThisLaunch: false,
  crashReporterStatus: 'started',
  crashReporterErrorName: '',
  gpuFallbackMarker: null,
  early: [{ event: 'login-shell-environment', entry: { durationMs: 12 }, at: '2026-01-02T03:04:04.000Z' }],
  error: { class: 'Error', message: "EACCES: permission denied, open 'mixdog-config.json'" },
  process: {
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    versions: { node: process.versions.node, electron: process.versions.electron ?? null, chrome: process.versions.chrome ?? null },
  },
};

const work = mkdtempSync(join(tmpdir(), 'record-defaults-'));
try {
  writeFileSync(join(work, 'desktop-diagnostics.mjs'), transpile(files[WRITER].text));
  const names = [
    'createDesktopDiagnostics', 'join', 'app', 'earlyDiagnostics', 'desktopBootId', 'desktopBootScenario', 'desktopProcessStartedAt',
    'setTranscriptReadDiagnosticSink', 'setPageFaultDiagnosticSink', 'settingsStore', 'mixdogDataDirectory', 'softwareRenderingThisLaunch',
    'crashReporterStatus', 'crashReporterErrorName', 'gpuFallbackMarker', 'startCrashHandlerWatch', 'startDiagnosticsEventLoopMonitor',
    'initialDaemonServiceStartedAt',
  ];
  writeFileSync(
    join(work, 'boot.mjs'),
    `export function factory({ ${names.join(', ')} }) {\n  let diagnostics = null;\n  let daemonServiceStartedAt = initialDaemonServiceStartedAt;\n  let daemonServiceBootReported = false;\n` +
      functions.map((f) => f.js).join('\n') +
      `\n  return { startDesktopDiagnostics };\n}\n`
  );
  const { createDesktopDiagnostics } = await import(pathToFileURL(join(work, 'desktop-diagnostics.mjs')).href);
  const { factory } = await import(pathToFileURL(join(work, 'boot.mjs')).href);

  mock.timers.enable({ apis: ['Date'], now: inputs.now });
  const userData = join(work, 'userData');
  const dataDir = join(work, 'data');
  let reached;
  const failureWritten = new Promise((done) => (reached = done));
  let log;
  const boot = factory({
    // The pinned writer, wrapped only to learn that the failure line was handed to it: the call is forwarded first.
    createDesktopDiagnostics: (file, context) => {
      const real = createDesktopDiagnostics(file, context);
      log = real;
      return {
        ...real,
        write(event, details) {
          real.write(event, details);
          if (event === 'defaults-separation-failed') reached();
        },
      };
    },
    join,
    app: { getPath: () => userData, getVersion: () => inputs.appVersion, isPackaged: inputs.packaged },
    earlyDiagnostics: structuredClone(inputs.early),
    desktopBootId: inputs.desktopBootId,
    desktopBootScenario: inputs.desktopBootScenario,
    desktopProcessStartedAt: inputs.desktopProcessStartedAt,
    setTranscriptReadDiagnosticSink: () => undefined,
    setPageFaultDiagnosticSink: () => undefined,
    // The rejection carries the recorded error, created here in the same realm the function runs in.
    settingsStore: { separateDefaults: () => Promise.reject(new Error(inputs.error.message)) },
    mixdogDataDirectory: () => dataDir,
    softwareRenderingThisLaunch: inputs.softwareRenderingThisLaunch,
    crashReporterStatus: inputs.crashReporterStatus,
    crashReporterErrorName: inputs.crashReporterErrorName,
    gpuFallbackMarker: inputs.gpuFallbackMarker,
    startCrashHandlerWatch: () => undefined,
    startDiagnosticsEventLoopMonitor: () => undefined,
    initialDaemonServiceStartedAt: inputs.daemonServiceStartedAt,
  });
  boot.startDesktopDiagnostics(inputs.appReadyAt);
  await failureWritten;
  await log.flush();
  const jsonl = readFileSync(log.filePath, 'utf8');
  mock.timers.reset();
  writeFileSync(
    join(here, '..', 'defaults-separation.node-boot.json'),
    JSON.stringify(
      {
        exact: true,
        source: {
          commit: NODE_COMMIT,
          tree: treeId,
          files: [INDEX, WRITER].map((path) => ({ path, blob: files[path].blob, sha256: files[path].sha256 })),
          functions: functions.map(({ js, ...meta }) => meta),
        },
        inputs,
        lines: jsonl.split('\n').filter(Boolean),
        jsonl,
      },
      null,
      2
    ) + '\n'
  );
  console.log('recorded defaults-separation');
} finally {
  mock.timers.reset();
  rmSync(work, { recursive: true, force: true });
}
