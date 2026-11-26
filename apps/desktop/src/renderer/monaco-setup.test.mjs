import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  MONACO_TYPESCRIPT_CONTRIBUTION,
  monacoTypescriptExternalEsbuildPlugin,
} from '../../scripts/monaco-typescript-external.mjs';
import { createMonacoLanguageLoader, MONACO_BASIC_LANGUAGE_LOADERS } from './monaco-language-loader.ts';
import { createMonacoWorkerLifecycle, monacoWorkerKindForLabel } from './monaco-worker-lifecycle.ts';
import { MONACO_EAGER_MONARCH_LANGUAGES } from './monaco-eager-languages.ts';

const here = dirname(fileURLToPath(import.meta.url));
const setupSource = readFileSync(resolve(here, 'monaco-setup.ts'), 'utf8');
const viteConfig = readFileSync(resolve(here, '../../electron.vite.config.ts'), 'utf8');

test('every Monaco language service that stays active routes to its own worker', () => {
  assert.match(setupSource, /return workerLifecycle\.createWorker\(label\);/);
  assert.equal(monacoWorkerKindForLabel('json'), 'json');
  for (const label of ['css', 'scss', 'less']) assert.equal(monacoWorkerKindForLabel(label), 'css');
  for (const label of ['html', 'handlebars', 'razor']) assert.equal(monacoWorkerKindForLabel(label), 'html');
  assert.equal(monacoWorkerKindForLabel('editorWorkerService'), 'editor');
});

test('typescript/javascript labels get the plain editor worker, never a language-service worker', () => {
  // The only worker that could serve them is the TS worker, which is not
  // imported; the plain editor worker would reject its RPCs.
  for (const label of ['typescript', 'javascript']) assert.equal(monacoWorkerKindForLabel(label), 'editor');
});

test('monaco-setup.ts imports no basic-languages grammars eagerly and loads each language on demand', async () => {
  assert.doesNotMatch(
    setupSource,
    /^\s*import\s+[\s\S]*?from\s+['"]monaco-editor\/esm\/vs\/basic-languages\//m,
    'monaco-setup.ts must not eagerly import basic-languages grammars at module load'
  );
  for (const moduleDir of Object.values(MONACO_EAGER_MONARCH_LANGUAGES)) {
    assert.equal(typeof MONACO_BASIC_LANGUAGE_LOADERS[moduleDir], 'function', `lazy loader exists for ${moduleDir}`);
  }

  const loadedDirs = [];
  const registered = [];
  let failOnce = true;
  const loader = createMonacoLanguageLoader({
    languageDirs: { c: 'cpp', cpp: 'cpp', rust: 'rust', python: 'python' },
    loaders: {
      cpp: async () => {
        loadedDirs.push('cpp');
        return { conf: { comments: { lineComment: '//' } }, language: { tokenizer: { root: [] } } };
      },
      rust: async () => {
        loadedDirs.push('rust');
        if (failOnce) {
          failOnce = false;
          throw new Error('transient chunk failure');
        }
        return { conf: { comments: { lineComment: '//' } }, language: { tokenizer: { root: [] } } };
      },
      python: async () => {
        loadedDirs.push('python');
        return { conf: { comments: { lineComment: '#' } }, language: { tokenizer: { root: [] } } };
      },
    },
    register: {
      setMonarchTokensProvider(id) {
        registered.push(`tokens:${id}`);
      },
      setLanguageConfiguration(id) {
        registered.push(`conf:${id}`);
      },
    },
  });

  // Opening a C file loads only cpp and never touches rust or python.
  assert.equal(await loader.ensureLanguage('c'), true);
  assert.deepEqual(loadedDirs, ['cpp']);
  assert.deepEqual(registered, ['tokens:c', 'conf:c']);
  // Opening a C++ file reuses the loaded cpp module without a second import.
  assert.equal(await loader.ensureLanguage('cpp'), true);
  assert.deepEqual(loadedDirs, ['cpp']);
  assert.deepEqual(registered, ['tokens:c', 'conf:c', 'tokens:cpp', 'conf:cpp']);
  // Repeated opens are no-ops.
  assert.equal(await loader.ensureLanguage('c'), true);
  assert.equal(registered.length, 4);
  // Unknown/plaintext languages load nothing.
  assert.equal(await loader.ensureLanguage('plaintext'), false);
  // A failed load clears so a subsequent open retries.
  await assert.rejects(loader.ensureLanguage('rust'), /transient chunk failure/);
  assert.equal(await loader.ensureLanguage('rust'), true);
  assert.deepEqual(loadedDirs, ['cpp', 'rust', 'rust']);
  assert.equal(loader.isLoaded('python'), false);
});

test('Monaco language and editor workers stop when no editor surface is mounted and restart on wake', () => {
  const created = [];
  let editorStopped = 0;
  const defaultsByLabel = new Map();
  const makeDefaults = (label) => {
    const entry = {
      modeConfiguration: { diagnostics: true, completionItems: true },
      history: [],
      setModeConfiguration(next) {
        this.modeConfiguration = next;
        this.history.push(next);
      },
    };
    defaultsByLabel.set(label, entry);
    return entry;
  };
  for (const label of ['json', 'css', 'scss', 'less', 'html', 'handlebars', 'razor']) makeDefaults(label);

  const lifecycle = createMonacoWorkerLifecycle({
    factories: {
      editor: () => {
        const w = { kind: 'editor' };
        created.push(w);
        return w;
      },
      json: () => {
        const w = { kind: 'json' };
        created.push(w);
        return w;
      },
      css: () => {
        const w = { kind: 'css' };
        created.push(w);
        return w;
      },
      html: () => {
        const w = { kind: 'html' };
        created.push(w);
        return w;
      },
    },
    getLanguageDefaults: (label) => defaultsByLabel.get(label),
    stopEditorWorker: () => {
      editorStopped += 1;
    },
  });

  lifecycle.createWorker('editorWorkerService');
  lifecycle.createWorker('json');
  lifecycle.createWorker('css');
  assert.deepEqual(
    created.map((w) => w.kind),
    ['editor', 'json', 'css']
  );

  // Last editor unmounts: active language services pause diagnostics (stopping their workers) and editor worker stops.
  lifecycle.stopWorkers();
  assert.equal(editorStopped, 1);
  assert.equal(defaultsByLabel.get('json').modeConfiguration.diagnostics, false);
  assert.equal(defaultsByLabel.get('css').modeConfiguration.diagnostics, false);
  assert.equal(defaultsByLabel.get('html').history.length, 0, 'never-started language services stay untouched');
  assert.equal(lifecycle.activeLabels.size, 0);

  // Opening a new editor wakes paused language services and starts fresh workers on demand.
  lifecycle.wakeWorkers();
  assert.equal(defaultsByLabel.get('json').modeConfiguration.diagnostics, true);
  assert.equal(defaultsByLabel.get('css').modeConfiguration.diagnostics, true);
  lifecycle.createWorker('html');
  lifecycle.createWorker('editorWorkerService');
  lifecycle.stopWorkers();
  assert.equal(editorStopped, 2);
  assert.equal(defaultsByLabel.get('html').modeConfiguration.diagnostics, false);
});

test('stopWorkers avoids untracked CSS/JSON worker respawns from DiagnosticsAdapter onDidChange when live models exist', () => {
  let cssSpawns = 0;
  let cssStops = 0;
  let jsonSpawns = 0;
  let jsonStops = 0;
  let liveCssModels = 1;
  const liveJsonModels = 1;
  let jsonDiagnosticsAdapterAlive = true;

  let lifecycle;
  const cssDefaults = {
    modeConfiguration: { diagnostics: true },
    setModeConfiguration(next) {
      this.modeConfiguration = next;
      // WorkerManager stops cssWorker, then cssMode's persistent DiagnosticsAdapter validates live CSS models.
      cssStops += 1;
      if (liveCssModels > 0) lifecycle.createWorker('css');
    },
  };
  const jsonDefaults = {
    modeConfiguration: { diagnostics: true },
    setModeConfiguration(next) {
      this.modeConfiguration = next;
      // WorkerManager stops jsonWorker; if JSONDiagnosticsAdapter is still registered it validates live models
      // synchronously BEFORE jsonMode's registerProviders() disposes it.
      jsonStops += 1;
      if (jsonDiagnosticsAdapterAlive && liveJsonModels > 0) {
        lifecycle.createWorker('json');
      }
      jsonDiagnosticsAdapterAlive = next.diagnostics !== false;
    },
  };

  lifecycle = createMonacoWorkerLifecycle({
    factories: {
      editor: () => ({ kind: 'editor' }),
      json: () => {
        jsonSpawns += 1;
        return { kind: 'json' };
      },
      css: () => {
        cssSpawns += 1;
        return { kind: 'css' };
      },
      html: () => ({ kind: 'html' }),
    },
    getLanguageDefaults: (label) => (label === 'css' ? cssDefaults : label === 'json' ? jsonDefaults : undefined),
    stopEditorWorker: () => {},
    hasLiveModels: (label) => (label === 'css' ? liveCssModels > 0 : label === 'json' ? liveJsonModels > 0 : false),
  });

  lifecycle.createWorker('css');
  lifecycle.createWorker('json');
  assert.equal(cssSpawns, 1);
  assert.equal(jsonSpawns, 1);

  // Stop while hidden CSS + JSON models are still alive:
  // - CSS must NOT poke setModeConfiguration (avoiding cssMode respawn loop) and stays tracked in activeLabels.
  // - JSON pauses diagnostics and runs a second stop after DiagnosticsAdapter is disposed, leaving 0 live JSON workers.
  lifecycle.stopWorkers();
  assert.equal(cssSpawns, 1, 'cssWorker must not be thrashed/respawned while a live CSS model exists');
  assert.equal(cssStops, 0);
  assert.equal(lifecycle.activeLabels.has('css'), true, 'activeLabels still tracks the live cssWorker');
  assert.equal(jsonSpawns, 2, 'first call respawned once inside DiagnosticsAdapter before disposal');
  assert.equal(jsonStops, 2, 'second call stopped the respawned jsonWorker cleanly');
  assert.equal(lifecycle.activeLabels.has('json'), false, 'jsonWorker is stopped and untracked');

  // Once the hidden CSS model is disposed, stopWorkers stops cssWorker with zero respawn.
  liveCssModels = 0;
  lifecycle.stopWorkers();
  assert.equal(cssStops, 1);
  assert.equal(cssSpawns, 1, 'no cssWorker respawn once live CSS models are gone');
  assert.equal(lifecycle.activeLabels.size, 0);

  // SharedEditorSurface disposes models in useLayoutEffect (before the release microtask) and releases peek models before stop.
  const sharedSurfaceSource = readFileSync(resolve(here, 'SharedEditorSurface.tsx'), 'utf8');
  assert.doesNotMatch(
    sharedSurfaceSource,
    /\buseEffect\s*\(/,
    'model disposal must run in useLayoutEffect, not passive useEffect'
  );
  assert.ok(
    sharedSurfaceSource.indexOf('releaseUnattachedPeekPreviewModels()') <
      sharedSurfaceSource.indexOf('stopMonacoLanguageWorkers()'),
    'peek preview models must be released before stopping workers'
  );
});

test('Monaco built-in TypeScript service is stubbed in both build and dev optimizer', async () => {
  assert.match('../language/typescript/monaco.contribution.js', MONACO_TYPESCRIPT_CONTRIBUTION);
  // Source-text on purpose: electron.vite.config.ts is a build config no test can import; these two lines
  // pin that it wires the stub that the esbuild build below proves effective.
  assert.match(viteConfig, /find: MONACO_TYPESCRIPT_CONTRIBUTION/);
  assert.match(viteConfig, /esbuildOptions: \{ plugins: \[monacoTypescriptExternalEsbuildPlugin\(\)\] \}/);

  const entry = createRequire(import.meta.url).resolve('monaco-editor/esm/vs/editor/editor.main.js');
  const options = {
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    splitting: true,
    outdir: 'out',
    logLevel: 'silent',
    loader: { '.css': 'empty', '.ttf': 'empty' },
  };
  const withPlugin = await build({ ...options, plugins: [monacoTypescriptExternalEsbuildPlugin()] });
  const text = withPlugin.outputFiles.map((file) => file.text).join('\n');
  assert.doesNotMatch(text, /getSyntacticDiagnostics/);
  assert.deepEqual(
    withPlugin.outputFiles.filter((file) => /tsMode-/.test(file.path)),
    [],
    'no lazy TS language-service chunk'
  );
  // Tokenizers and the other services stay: typescript Monarch + json/css/html modes.
  assert.match(text, /basic-languages\/typescript\/typescript/);
  assert.match(text, /language\/json\/monaco\.contribution/);
  assert.match(text, /language\/css\/monaco\.contribution/);
  assert.match(text, /language\/html\/monaco\.contribution/);
});
