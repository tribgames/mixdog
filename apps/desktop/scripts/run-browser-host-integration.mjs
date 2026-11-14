import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computerSourceEsbuildPlugin } from './computer-source-assets.mjs';
import {
  bundleElectronEntry,
  electronProcessEnv,
  spawnElectron,
  waitForChildExit,
  withTempWorkspace,
} from './electron-harness.mjs';

// Suites that default-export a CoreHarnessSuite run through run-browser-core-integration.mjs (a mixdogd on an isolated profile, Electron as
// the host), in the modes listed: `host` sends the commands as the desktop's own (browser/command), `core` through the core's engine.
const CORE_SUITES = {
  host: ['host', 'core'],
  'golden-twin': ['host', 'core'],
  'popup-blank': ['host'],
  'user-dialogs': ['host'],
};
// Entries that start their own Electron main.
const STANDALONE_ENTRIES = ['cdp-lifecycle', 'document-checkpoint', 'file-snapshot-host'];

function integrationEntryName() {
  for (const name of [...STANDALONE_ENTRIES, 'popup-blank', 'user-dialogs', 'golden-twin']) {
    if (process.argv.includes(`--${name}`)) return name;
  }
  return 'host';
}

function runCoreSuite(name, engine, env) {
  const runner = fileURLToPath(new URL('./run-browser-core-integration.mjs', import.meta.url));
  const suite = fileURLToPath(new URL(`../src/main/browser/${name}.integration.ts`, import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, '--suite', suite, '--engine', engine], { env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`browser ${name} integration (${engine} mode) failed: ${signal ? `terminated by ${signal}` : `exit ${code}`}`));
    });
  });
}

const entryName = integrationEntryName();
// --user-dialogs, --popup-blank and --golden-twin run one presentation per process: --native picks it.
const presentationRun = ['user-dialogs', 'popup-blank', 'golden-twin'].includes(entryName);
const nativeView = process.argv.includes('--native') ? '1' : '0';

if (CORE_SUITES[entryName]) {
  const env = {
    ...process.env,
    MIXDOG_BROWSER_CONTINUATION_ONLY: process.argv.includes('--action-continuation') ? '1' : '0',
    ...(presentationRun ? { MIXDOG_BROWSER_NATIVE_VIEW: nativeView } : {}),
  };
  for (const engine of CORE_SUITES[entryName]) await runCoreSuite(entryName, engine, env);
} else await withTempWorkspace('mixdog-browser-host-integration-', async (staging) => {
  const output = join(staging, 'browser-host-integration.mjs');
  const progressPath = join(staging, 'progress.log');
  let progressPrinted = false;
  try {
    await bundleElectronEntry({
      entry: new URL(`../src/main/browser/${entryName}.integration.ts`, import.meta.url),
      outfile: output,
      plugins: [computerSourceEsbuildPlugin()],
      external: ['electron', 'ws'],
      sourcemap: 'inline',
    });

    const env = electronProcessEnv({
      MIXDOG_BROWSER_INTEGRATION_LOG: progressPath,
      MIXDOG_BROWSER_CONTINUATION_ONLY: process.argv.includes('--action-continuation') ? '1' : '0',
    });
    const child = spawnElectron(output, { env });
    const exitCode = await waitForChildExit(child, {
      timeoutMs: 90_000,
      timeoutMessage: 'browser host integration exceeded 90 seconds',
      signalMessage: (signal) => `browser host integration was terminated by ${signal}`,
    });
    const progress = await readFile(progressPath, 'utf8').catch(() => '');
    if (progress) {
      process.stdout.write(progress);
      progressPrinted = true;
    }
    if (exitCode !== 0 || !progress.includes('integration passed')) {
      throw new Error(`browser host integration failed before its success marker (exit ${exitCode})`);
    }
  } finally {
    const progress = await readFile(progressPath, 'utf8').catch(() => '');
    if (progress && !progressPrinted) {
      process.stderr.write(progress);
    }
  }
});
