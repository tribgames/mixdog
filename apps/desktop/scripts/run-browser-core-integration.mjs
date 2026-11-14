// Runs a browser integration suite against a real mixdogd on an isolated profile, with Electron as the host.
//   node apps/desktop/scripts/run-browser-core-integration.mjs --suite <name|file> [--engine core|host]
// The core binary is a test-hooks build: MIXDOGD_TEST_BIN (else MIXDOGD_BIN, as scripts/dev-core-install.mjs lays out).
// The hook env is set only on the core this script starts; a packaged core never gets it.
import { existsSync, mkdtempSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isolatedEnv, isolatedPaths, stageProfile, waitServing } from '../../../scripts/rust-core/lib/core-session.mjs';
import { endTree, spawnTree } from '../../../scripts/rust-core/lib/process-tree.mjs';
import { computerSourceEsbuildPlugin } from './computer-source-assets.mjs';
import { bundleElectronEntry, electronProcessEnv, spawnElectron, waitForChildExit, withTempWorkspace } from './electron-harness.mjs';

const SUITE_LIMIT_MS = 90_000;
const STOP_MS = 15_000;

function flag(name) {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0) return process.argv[at + 1];
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const suiteArg = flag('suite');
const engine = flag('engine') ?? 'host';
if (!suiteArg || (engine !== 'core' && engine !== 'host')) {
  console.error('usage: run-browser-core-integration.mjs --suite <name|file> [--engine core|host]');
  process.exit(2);
}
const testSupport = fileURLToPath(new URL('../src/main/browser/test-support/', import.meta.url));
// A bare name is a suite of test-support/suites; anything else is a file.
const suiteFile = /[\\/.]/.test(suiteArg) ? resolve(suiteArg) : join(testSupport, 'suites', `${suiteArg}.suite.ts`);
const bin = process.env.MIXDOGD_TEST_BIN || process.env.MIXDOGD_BIN;
if (!bin || !existsSync(bin)) {
  console.error('MIXDOGD_TEST_BIN (a mixdogd built with --features test-hooks) names no file.');
  process.exit(2);
}
if (!existsSync(suiteFile)) {
  console.error(`no suite at ${suiteFile}`);
  process.exit(2);
}

/** Starts `mixdogd serve` on the isolated profile under `root`; resolves once it serves. */
async function startCore(root) {
  const paths = isolatedPaths(root);
  const exe = stageProfile(paths, { bin, config: {} });
  const child = spawnTree(exe, ['serve'], {
    env: isolatedEnv(paths, { MIXDOGD_TEST_HOOKS: '1' }),
    cwd: paths.root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const tail = [];
  for (const stream of ['stdout', 'stderr']) {
    child[stream].setEncoding('utf8');
    child[stream].on('data', (chunk) => {
      tail.push(...chunk.split(/\r?\n/).filter(Boolean));
      tail.splice(0, Math.max(0, tail.length - 40));
    });
  }
  const exited = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })));
  const failIfExited = exited.then(({ code, signal }) => {
    throw new Error(`the core exited (code=${code} signal=${signal}) before it was ready:\n${tail.join('\n')}`);
  });
  failIfExited.catch(() => {});
  try {
    const discovery = await Promise.race([waitServing(paths.runtimeRoot), failIfExited]);
    return { paths, discovery, child, exited };
  } catch (error) {
    await endTree(child).catch(() => {});
    throw error;
  }
}

/** The core's own stop (`POST /mgmt/stop`), then its exit; the tree is ended by its handle when that fails. */
async function stopCore({ discovery, child, exited }) {
  try {
    const response = await fetch(`http://127.0.0.1:${discovery.core.control.port}/mgmt/stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${discovery.endpoints.session.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'whenIdle', reason: 'quit' }),
      signal: AbortSignal.timeout(STOP_MS),
    });
    if (!response.ok) throw new Error(`/mgmt/stop answered ${response.status}`);
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('the core did not exit')), STOP_MS))]);
  } catch {
    await endTree(child).catch(() => {});
  }
}

const coreRoot = mkdtempSync(join(tmpdir(), 'mixdog-browser-core-'));
let core = null;
try {
  core = await startCore(coreRoot);
  await withTempWorkspace('mixdog-browser-core-integration-', async (staging) => {
    const output = join(staging, 'browser-core-integration.mjs');
    const entry = join(staging, 'entry.ts');
    const progressPath = join(staging, 'progress.log');
    await writeFile(
      entry,
      `import { runCoreHarnessSuite } from ${JSON.stringify(join(testSupport, 'core-harness.ts'))};\n` +
        `import suite from ${JSON.stringify(suiteFile)};\nrunCoreHarnessSuite(suite);\n`
    );
    await bundleElectronEntry({
      entry,
      outfile: output,
      plugins: [computerSourceEsbuildPlugin()],
      external: ['electron', 'ws'],
      sourcemap: 'inline',
    });
    const env = electronProcessEnv({
      MIXDOG_BROWSER_INTEGRATION_LOG: progressPath,
      MIXDOG_CORE_HARNESS_RUNTIME_ROOT: core.paths.runtimeRoot,
      MIXDOG_CORE_HARNESS_ENGINE: engine,
    });
    const child = spawnElectron(output, { env });
    let exitCode;
    try {
      exitCode = await waitForChildExit(child, {
        timeoutMs: SUITE_LIMIT_MS,
        timeoutMessage: `browser core integration exceeded ${SUITE_LIMIT_MS / 1000} seconds`,
        signalMessage: (signal) => `browser core integration was terminated by ${signal}`,
      });
    } finally {
      process.stdout.write(await readFile(progressPath, 'utf8').catch(() => ''));
    }
    const progress = await readFile(progressPath, 'utf8').catch(() => '');
    if (exitCode !== 0 || !progress.includes('integration passed')) {
      throw new Error(`browser core integration failed before its success marker (exit ${exitCode})`);
    }
  });
} finally {
  if (core) await stopCore(core);
  await rm(coreRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {});
}
