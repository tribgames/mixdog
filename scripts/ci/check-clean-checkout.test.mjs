import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildCheck, buildViolations, findReaders, testTargetsOf, tokenize } from './check-clean-checkout.mjs';

// The tracked file .gitignore also covers in these trees: a clean checkout of the change does not have it.
const GONE = 't/recorded.json';
const read = (files, gone = new Set([GONE])) => findReaders(new Map(Object.entries(files)), gone);
const readers = (lines) => lines.map((line) => line.split(': reaches ')[0]).sort();

test('a string naming a gone file is a read; comments and other files are not', () => {
  assert.deepEqual(
    readers(
      read({
        'src/a.test.mjs': `import x from 'y';\nconst g = readFileSync('${GONE}');\n`,
        'src/b.test.mjs': `// Replay of ${GONE} (recorded)\n/* ${GONE} */\n/**\n * ${GONE}\n */\n`,
        't/c.test.mjs': "const d = JSON.parse(readFileSync(new URL('./recorded.json', import.meta.url)));\n",
        'src/f.test.mjs': "const ok = readFileSync(new URL('./data/own.json', import.meta.url));\n",
      })
    ),
    ['src/a.test.mjs', 't/c.test.mjs']
  );
});

test("nothing is exempt: the gate's own scripts are scanned like any other", () => {
  assert.deepEqual(read({ 'scripts/ci/a.test.mjs': `const text = readFileSync('${GONE}');\n` }), [
    `scripts/ci/a.test.mjs: reaches ${GONE}, which leads to ${GONE} (tracked, and covered by .gitignore: not in a clean checkout)`,
  ]);
});

test('a block comment that closes before the code on its line does not hide the code; one that is still open does', () => {
  assert.deepEqual(readers(read({ 'src/a.test.mjs': `/* fixture */ readFileSync("${GONE}");\n` })), ['src/a.test.mjs']);
  assert.deepEqual(
    read({
      'src/b.test.mjs': `/* one */ /* two */ const x = 1; // "${GONE}"\n/* open\n readFileSync("${GONE}");\n close */ const y = 2;\n`,
    }),
    []
  );
  assert.deepEqual(readers(read({ 'src/c.test.mjs': `const a = 1; /* x */ const b = "${GONE}";\n` })), ['src/c.test.mjs']);
  // a comment marker inside a string is not a comment, and a quote inside a regular expression is not a string
  assert.deepEqual(
    readers(read({ 'src/d.test.mjs': `const url = 'http://x/*'; readFileSync('${GONE}'); const re = /["']/;\n` })),
    ['src/d.test.mjs']
  );
  assert.deepEqual(
    readers(read({ 'src/e.test.mjs': `const re = /["']/g; const s = 'fine';\nreadFileSync('${GONE}');\n` })),
    ['src/e.test.mjs']
  );
});

test('the tokenizer reads strings, templates with interpolations, comments and the shebang', () => {
  const tokens = tokenize(`#!/usr/bin/env node\n// c\nconst a = \`x\${'in'}y\`; /* b */ f("s\\"q")\n`);
  assert.deepEqual(
    tokens.filter((token) => token.kind === 'str').map((token) => token.value),
    ['x', 'in', 'y', 's"q']
  );
  assert.equal(tokens.find((token) => token.value === 'f').line, 3);
});

test('an import or a spawn split over several lines is followed, and a template literal path is read', () => {
  const lines = read({
    't/world.mjs': "const g = readFileSync(`./recorded.json`);\n",
    't/multi.test.mjs': "const m = await import(\n  // the helper\n  './world.mjs'\n);\n",
    't/named.test.mjs': "import {\n  a,\n  b,\n} from\n  './world.mjs';\n",
    't/spawn.test.mjs': "spawnSync('node', [\n  't/world.mjs',\n]);\n",
    't/url.test.mjs': "const p = new URL(\n  './world.mjs',\n  import.meta.url,\n);\n",
  });
  assert.deepEqual(readers(lines), ['t/multi.test.mjs', 't/named.test.mjs', 't/spawn.test.mjs', 't/url.test.mjs', 't/world.mjs']);
});

test('a script that imports or spawns a reader is a reader, however deep, until nothing new is found', () => {
  const lines = read({
    't/world.mjs': "const g = readFileSync(new URL('./recorded.json', import.meta.url));\n",
    't/mid.mjs': "export { adapterWorld } from './world.mjs';\n",
    't/top.test.mjs': "import { adapterWorld } from './mid';\n",
    't/ts.test.ts': "import { x } from './helper.js';\n",
    't/helper.ts': "import { adapterWorld } from './world.mjs';\n",
    't/clean.test.mjs': "import { y } from './clean-helper.mjs';\n",
    't/clean-helper.mjs': 'export const y = 1;\n',
    't/comment.test.mjs': "// import { adapterWorld } from './world.mjs';\n",
  });
  assert.deepEqual(readers(lines), ['t/helper.ts', 't/mid.mjs', 't/top.test.mjs', 't/ts.test.ts', 't/world.mjs']);
  assert.ok(lines.some((line) => line.startsWith(`t/top.test.mjs: reaches t/mid.mjs, which leads to ${GONE} (tracked`)));
});

test('a tracked file that .gitignore also covers, of any extension, is not in a clean checkout: reaching it makes a reader', () => {
  const lines = read(
    {
      't/old.mjs': 'export const z = 1;\n',
      't/user.test.mjs': "import { z } from './old.mjs';\n",
      't/helper-user.test.mjs': "import { h } from './extensionless-helper';\n",
      't/data-user.test.mjs': "const d = JSON.parse(readFileSync(new URL('./recorded.json', import.meta.url)));\n",
      't/other.test.mjs': "import { z } from './fine.mjs';\n",
      't/fine.mjs': 'export const z = 1;\n',
    },
    new Set(['t/old.mjs', 't/extensionless-helper.ts', GONE])
  );
  assert.deepEqual(readers(lines), ['t/data-user.test.mjs', 't/helper-user.test.mjs', 't/user.test.mjs']);
  assert.match(
    lines.find((line) => line.startsWith('t/helper-user')),
    /extensionless-helper\.ts \(tracked, and covered by \.gitignore/
  );
});

test('a build checkout with no Cargo test target on disk outside git passes', () => {
  assert.deepEqual(buildViolations({ targets: [], tracked: new Set() }), []);
  assert.deepEqual(buildViolations({ targets: ['c/tests/a.rs'], tracked: new Set(['c/tests/a.rs']) }), []);
});

test('a Cargo test target on disk that is not tracked is refused, whether .gitignore covers it or not', () => {
  const dir = 'native/core/crates/a';
  const targets = testTargetsOf(dir, [
    { name: 'wire.rs' },
    { name: 'left_on_the_runner.rs' },
    { name: 'it/', hasMain: true },
    { name: 'gathered/', hasMain: true },
    { name: 'support/', hasMain: false },
    { name: 'data.json' },
  ]);
  assert.deepEqual(targets, [
    `${dir}/tests/wire.rs`,
    `${dir}/tests/left_on_the_runner.rs`,
    `${dir}/tests/it/main.rs`,
    `${dir}/tests/gathered/main.rs`,
  ]);
  assert.deepEqual(testTargetsOf('', [{ name: 'root.rs' }]), ['tests/root.rs']);
  // no ignore list is consulted: only whether git tracks the file
  const tracked = new Set([`${dir}/tests/wire.rs`, `${dir}/tests/it/main.rs`, `${dir}/tests/it/case.rs`]);
  assert.deepEqual(buildViolations({ targets, tracked }), [
    `${dir}/tests/left_on_the_runner.rs is a Cargo test target on disk that is not tracked`,
    `${dir}/tests/gathered/main.rs is a Cargo test target on disk that is not tracked`,
  ]);
});

test('the build check reads the disk: linked test files and folders are targets, a tracked non-ASCII one is tracked', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'clean-build-'));
  try {
    const write = (path, text = '') => {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write('crate/Cargo.toml', '[package]\nname = "crate"\n');
    write('crate/src/lib.rs');
    write('crate/tests/café.rs');
    write('crate/tests/wire.rs');
    write('crate/tests/support/helper.rs');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    // untracked, and covered by no ignore rule: a folder with main.rs and a Rust source, each linked into tests/
    write('elsewhere/main.rs');
    symlinkSync(join(root, 'elsewhere'), join(root, 'crate/tests/gathered'), 'junction');
    let fileLink = true;
    try {
      symlinkSync(join(root, 'crate/src/lib.rs'), join(root, 'crate/tests/leftover.rs'), 'file');
    } catch (error) {
      // a Windows account without the symlink privilege cannot make a file link; a folder junction needs none
      if (!(process.platform === 'win32' && error.code === 'EPERM')) throw error;
      fileLink = false;
    }
    assert.deepEqual(buildCheck(root).sort(), [
      'crate/tests/gathered/main.rs is a Cargo test target on disk that is not tracked',
      ...(fileLink ? ['crate/tests/leftover.rs is a Cargo test target on disk that is not tracked'] : []),
    ]);
    if (!fileLink) t.skip('file symlinks are unavailable to this account; the linked folder and the tracked names were checked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a require resolves the way Node does: .json and .node, a directory through package.json main or an index, and a query is dropped', () => {
  const gone = new Set([
    't/recording.json',
    't/native-helper.node',
    't/pkgdir/lib/start.js',
    't/dirindex/index.json',
    't/helper.mjs',
  ]);
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
    gone
  );
  const reaching = lines.map((line) => line.split(': reaches ')[0]).sort();
  assert.deepEqual(reaching, [
    't/a.test.mjs',
    't/b.test.mjs',
    't/c.test.mjs',
    't/d.test.mjs',
    't/e.test.mjs',
    't/f.test.mjs',
  ]);
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
    new Set(['t/lib/index.js'])
  );
  assert.deepEqual(lines.map((line) => line.split(': reaches ')[0]).sort(), ['t/a.test.mjs', 't/c.test.mjs']);
});
