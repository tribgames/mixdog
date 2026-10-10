import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  MONACO_TYPESCRIPT_CONTRIBUTION,
  MONACO_TYPESCRIPT_STUB,
  monacoTypescriptExternalEsbuildPlugin,
} from '../../scripts/monaco-typescript-external.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const setupSource = readFileSync(resolve(here, 'monaco-setup.ts'), 'utf8');
const viteConfig = readFileSync(resolve(here, '../../electron.vite.config.ts'), 'utf8');

/** Evaluate the real getWorker switch from monaco-setup.ts with tagged stubs. */
function routeLabel(label) {
  const body = /getWorker\(_workerId: string, label: string\) \{([\s\S]*?)\n {2}\},\n\};/.exec(setupSource)?.[1];
  assert.ok(body, 'getWorker body found');
  const make = (name) =>
    class {
      constructor() {
        this.worker = name;
      }
    };
  const run = new Function('jsonWorker', 'cssWorker', 'htmlWorker', 'editorWorker', 'label', body);
  return run(make('json'), make('css'), make('html'), make('editor'), label).worker;
}

test('every Monaco language service that stays active routes to its own worker', () => {
  assert.equal(routeLabel('json'), 'json');
  for (const label of ['css', 'scss', 'less']) assert.equal(routeLabel(label), 'css');
  for (const label of ['html', 'handlebars', 'razor']) assert.equal(routeLabel(label), 'html');
  assert.equal(routeLabel('editorWorkerService'), 'editor');
});

test('typescript/javascript labels never get a language-service worker', () => {
  // The only worker that could serve them is the TS worker, which is not
  // imported; the plain editor worker would reject its RPCs.
  assert.doesNotMatch(setupSource, /ts\.worker|tsWorker|language\/typescript/);
  assert.match(setupSource, /import \* as monaco from 'monaco-editor';/);
});

test('Monaco built-in TypeScript service is stubbed in both build and dev optimizer', async () => {
  assert.match('../language/typescript/monaco.contribution.js', MONACO_TYPESCRIPT_CONTRIBUTION);
  assert.match(viteConfig, /find: MONACO_TYPESCRIPT_CONTRIBUTION/);
  assert.match(viteConfig, /esbuildOptions: \{ plugins: \[monacoTypescriptExternalEsbuildPlugin\(\)\] \}/);
  assert.equal(readFileSync(MONACO_TYPESCRIPT_STUB, 'utf8').includes('export {}'), true);

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
