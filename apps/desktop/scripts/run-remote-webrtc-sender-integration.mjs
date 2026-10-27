// The live-view sender window in a real Electron with a real display:
// src/main/remote-webrtc/sender-window.integration.ts. The real sender
// document is built with Vite and the real CSP plugin (a file:// page, as in
// the packaged app), and its preload is bundled beside the entry the way the
// built app lays them out.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { build as viteBuild } from 'vite';

import {
  bundleElectronEntry,
  electronProcessEnv,
  spawnElectron,
  waitForChildExit,
  withTempWorkspace,
} from './electron-harness.mjs';
import { REMOTE_WEBRTC_SENDER_CSP, remoteWebrtcSenderCspPlugin } from './remote-webrtc-sender-csp.mjs';

await withTempWorkspace(
  'mixdog-sender-',
  async (staging) => {
    const entry = join(staging, 'sender-window.mjs');
    await bundleElectronEntry({
      entry: new URL('../src/main/remote-webrtc/sender-window.integration.ts', import.meta.url),
      outfile: entry,
    });
    await build({
      entryPoints: [fileURLToPath(new URL('../src/preload/remote-webrtc-sender.ts', import.meta.url))],
      outfile: join(staging, 'out', 'preload', 'remote-webrtc-sender.js'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      logLevel: 'warning',
    });
    await viteBuild({
      configFile: false,
      root: fileURLToPath(new URL('../src/renderer', import.meta.url)),
      base: './',
      publicDir: false,
      logLevel: 'warning',
      plugins: [remoteWebrtcSenderCspPlugin()],
      build: {
        outDir: join(staging, 'renderer'),
        emptyOutDir: true,
        target: 'chrome144',
        modulePreload: { polyfill: false },
        rollupOptions: { input: fileURLToPath(new URL('../src/renderer/remote-webrtc-sender.html', import.meta.url)) },
      },
    });
    const child = spawnElectron(entry, {
      env: electronProcessEnv({ MIXDOG_SENDER_ROOT: staging, MIXDOG_SENDER_CSP: REMOTE_WEBRTC_SENDER_CSP }),
    });
    const code = await waitForChildExit(child, {
      timeoutMs: 60_000,
      timeoutMessage: 'Sender window integration exceeded 60 seconds',
    });
    if (code !== 0) throw new Error(`Sender window integration failed (exit ${code})`);
  },
  { maxRetries: 10, retryDelay: 150 }
);
