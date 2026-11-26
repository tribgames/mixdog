// electron-vite configuration for the desktop app.
// Third-party derivation notices: NOTICE.md at the repository root.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// SWC transform (user: 빌드 과정이 느리다): no custom babel plugins exist, so
// the babel-based @vitejs/plugin-react only cost time — SWC cuts the 3600-
// module renderer transform roughly in half.
import react from '@vitejs/plugin-react-swc';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { OutputChunk } from 'rollup';
import { isFileLoadingAllowed, type Plugin, searchForWorkspaceRoot } from 'vite';
import { stampRendererShell } from './scripts/renderer-shell';
import { chunkPrefetchPlugin } from './scripts/chunk-prefetch';
import { linkedModuleRoots, otherDriveAssets } from './scripts/dev-linked-assets';
import { cssSubjectBuckets } from './scripts/css-subject-buckets';
import { computerSourceVitePlugin } from './scripts/computer-source-assets.mjs';
import { remoteWebrtcSenderCspPlugin } from './scripts/remote-webrtc-sender-csp.mjs';
import {
  MONACO_TYPESCRIPT_CONTRIBUTION,
  MONACO_TYPESCRIPT_STUB,
  monacoTypescriptExternalEsbuildPlugin,
} from './scripts/monaco-typescript-external.mjs';

// Browser builds for scripted inline charts and off-screen Mermaid exports,
// emitted as asset files under out/main/assets/ and read from disk on demand
// instead of staying pinned in V8 as JS string modules.
const visualizeVendorAssets = (assets: ReadonlyArray<{ fileName: string; source: string }>): Plugin => ({
  name: 'mixdog-visualize-vendor-assets',
  generateBundle() {
    for (const asset of assets) {
      const sourcePath = resolve(__dirname, asset.source);
      this.addWatchFile(sourcePath);
      this.emitFile({
        type: 'asset',
        fileName: asset.fileName,
        source: readFileSync(sourcePath),
      });
    }
  },
});
const visualizeAssetsPlugin = visualizeVendorAssets([
  { fileName: 'assets/echarts.min.js', source: 'node_modules/echarts/dist/echarts.min.js' },
  { fileName: 'assets/mermaid.min.js', source: 'node_modules/mermaid/dist/mermaid.min.js' },
]);

const buildInputsManifestPath = process.env.MIXDOG_BUILD_INPUTS_MANIFEST
  ? resolve(process.env.MIXDOG_BUILD_INPUTS_MANIFEST)
  : null;

function walkFilesAndDirs(dir: string, files: Set<string>, dirs: Set<string>): void {
  if (!existsSync(dir)) return;
  const resolvedDir = resolve(dir);
  dirs.add(resolvedDir);
  for (const entry of readdirSync(resolvedDir, { withFileTypes: true })) {
    const child = join(resolvedDir, entry.name);
    if (entry.isDirectory()) walkFilesAndDirs(child, files, dirs);
    else if (entry.isFile()) files.add(child);
  }
}

function recordBuildInputsPlugin(
  target: 'main' | 'preload' | 'renderer',
  extras: { publicDir?: string } = {},
): Plugin | null {
  if (!buildInputsManifestPath) return null;
  const globDirs = new Set<string>();
  const stripQuery = (id: string): string => id.split(/[?#]/, 1)[0];
  return {
    name: `mixdog-record-build-inputs-${target}`,
    transform(code, id) {
      if (!code.includes('import.meta.glob')) return null;
      const cleanId = stripQuery(id);
      if (!cleanId || cleanId.startsWith('\0') || /[\\/]node_modules[\\/]/.test(cleanId)) return null;
      const pattern = /import\.meta\.glob\s*\(\s*['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(code)) !== null) {
        const raw = match[1];
        const globStart = raw.search(/[*?[{!]/);
        const prefix = globStart >= 0 ? raw.slice(0, globStart) : raw;
        const base = resolve(dirname(cleanId), prefix.endsWith('/') ? prefix : dirname(prefix));
        if (existsSync(base)) globDirs.add(base);
      }
      return null;
    },
    writeBundle() {
      const files = new Set<string>([
        resolve(__dirname, 'electron.vite.config.ts'),
        resolve(__dirname, 'package.json'),
      ]);
      const dirs = new Set<string>(globDirs);
      for (const raw of [...this.getModuleIds(), ...this.getWatchFiles()]) {
        if (!raw || raw.startsWith('\0')) continue;
        const clean = stripQuery(raw);
        if (!clean) continue;
        try {
          const st = statSync(clean);
          if (st.isFile()) files.add(realpathSync(clean));
        } catch {
          // Ignore virtual or non-file ids.
        }
      }
      if (extras.publicDir) walkFilesAndDirs(extras.publicDir, files, dirs);

      const fileSnapshots: Record<string, { size: number; mtimeMs: number }> = {};
      for (const file of [...files].sort()) {
        try {
          const st = statSync(file);
          if (st.isFile()) fileSnapshots[file] = { size: st.size, mtimeMs: st.mtimeMs };
        } catch {
          // Ignore unreadable entry.
        }
      }
      const dirSnapshots: Record<string, string[]> = {};
      for (const dir of [...dirs].sort()) {
        try {
          dirSnapshots[dir] = readdirSync(dir).sort();
        } catch {
          // Ignore unreadable directory.
        }
      }

      mkdirSync(dirname(buildInputsManifestPath), { recursive: true });
      let current: Record<string, unknown> = {};
      try {
        current = JSON.parse(readFileSync(buildInputsManifestPath, 'utf8'));
      } catch {
        current = {};
      }
      current[target] = { files: fileSnapshots, dirs: dirSnapshots };
      const tmp = `${buildInputsManifestPath}.${process.pid}.${target}.tmp`;
      writeFileSync(tmp, JSON.stringify(current));
      renameSync(tmp, buildInputsManifestPath);
    },
  };
}

const selectedBuildTargets = new Set(
  String(process.env.MIXDOG_ELECTRON_BUILD_TARGETS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const buildTargetEnabled = (target: 'main' | 'preload' | 'renderer'): boolean =>
  selectedBuildTargets.size === 0 || selectedBuildTargets.has(target);

const devRendererPort = (() => {
  const raw = process.env.MIXDOG_DEV_RENDERER_PORT;
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`MIXDOG_DEV_RENDERER_PORT must be an integer from 1 to 65535, got ${JSON.stringify(raw)}.`);
  }
  return port;
})();

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

// Order matters: HTTP/1.1 gives a phone six connections served first come, first served.
// The relay transport graph is ~20 KB brotli against ~450 KB for the rest (phone trace: connecting@1109 ms).
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

const rendererPublicDir = resolve(__dirname, 'src/renderer/public');
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
      const desktopHints: string[] = [];
      html = html.replace(/[ \t]*<link\b[^>]*\bdata-mixdog-surface="desktop"[^>]*>\r?\n?/g, (tag) => {
        desktopHints.push(tag.trim().replace(/\s*\/>$/, '>'));
        return '';
      });
      const chunks = Object.values(bundle).filter((output): output is OutputChunk => output.type === 'chunk');
      const chunkByName = new Map(chunks.map((chunk) => [chunk.name, chunk]));
      // The app's entry, not the desktop pet window's (desktop-pet.html) or
      // the live-view sender's (remote-webrtc-sender.html).
      const entry = chunks.find(
        (chunk) => chunk.isEntry && !/desktop-pet|remote-webrtc-sender/.test(chunk.facadeModuleId ?? ''),
      );
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
      const localeChunkFor = (name: string): OutputChunk | undefined =>
        chunks.find((chunk) => chunk.name === name
          && /[\\/]src[\\/]renderer[\\/]locales[\\/][^\\/]+\.json$/.test(chunk.facadeModuleId ?? ''));
      const localeHints = Object.entries(FIRST_SCREEN_LOCALE_CHUNKS).flatMap(([language, name]) => {
        const fileName = localeChunkFor(name)?.fileName;
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
        || desktopHints.length === 0
        || localeHints.length !== Object.keys(FIRST_SCREEN_LOCALE_CHUNKS).length) {
        console.warn(
          `[mixdog] first-screen hints matched ${entry ? 1 : 0}/1 entry,`
          + ` ${roots.length}/${FIRST_SCREEN_ROOT_CHUNKS.length} root chunks, ${styles.size} styles,`
          + ` ${desktopHints.length} desktop hints`
          + ` and ${localeHints.length}/${Object.keys(FIRST_SCREEN_LOCALE_CHUNKS).length} locales;`
          + ' the web app boots the missing ones serially.',
        );
      }
      const hints = [...styleHints, ...moduleHints, ...localeHints, ...desktopHints].join('');
      return stampRendererShell(html.replace(
        placeholder,
        hints ? `<template id="mixdog-first-screen">${hints}</template>` : '',
      ), context.bundle, rendererPublicDir);
    },
  },
};

// Each isolated dev instance optimizes renderer deps into its own cache: a
// shared node_modules/.vite re-optimized by one dev server invalidates the
// modules another (the 9342 app) is serving and forces it to reload.
const devViteCacheDir = process.env.MIXDOG_DEV_VITE_CACHE_DIR;

export default defineConfig({
  main: buildTargetEnabled('main') ? {
    // qrcode is bundled, not resolved from the shipped node_modules: an
    // installed shell once lost its transitive deps (dijkstrajs, pngjs) and
    // the pairing QR silently never rendered. Pure JS, so bundling is safe.
    plugins: [
      computerSourceVitePlugin(),
      visualizeAssetsPlugin,
      externalizeDepsPlugin({ exclude: ['qrcode'] }),
      recordBuildInputsPlugin('main'),
    ].filter(Boolean) as Plugin[],
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
    plugins: [externalizeDepsPlugin(), recordBuildInputsPlugin('preload')].filter(Boolean) as Plugin[],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'computer-overlay': resolve(__dirname, 'src/preload/computer-overlay.ts'),
          'remote-window': resolve(__dirname, 'src/preload/remote-window.ts'),
          'browser-login': resolve(__dirname, 'src/preload/browser-login.ts'),
          'browser-page': resolve(__dirname, 'src/preload/browser-page.ts'),
          'desktop-pet': resolve(__dirname, 'src/preload/desktop-pet.ts'),
          // Main's own confirm surface, e.g. "Allow all actions" (main/developer-risk-confirm.ts).
          'host-confirm': resolve(__dirname, 'src/preload/host-confirm.ts'),
          // The hidden WebRTC live-view sender (main/remote-webrtc/sender-window.ts).
          'remote-webrtc-sender': resolve(__dirname, 'src/preload/remote-webrtc-sender.ts'),
          // The hidden direct-transport peer host (main/remote-transport/peer-window.ts).
          'remote-transport-peer': resolve(__dirname, 'src/preload/remote-transport-peer.ts'),
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
    publicDir: rendererPublicDir,
    ...(devViteCacheDir ? { cacheDir: resolve(devViteCacheDir) } : {}),
    resolve: {
      alias: [
        {
          // Vite's `browser` condition selects a document.createElement decoder inside Web Workers;
          // the default/worker entry is API-equivalent without a DOM global.
          find: /^decode-named-character-reference$/,
          replacement: resolve(
            __dirname,
            'node_modules/decode-named-character-reference/index.js',
          ),
        },
        {
          // Vite's `browser` condition selects a DOMParser implementation that crashes in the Markdown Web Worker;
          // the package exports this default entry for `worker`.
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
          find: MONACO_TYPESCRIPT_CONTRIBUTION,
          replacement: MONACO_TYPESCRIPT_STUB,
        },
        {
          // Share the renderer's single lowlight instance across Markdown and
          // @git-diff-view instead of eagerly instantiating createLowlight(all);
          // non-common grammars load on demand in shared-lowlight-extra.ts.
          find: /^@git-diff-view\/lowlight$/,
          replacement: resolve(__dirname, 'src/renderer/shared-diff-lowlight.ts'),
        },
      ],
    },
    // Vite otherwise discovers Monaco on the first file open and unified/remark on the first
    // Markdown response, stalling the dev server or reloading the renderer.
    optimizeDeps: {
      // resolve.alias does not reach the optimizer's esbuild pass.
      esbuildOptions: { plugins: [monacoTypescriptExternalEsbuildPlugin()] },
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
    worker: {
      format: 'es',
    },
    build: {
      // Electron 40 ships Chromium 144, so the controlled desktop runtime can
      // use native module preloads without Vite's compatibility polyfill.
      target: 'chrome144',
      // electron-vite defaults the renderer to minify:false (~35% more brotli bytes); build.cssMinify follows this value.
      minify: process.env.MIXDOG_DEV_UNMINIFIED === '1' ? false : 'esbuild',
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // The always-on-top desktop pet window (main/desktop-pet-window.ts).
          'desktop-pet': resolve(__dirname, 'src/renderer/desktop-pet.html'),
          // The hidden WebRTC live-view sender window (main/remote-webrtc/sender-window.ts).
          'remote-webrtc-sender': resolve(__dirname, 'src/renderer/remote-webrtc-sender.html'),
          // The hidden direct-transport peer host window (main/remote-transport/peer-window.ts).
          'remote-transport-peer': resolve(__dirname, 'src/renderer/remote-transport-peer.html'),
        },
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
            // Font faces and @property rules build into their own stylesheet:
            // in the app sheet, every breakpoint a window drag crossed rebuilt
            // them, relaying out all text (see src/renderer/font-faces.css).
            'font-faces': [
              '@fontsource-variable/jetbrains-mono',
              'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css',
              '@vscode/codicons/dist/codicon.css',
              resolve(__dirname, 'src/renderer/font-faces.css'),
              resolve(__dirname, 'src/renderer/font-faces-styles.ts'),
            ],
          },
        },
      },
    },
    // Selectors whose subject is a bare multi-argument `:is()` are spelled out
    // so the style engine keys each arm on its own subject instead of trying
    // it on every element (scripts/css-subject-buckets.ts).
    css: { postcss: { plugins: [cssSubjectBuckets()] } },
    plugins: [
      localFontDisplayFallback,
      inlineBootScript,
      remoteWebrtcSenderCspPlugin(),
      firstScreenHints,
      // The phone downloads its side-sheet panes ahead of time and evaluates
      // them on the first open (use-app-boot.ts phoneSheetPaneWarmups).
      chunkPrefetchPlugin({
        diff: resolve(__dirname, 'src/renderer/DiffView.lazy.tsx'),
        terminal: resolve(__dirname, 'src/renderer/TerminalPane.tsx'),
        browser: resolve(__dirname, 'src/renderer/BrowserPane.lazy.tsx'),
        visualize: resolve(__dirname, 'src/renderer/VisualizePane.tsx'),
        editor: resolve(__dirname, 'src/renderer/EditorPane.lazy.tsx'),
        settings: resolve(__dirname, 'src/renderer/settings/SettingsView.tsx'),
      }),
      react(),
      // A font of a package that really lives on another drive (a linked node_modules): scripts/dev-linked-assets.ts.
      otherDriveAssets(isFileLoadingAllowed),
      recordBuildInputsPlugin('renderer', { publicDir: rendererPublicDir }),
    ].filter(Boolean) as Plugin[],
    server: {
      host: '127.0.0.1',
      ...(devRendererPort ? { port: devRendererPort, strictPort: true } : {}),
      // The translated changelogs (repo-root changelog/*.md) load as lazy
      // chunks, which the dev server only serves from allowed folders.
      // The real location of a linked node_modules: Vite names a package's fonts by it (scripts/dev-linked-assets.ts).
      fs: { allow: [searchForWorkspaceRoot(__dirname), resolve(__dirname, '../../changelog'), ...linkedModuleRoots(__dirname)] },
    },
  } : undefined,
});
