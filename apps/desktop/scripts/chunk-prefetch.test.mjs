import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { CHUNK_PREFETCH_SOURCE, chunkFilesFor, chunkPrefetchPlugin } from './chunk-prefetch.ts';

const editor = resolve('/app/src/renderer/EditorPane.lazy.tsx');
const bundle = () => ({
  'assets/index.js': {
    type: 'chunk',
    fileName: 'assets/index.js',
    facadeModuleId: resolve('/app/src/renderer/main.tsx'),
    imports: ['assets/react.js'],
    // The module as the build emits it, after other code on the same line.
    code: `import"./react.js";\n${CHUNK_PREFETCH_SOURCE.replace(/\n(?=.)/, '')}const after=1;\n`,
  },
  'assets/react.js': { type: 'chunk', fileName: 'assets/react.js', imports: [] },
  'assets/EditorPane.js': {
    type: 'chunk',
    fileName: 'assets/EditorPane.js',
    facadeModuleId: editor,
    // font-faces.js is a CSS-only chunk Vite deleted before this hook ran.
    imports: ['assets/monaco.js', 'assets/react.js', 'assets/font-faces.js'],
    viteMetadata: { importedCss: new Set(['assets/EditorPane.css']) },
  },
  'assets/monaco.js': {
    type: 'chunk',
    fileName: 'assets/monaco.js',
    imports: [],
    viteMetadata: { importedCss: new Set(['assets/monaco.css']) },
  },
  'assets/monaco.css': { type: 'asset', fileName: 'assets/monaco.css' },
});

test('a lazy module lists its chunk, its static imports and their stylesheets', () => {
  assert.deepEqual(chunkFilesFor(bundle(), editor), [
    'assets/EditorPane.js',
    'assets/monaco.js',
    'assets/react.js',
    'assets/EditorPane.css',
    'assets/monaco.css',
  ]);
  assert.deepEqual(chunkFilesFor(bundle(), resolve('/app/src/renderer/Missing.tsx')), []);
});

test('the build writes the lists into the module the renderer reads them from', () => {
  const output = bundle();
  const plugin = chunkPrefetchPlugin({ editor });
  // It lists files only after Vite pruned the JS of CSS-only chunks (their
  // 404 made the phone reload itself mid-session).
  assert.equal(plugin.enforce, 'post');
  assert.equal(plugin.generateBundle.order, 'post');
  plugin.generateBundle.handler.call({ warn: () => assert.fail('placeholder not found') }, {}, output);
  const before = bundle()['assets/index.js'].code;
  const code = output['assets/index.js'].code;
  assert.ok(!code.includes('__MIXDOG_CHUNK_PREFETCH__'));
  // The chunk's sourcemap was made before this hook: no generated position may move.
  assert.equal(code.length, before.length);
  assert.deepEqual(
    code.split('\n').map((line) => line.length),
    before.split('\n').map((line) => line.length)
  );
  assert.ok(code.endsWith('const after=1;\n'));
  const chunkFiles = new Function(
    `${code.replace('import"./react.js";', '').replace('export const', 'const')}; return chunkFiles;`
  )();
  assert.deepEqual(chunkFiles.editor, chunkFilesFor(bundle(), editor));
});
