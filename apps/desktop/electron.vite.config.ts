// electron-vite configuration for the desktop app.
// Third-party derivation notices: NOTICE.md at the repository root.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// SWC transform (user: 빌드 과정이 느리다): no custom babel plugins exist, so
// the babel-based @vitejs/plugin-react only cost time — SWC cuts the 3600-
// module renderer transform roughly in half.
import react from '@vitejs/plugin-react-swc';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';

const selectedBuildTargets = new Set(
  String(process.env.MIXDOG_ELECTRON_BUILD_TARGETS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const buildTargetEnabled = (target: 'main' | 'preload' | 'renderer'): boolean =>
  selectedBuildTargets.size === 0 || selectedBuildTargets.has(target);

// Every bundled face (Inter/Geist/JetBrains Mono + Pretendard's 92 Hangul
// subset slices) ships with font-display:swap, so text created AFTER first
// paint — menu/tab navigation, new session rows — painted fallback glyphs and
// then visibly swapped + reflowed when the woff2 landed (user: 메뉴 이동 시
// 레이아웃 쉬프트/폰트 튐).
//
// `block` fixed the swap but paints NOTHING while a face loads. That is
// invisible on local disk reads and brutal over the network: typing Korean
// reaches a Hangul range whose slice was never fetched, and the glyph stayed
// blank until it arrived (user: 타이핑하는 글자가 자꾸 투명해진다).
// `fallback` keeps the anti-swap intent — a ~100ms invisible window, then
// fallback text, and NO late swap after ~3s — while guaranteeing that typed
// text is always painted.
const localFontDisplayFallback: Plugin = {
  name: 'mixdog-local-font-display-fallback',
  enforce: 'pre',
  transform(code, id) {
    if (!/[\\/]node_modules[\\/](?:@fontsource-variable|pretendard)[\\/].*\.css(?:\?|$)/.test(id)) {
      return null;
    }
    if (!code.includes('font-display')) return null;
    return { code: code.replace(/font-display:\s*swap/gi, 'font-display: fallback'), map: null };
  },
};

// This tiny first-paint script must run before CSS or the renderer, but an
// external classic script blocks HTML parsing for a full relay round trip.
// Inline the public source into the no-cache document; the relay derives the
// matching CSP hash from the copied boot.js beside index.html.
const inlineBootScript: Plugin = {
  name: 'mixdog-inline-boot-script',
  transformIndexHtml(html) {
    const source = readFileSync(
      resolve(__dirname, 'src/renderer/public/boot.js'),
      'utf8',
    );
    return html.replace(
      '<script src="./boot.js"></script>',
      `<script>${source}</script>`,
    );
  },
};

// The built document names only the 2 KB entry chunk. Everything the first
// screen needs — the stylesheet, React, the language catalog and the app
// bundle — is discovered by RUNNING that chunk, so a phone pays four relay
// round trips in a row before anything can paint (user: 늦게 생성되기도 한다).
// Name them in the document instead, inside an INERT <template>: a browser tab
// renders only the install guide, and boot.js moves the hints into the head
// exactly when the installed app is the surface that will use them.
const FIRST_SCREEN_CHUNK_NAMES = new Set([
  'remote-shim',
  'mobile-surface',
  'i18n',
  'react-vendor',
  'ui-vendor',
  'bootstrap',
]);
const FIRST_SCREEN_STYLE_NAMES = new Set(['bootstrap-styles.css']);

const firstScreenHints: Plugin = {
  name: 'mixdog-first-screen-hints',
  enforce: 'post',
  transformIndexHtml: {
    order: 'post',
    handler(html, context) {
      const placeholder = '<!--mixdog-first-screen-->';
      if (!html.includes(placeholder)) return html;
      // The dev server has no bundle: the entry is served unhashed and the
      // hints would name files that do not exist yet.
      if (!context.bundle) return html.replace(placeholder, '');
      const styles: string[] = [];
      const modules: string[] = [];
      for (const output of Object.values(context.bundle)) {
        const name = output.name ?? '';
        if (output.type === 'asset') {
          if (FIRST_SCREEN_STYLE_NAMES.has(name)) {
            styles.push(`<link rel="stylesheet" href="./${output.fileName}">`);
          }
        } else if (FIRST_SCREEN_CHUNK_NAMES.has(name)) {
          modules.push(`<link rel="modulepreload" crossorigin href="./${output.fileName}">`);
        }
      }
      // Renaming a first-screen module is not an error, but silently losing the
      // hint would put the serial boot back without anyone noticing.
      if (styles.length !== FIRST_SCREEN_STYLE_NAMES.size
        || modules.length !== FIRST_SCREEN_CHUNK_NAMES.size) {
        console.warn(
          `[mixdog] first-screen hints matched ${styles.length}/${FIRST_SCREEN_STYLE_NAMES.size}`
          + ` styles and ${modules.length}/${FIRST_SCREEN_CHUNK_NAMES.size} modules;`
          + ' the web app boots the missing ones serially.',
        );
      }
      const hints = [...styles, ...modules].join('');
      return html.replace(
        placeholder,
        hints ? `<template id="mixdog-first-screen">${hints}</template>` : '',
      );
    },
  },
};

export default defineConfig({
  main: buildTargetEnabled('main') ? {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'capture-window': resolve(__dirname, 'src/main/capture-window.ts'),
        },
      },
    },
  } : undefined,
  preload: buildTargetEnabled('preload') ? {
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
  } : undefined,
  renderer: buildTargetEnabled('renderer') ? {
    // The relay/VPS serves this renderer as an installable web app. Keep the
    // manifest, icon and network-only service worker at stable root paths.
    publicDir: resolve(__dirname, 'src/renderer/public'),
    resolve: {
      alias: [
        {
          // Vite's renderer-wide `browser` condition otherwise selects the
          // package's document.createElement decoder inside Web Workers.
          // The package's default/worker implementation is API-equivalent and
          // uses the static entity table, so both live and settled Markdown
          // remain usable without a DOM global.
          find: /^decode-named-character-reference$/,
          replacement: resolve(
            __dirname,
            'node_modules/decode-named-character-reference/index.js',
          ),
        },
        {
          // rehype-katex reaches this package from the Markdown Web Worker.
          // Vite applies the renderer's `browser` condition to worker imports,
          // selecting a DOMParser/document implementation that crashes before
          // the worker can receive its first message. The package explicitly
          // exports this default entry for `worker`; pin it for both contexts.
          find: /^hast-util-from-html-isomorphic$/,
          replacement: resolve(
            __dirname,
            'node_modules/hast-util-from-html-isomorphic/index.js',
          ),
        },
        {
          // Project intelligence is provided by the main-process LSP. Keep
          // Monaco's TypeScript tokenizer while omitting its duplicate 13 MB
          // language-service worker contribution.
          find: /^.*[\\/]language[\\/]typescript[\\/]monaco\.contribution\.js$/,
          replacement: resolve(__dirname, 'src/renderer/monaco-typescript-external.ts'),
        },
      ],
    },
    // Monaco lives behind a dynamic file-editor import. Without an explicit
    // dependency hint, Vite discovers and optimizes it on the first file open,
    // causing a multi-second dev-only Loading editor stall and page restyle.
    // The live Markdown worker has the same constraint: first-response import
    // must not discover unified/remark and reload the whole renderer.
    optimizeDeps: {
      include: [
        '@monaco-editor/react',
        'monaco-editor',
        'unified',
        'remark-parse',
        'remark-rehype',
        'remark-gfm',
        'remark-math',
        'rehype-katex',
        'rehype-highlight',
      ],
    },
    build: {
      // Electron 40 ships Chromium 144, so the controlled desktop runtime can
      // use native module preloads without Vite's compatibility polyfill.
      target: 'chrome144',
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
        output: {
          // React moves far less often than app code: keeping it in its own
          // chunk lets a phone reuse the cached copy across app updates
          // instead of re-downloading it inside the main bundle.
          manualChunks: {
            'react-vendor': ['react', 'react-dom', 'react-dom/client', 'scheduler'],
            'ui-vendor': [
              '@tanstack/react-virtual',
              '@tanstack/virtual-core',
              'i18next',
              'lucide-react',
            ],
          },
        },
      },
    },
    plugins: [localFontDisplayFallback, inlineBootScript, firstScreenHints, react()],
    server: {
      host: '127.0.0.1',
    },
  } : undefined,
});
