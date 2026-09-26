// electron-vite configuration for the desktop app.
// Third-party derivation notices: NOTICE.md at the repository root.
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

// SWC transform (user: 빌드 과정이 느리다): no custom babel plugins exist, so
// the babel-based @vitejs/plugin-react only cost time — SWC cuts the 3600-
// module renderer transform roughly in half.
import react from '@vitejs/plugin-react-swc';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { OutputAsset, OutputChunk } from 'rollup';
import type { Plugin } from 'vite';
import { stampRendererShell } from './scripts/renderer-shell';
import { computerSourceVitePlugin } from './scripts/computer-source-assets.mjs';

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
  transformIndexHtml: {
    // Inline before Vite classifies script URLs; the classic first-paint
    // script is deliberately not a module and must not enter its bundler.
    order: 'pre',
    handler(html) {
      const source = readFileSync(
        resolve(__dirname, 'src/renderer/public/boot.js'),
        'utf8',
      );
      return html.replace(
        '<script src="./boot.js"></script>',
        `<script>${source}</script>`,
      );
    },
  },
};

// The dynamic imports the entry (main.tsx) starts before the first screen.
// Every static dependency of the entry and of these roots is read from the
// bundle graph, so a renamed or re-split chunk can never drop out of the
// hints. Keep this order intentional: production serves HTTP/1.1 and a phone
// opens six connections that serve equal-priority hints first come, first
// served. The relay transport goes first: its whole graph is ~20 KB brotli
// against ~450 KB for the rest of the fan-out, and the WebSocket handshake,
// E2EE and desktop round trips it starts then overlap the shell download
// instead of queueing behind bootstrap (phone trace: connecting@1109 ms).
const FIRST_SCREEN_TRANSPORT_CHUNK = 'remote-shim';
const FIRST_SCREEN_ROOT_CHUNKS = [
  FIRST_SCREEN_TRANSPORT_CHUNK,
  'mobile-surface',
  'i18n',
  'bootstrap',
  // A restored Markdown conversation must be complete when the shell reveals.
  // It follows every shell-critical chunk so bootstrap and React keep the
  // first connection slots.
  'MarkdownBody',
] as const;
// The heaviest shell-critical modules outrank the rest of the fan-out, as
// does the entry + transport graph that has to evaluate before the relay
// socket can open.
const FIRST_SCREEN_HIGH_PRIORITY_CHUNKS = new Set(['bootstrap', 'react-vendor', 'ui-vendor']);
const FIRST_SCREEN_LOCALE_CHUNKS = {
  de: 'de',
  es: 'es',
  fr: 'fr',
  it: 'it',
  ja: 'ja',
  ko: 'ko',
  'pt-BR': 'pt-BR',
  ru: 'ru',
  vi: 'vi',
  'zh-CN': 'zh-CN',
  'zh-TW': 'zh-TW',
} as const;

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
      const bundle = context.bundle;
      // Desktop-only hints (the Seti file-icon font) must leave the parsed
      // head: the preload scanner would otherwise fetch them on the phone too,
      // ahead of the relay transport. They ride the template, and boot.js
      // applies them only inside Electron.
      const desktopHints: string[] = [];
      html = html.replace(/[ \t]*<link\b[^>]*\bdata-mixdog-surface="desktop"[^>]*>\r?\n?/g, (tag) => {
        desktopHints.push(tag.trim().replace(/\s*\/>$/, '>'));
        return '';
      });
      const chunks = Object.values(bundle).filter((output): output is OutputChunk => output.type === 'chunk');
      const chunkByName = new Map(chunks.map((chunk) => [chunk.name, chunk]));
      const entry = chunks.find((chunk) => chunk.isEntry);
      const roots = FIRST_SCREEN_ROOT_CHUNKS.flatMap((name) => chunkByName.get(name) ?? []);
      // Pre-order walk of the static graph: each chunk precedes its imports,
      // and every chunk carries the stylesheets Vite would otherwise attach
      // only when its dynamic import runs.
      const modules: OutputChunk[] = [];
      const styles = new Set<string>();
      const visit = (chunk: OutputChunk): void => {
        if (modules.includes(chunk)) return;
        modules.push(chunk);
        chunk.viteMetadata?.importedCss.forEach((fileName) => styles.add(fileName));
        for (const fileName of chunk.imports) {
          const imported = bundle[fileName];
          if (imported?.type === 'chunk') visit(imported);
        }
      };
      if (entry) visit(entry);
      const transport = chunkByName.get(FIRST_SCREEN_TRANSPORT_CHUNK);
      if (transport) visit(transport);
      // Everything walked so far is what must evaluate before the socket opens.
      const transportPath = new Set(modules);
      roots.forEach(visit);
      // A first-screen chunk that constructs a Worker (the Markdown parser)
      // otherwise fetches its script only after the transcript arrives and
      // renders — a third serial round for the largest asset the restored
      // conversation waits on. Prefetch is lowest priority, so it never takes
      // a slot from the modules above; the Worker then reads it from cache.
      const workerScripts = Object.values(bundle).filter(
        (output): output is OutputAsset => output.type === 'asset'
          && output.fileName.endsWith('.js')
          && modules.some((chunk) => chunk.code.includes(basename(output.fileName))),
      );
      const styleHints = [...styles].map(
        (fileName) => `<link rel="stylesheet" fetchpriority="high" href="./${fileName}">`,
      );
      const moduleHints = modules.map(
        (chunk) => `<link rel="modulepreload" crossorigin`
          + `${FIRST_SCREEN_HIGH_PRIORITY_CHUNKS.has(chunk.name) || transportPath.has(chunk)
            ? ' fetchpriority="high"'
            : ''}`
          + ` href="./${chunk.fileName}">`,
      );
      const workerHints = workerScripts.map((asset) => `<link rel="prefetch" href="./${asset.fileName}">`);
      // The language is known synchronously in boot.js. Keep every catalog
      // inert in the template, then move only the resolved locale into <head>
      // so Korean does not pay a serial request after i18n evaluates.
      const localeHints = Object.entries(FIRST_SCREEN_LOCALE_CHUNKS).flatMap(([language, name]) => {
        const fileName = chunkByName.get(name)?.fileName;
        return fileName
          ? [`<link rel="modulepreload" crossorigin data-mixdog-locale="${language}"`
            + ` href="./${fileName}">`]
          : [];
      });
      // Renaming a first-screen root is not an error, but silently losing the
      // hint would put the serial boot back without anyone noticing.
      if (!entry
        || roots.length !== FIRST_SCREEN_ROOT_CHUNKS.length
        || styles.size === 0
        || workerScripts.length === 0
        || desktopHints.length === 0
        || localeHints.length !== Object.keys(FIRST_SCREEN_LOCALE_CHUNKS).length) {
        console.warn(
          `[mixdog] first-screen hints matched ${entry ? 1 : 0}/1 entry,`
          + ` ${roots.length}/${FIRST_SCREEN_ROOT_CHUNKS.length} root chunks, ${styles.size} styles,`
          + ` ${workerScripts.length} worker scripts, ${desktopHints.length} desktop hints`
          + ` and ${localeHints.length}/${Object.keys(FIRST_SCREEN_LOCALE_CHUNKS).length} locales;`
          + ' the web app boots the missing ones serially.',
        );
      }
      const hints = [...styleHints, ...moduleHints, ...localeHints, ...workerHints, ...desktopHints].join('');
      return stampRendererShell(html.replace(
        placeholder,
        hints ? `<template id="mixdog-first-screen">${hints}</template>` : '',
      ), context.bundle);
    },
  },
};

export default defineConfig({
  main: buildTargetEnabled('main') ? {
    // qrcode is bundled, not resolved from the shipped node_modules: an
    // installed shell once lost its transitive deps (dijkstrajs, pngjs) and
    // the pairing QR silently never rendered. Pure JS, so bundling is safe.
    plugins: [computerSourceVitePlugin(), externalizeDepsPlugin({ exclude: ['qrcode'] })],
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
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'computer-overlay': resolve(__dirname, 'src/preload/computer-overlay.ts'),
        },
        output: {
          // Sandboxed Electron preloads run through the CommonJS preload
          // loader even though the application package is ESM.
          format: 'cjs',
          entryFileNames: '[name].js',
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
      // electron-vite defaults the renderer to minify:false, which shipped the
      // first-screen JS/CSS with every comment and indent intact (~35% more
      // brotli bytes for the phone web app, plus parse time everywhere).
      // Applies to CSS too, since build.cssMinify follows this value.
      minify: 'esbuild',
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
