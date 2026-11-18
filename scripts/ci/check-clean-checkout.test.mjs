import assert from 'node:assert/strict';
import test from 'node:test';

import { buildViolations, comparisonMaterial, findReaders, tokenize } from './check-clean-checkout.mjs';

// The material's paths are built from pieces: this file is scanned by the guard like any other, and names nothing it reads.
const FIXTURES = ['native', 'core', 'fixtures'].join('/');
const BENCH = ['benchmarks', 'rust-core'].join('/');
const GOLDENS = ['native', 'core', 'crates', 'a', 'tests', 'goldens'].join('/');
const TWIN = ['node', 'twin'].join('-');
const TWIN_FILE = ['native', 'core', 'crates', 'a', 'tests', 'twin_wire.rs'].join('/');

const gitignore = [
  '/dist/',
  '',
  "# Node-comparison material: the owner's local-only tests.",
  '# Present on that machine, never in git.',
  `/${FIXTURES}/`,
  `/${BENCH}/`,
  `**/${TWIN}/`,
  `/${GOLDENS}/`,
  `/${TWIN_FILE}`,
  '',
  '# Development-only material',
  '/dev-local/',
].join('\n');
const entries = comparisonMaterial(gitignore);
const read = (files, gone) => findReaders(new Map(Object.entries(files)), entries, gone);

test('the block is the lines from its marker to the first blank line, as repository paths', () => {
  assert.deepEqual(entries, [`${FIXTURES}/`, `${BENCH}/`, `${TWIN}/`, `${GOLDENS}/`, TWIN_FILE]);
  assert.throws(() => comparisonMaterial('/dist/\n'), /no "Node-comparison material:" block/);
  assert.throws(() => comparisonMaterial('# Node-comparison material: x\n\n/dist/\n'), /is empty/);
});

test('a string naming the material is reported with its line; comments, gated test files and other files are not', () => {
  assert.deepEqual(
    read({
      'src/a.test.mjs': `import x from 'y';\nconst g = readFileSync(new URL('../${FIXTURES}/a/golden.json', import.meta.url));\n`,
      'src/b.test.mjs': `// Replay of ${FIXTURES}/a (recorded)\n/* ${BENCH}/x */\n/**\n * ${BENCH}/y\n */\n`,
      'src/c.ts': `import { exact } from '../../${BENCH}/recorders/lib/exact.mjs';\n`,
      'src/d.test.mjs': `const t = '${GOLDENS}/wire.json';\nconst n = './${TWIN}/x.mjs';\n`,
      'src/f.test.mjs': "const ok = readFileSync(new URL('./data/own.json', import.meta.url));\n",
      'scripts/rust-core/lanes.mjs': `// gated: ${TWIN_FILE}\nconst gated = ['${TWIN_FILE}'];\n`,
    }),
    [`src/a.test.mjs:2: ${FIXTURES}/`, `src/c.ts:1: ${BENCH}/`, `src/d.test.mjs:1: ${GOLDENS}/`, `src/d.test.mjs:2: ${TWIN}/`],
  );
});

test('nothing is exempt: the gate\'s own scripts are scanned like any other', () => {
  assert.deepEqual(read({ 'scripts/ci/a.test.mjs': `const text = readFileSync('${FIXTURES}/example');\n` }), [`scripts/ci/a.test.mjs:1: ${FIXTURES}/`]);
});

test('a block comment that closes before the code on its line does not hide the code; one that is still open does', () => {
  assert.deepEqual(read({ 'src/a.test.mjs': `/* fixture */ readFileSync("${FIXTURES}/example");\n` }), [`src/a.test.mjs:1: ${FIXTURES}/`]);
  assert.deepEqual(read({ 'src/b.test.mjs': `/* one */ /* two */ const x = 1; // "${FIXTURES}/a"\n/* open\n readFileSync("${FIXTURES}/b");\n close */ const y = 2;\n` }), []);
  assert.deepEqual(read({ 'src/c.test.mjs': `const a = 1; /* x */ const b = "${BENCH}/z";\n` }), [`src/c.test.mjs:1: ${BENCH}/`]);
  // a comment marker inside a string is not a comment, and a quote inside a regular expression is not a string
  assert.deepEqual(read({ 'src/d.test.mjs': `const url = 'http://x/*'; readFileSync('${FIXTURES}/q'); const re = /["']/;\n` }), [`src/d.test.mjs:1: ${FIXTURES}/`]);
  assert.deepEqual(read({ 'src/e.test.mjs': `const re = /["']/g; const s = 'fine';\nreadFileSync('${BENCH}/w');\n` }), [`src/e.test.mjs:2: ${BENCH}/`]);
});

test('the tokenizer reads strings, templates with interpolations, comments and the shebang', () => {
  const tokens = tokenize(`#!/usr/bin/env node\n// c\nconst a = \`x\${'in'}y\`; /* b */ f("s\\"q")\n`);
  assert.deepEqual(tokens.filter((token) => token.kind === 'str').map((token) => token.value), ['x', 'in', 'y', 's"q']);
  assert.equal(tokens.find((token) => token.value === 'f').line, 3);
});

test('an import or a spawn split over several lines is followed, and a template literal path is read', () => {
  const lines = read({
    't/world.mjs': `const g = readFileSync(\`../${FIXTURES}/a\`);\n`,
    't/multi.test.mjs': "const m = await import(\n  // the helper\n  './world.mjs'\n);\n",
    't/named.test.mjs': "import {\n  a,\n  b,\n} from\n  './world.mjs';\n",
    't/spawn.test.mjs': "spawnSync('node', [\n  't/world.mjs',\n]);\n",
    't/url.test.mjs': "const p = new URL(\n  './world.mjs',\n  import.meta.url,\n);\n",
  });
  assert.deepEqual(lines.filter((line) => line.includes(': reaches ')).map((line) => line.split(': reaches ')[0]).sort(), ['t/multi.test.mjs', 't/named.test.mjs', 't/spawn.test.mjs', 't/url.test.mjs']);
});

test('a script that imports or spawns a reader is a reader, however deep, until nothing new is found', () => {
  const lines = read({
    't/world.mjs': `const g = readFileSync(new URL('${FIXTURES}/a/golden.json', repo));\n`,
    't/mid.mjs': "export { adapterWorld } from './world.mjs';\n",
    't/top.test.mjs': "import { adapterWorld } from './mid';\n",
    't/ts.test.ts': "import { x } from './helper.js';\n",
    't/helper.ts': "import { adapterWorld } from './world.mjs';\n",
    't/clean.test.mjs': "import { y } from './clean-helper.mjs';\n",
    't/clean-helper.mjs': 'export const y = 1;\n',
    't/comment.test.mjs': "// import { adapterWorld } from './world.mjs';\n",
  });
  assert.deepEqual(lines.filter((line) => line.includes(': reaches ')).map((line) => line.split(': reaches ')[0]).sort(), ['t/helper.ts', 't/mid.mjs', 't/top.test.mjs', 't/ts.test.ts']);
  assert.ok(lines.includes(`t/world.mjs:1: ${FIXTURES}/`));
  assert.ok(lines.some((line) => line.startsWith('t/top.test.mjs: reaches t/mid.mjs, which reads local-only material at t/world.mjs:1')));
});

test('a tracked file that .gitignore also covers, of any extension, is not in a clean checkout: reaching it makes a reader', () => {
  const lines = read(
    {
      't/old.mjs': `const g = '${FIXTURES}/a';\n`,
      't/user.test.mjs': "import { z } from './old.mjs';\n",
      't/helper-user.test.mjs': "import { h } from './extensionless-helper';\n",
      't/data-user.test.mjs': "const d = JSON.parse(readFileSync(new URL('./recorded.json', import.meta.url)));\n",
      't/other.test.mjs': "import { z } from './fine.mjs';\n",
      't/fine.mjs': 'export const z = 1;\n',
    },
    new Set(['t/old.mjs', 't/extensionless-helper.ts', 't/recorded.json']),
  );
  assert.deepEqual(lines.map((line) => line.split(': reaches ')[0]).sort(), ['t/data-user.test.mjs', 't/helper-user.test.mjs', 't/user.test.mjs']);
  assert.match(lines.find((line) => line.startsWith('t/helper-user')), /extensionless-helper\.ts \(ignored by \.gitignore/);
});

test('a build checkout with local.toml, node_twin rustflags or material on disk is refused, a clean one is not', () => {
  assert.deepEqual(buildViolations({ localToml: false, env: { RUSTFLAGS: '-C debuginfo=0' }, present: [] }), []);
  assert.deepEqual(buildViolations({ localToml: true, env: {}, present: [] }), ['native/core/.cargo/local.toml exists: it turns on --cfg node_twin']);
  assert.deepEqual(buildViolations({ localToml: false, env: { CARGO_ENCODED_RUSTFLAGS: '--cfg\u001fnode_twin' }, present: [] }), ['CARGO_ENCODED_RUSTFLAGS sets node_twin']);
  assert.deepEqual(buildViolations({ localToml: false, env: {}, present: [`${FIXTURES}/`] }), [`${FIXTURES}/ is local-only comparison material, present in the checkout`]);
});

test('a require resolves the way Node does: .json and .node, a directory through package.json main or an index, and a query is dropped', () => {
  const gone = new Set(['t/recording.json', 't/native-helper.node', 't/pkgdir/lib/start.js', 't/dirindex/index.json', 't/helper.mjs']);
  const lines = read(
    {
      't/a.test.mjs': "const r = require('./recording');\n",
      't/b.test.mjs': "const n = require('./native-helper');\n",
      't/c.test.mjs': "const p = require('./pkgdir');\n",
      't/d.test.mjs': "const i = require('./dirindex');\n",
      't/e.test.mjs': "const h = await import('./helper.mjs?fixture');\n",
      't/f.test.mjs': "import h from './helper.mjs#frag';\n",
      't/pkgdir/package.json': '{ "main": "lib/start" }',
      't/g.test.mjs': "const ok = require('./other');\n",
      't/other.js': 'module.exports = 1;\n',
      't/other.json': '{}',
    },
    gone,
  );
  const reaching = lines.map((line) => line.split(': reaches ')[0]).sort();
  assert.deepEqual(reaching, ['t/a.test.mjs', 't/b.test.mjs', 't/c.test.mjs', 't/d.test.mjs', 't/e.test.mjs', 't/f.test.mjs']);
  // the order is Node's: './other' is other.js, which a clean checkout has
  assert.ok(!reaching.includes('t/g.test.mjs'));
});

test('a directory import with only a package.json and an index file both resolve; a missing target resolves to nothing', () => {
  const lines = read(
    {
      't/a.test.mjs': "import x from './lib';\n",
      't/lib/index.js': 'export default 1;\n',
      't/b.test.mjs': "import y from './nothing-here';\n",
      't/c.test.mjs': "import z from './lib/index.js?x=1';\n",
    },
    new Set(['t/lib/index.js']),
  );
  assert.deepEqual(lines.map((line) => line.split(': reaches ')[0]).sort(), ['t/a.test.mjs', 't/c.test.mjs']);
});
