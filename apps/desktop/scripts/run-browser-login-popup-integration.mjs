// The sign-in window of a login takeover in a real Electron:
// src/main/browser/login-popup.integration.ts.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import {
  bundleElectronEntry,
  electronProcessEnv,
  spawnElectron,
  waitForChildExit,
  withTempWorkspace,
} from './electron-harness.mjs';

await withTempWorkspace(
  'mixdog-login-popup-',
  async (staging) => {
    const entry = join(staging, 'login-popup.mjs');
    await bundleElectronEntry({
      entry: new URL('../src/main/browser/login-popup.integration.ts', import.meta.url),
      outfile: entry,
    });
    // Sandboxed preloads load as CommonJS.
    await build({
      entryPoints: [fileURLToPath(new URL('../src/preload/browser-login.ts', import.meta.url))],
      outfile: join(staging, 'browser-login.js'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      logLevel: 'warning',
    });
    const child = spawnElectron(entry, { env: electronProcessEnv({ MIXDOG_LOGIN_POPUP_ROOT: staging }) });
    const code = await waitForChildExit(child, {
      timeoutMs: 60_000,
      timeoutMessage: 'Sign-in window integration exceeded 60 seconds',
    });
    if (code !== 0) throw new Error(`Sign-in window integration failed (exit ${code})`);
  },
  { maxRetries: 10, retryDelay: 150 }
);
