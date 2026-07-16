// Configuration structure adapted from AiderDesk's electron.vite.config.ts.
// See src/shared/AIDERDESK_NOTICE.md for Apache-2.0 attribution.
import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'capture-window': resolve(__dirname, 'src/main/capture-window.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          // Sandboxed Electron preloads run through the CommonJS preload
          // loader even though the application package is ESM.
          format: 'cjs',
          entryFileNames: 'index.js',
        },
      },
    },
  },
  renderer: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    plugins: [react()],
    server: {
      host: '127.0.0.1',
    },
  },
});
