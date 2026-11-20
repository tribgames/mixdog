// The skill launcher runs user and plugin scripts on the shipped interpreter with only its own small file set
// beside it: the entry copied alone into an empty package root (no npm package, no office runtime) runs a script.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';
import {
  copyPptxgenjsData,
  launcherRuntimeFiles,
  PPTXGENJS_DATA_DIR,
  SKILL_LAUNCHER_ENTRY,
} from './stage-js-bundle.mjs';

const rootDir = join(import.meta.dirname, '..', '..', '..');

const put = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** A package root holding exactly the launcher file set. */
function minimalPackage(work) {
  const packageDir = join(work, 'node_modules', 'mixdog');
  for (const file of launcherRuntimeFiles(rootDir)) {
    mkdirSync(dirname(join(packageDir, file)), { recursive: true });
    cpSync(join(rootDir, file), join(packageDir, file));
  }
  return join(packageDir, SKILL_LAUNCHER_ENTRY);
}

const argvCarrier = (args) => `mixdog1${args.map((arg) => `,${Buffer.from(arg, 'utf8').toString('base64')}`).join('')}`;

const run = (entry, args, env = {}) =>
  spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

test('the launcher file set is the entry and its helpers, with no npm package', () => {
  const files = launcherRuntimeFiles(rootDir);
  assert.ok(files.includes(SKILL_LAUNCHER_ENTRY));
  assert.ok(files.includes('src/runtime/shared/skill-script-runtime.mjs'));
  assert.ok(files.every((file) => file.startsWith('src/')));
  assert.ok(!files.some((file) => file.startsWith('src/runtime/office/')));
});

test('a script requires a package from its own node_modules and is the main module', () => {
  const work = makeTempDirSync('launcher-own-modules');
  const entry = minimalPackage(work);
  const skill = join(work, 'skill');
  put(join(skill, 'node_modules', 'own-package', 'package.json'), '{"name":"own-package","main":"index.js"}');
  put(join(skill, 'node_modules', 'own-package', 'index.js'), 'module.exports = { answer: 42 };');
  put(
    join(skill, 'scripts', 'run.mjs'),
    [
      "import { createRequire } from 'node:module';",
      "import { pathToFileURL } from 'node:url';",
      'const own = createRequire(import.meta.url)("own-package");',
      'const main = import.meta.url === pathToFileURL(process.argv[1]).href;',
      'console.log(JSON.stringify({ answer: own.answer, main, args: process.argv.slice(2), electron: process.env.ELECTRON_RUN_AS_NODE ?? null }));',
    ].join('\n')
  );
  const result = run(entry, [join(skill, 'scripts', 'run.mjs'), 'a', 'b c'], { ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { answer: 42, main: true, args: ['a', 'b c'], electron: null });
});

test('a non-ASCII path and empty arguments carried the PowerShell way reach the script unchanged', () => {
  const work = makeTempDirSync('launcher-argv');
  const entry = minimalPackage(work);
  const script = join(work, '스킬 폴더', 'scripts', '실행.mjs');
  put(
    script,
    'console.log(JSON.stringify({ args: process.argv.slice(2), carried: process.env.MIXDOG_SKILL_ARGV ?? null }));'
  );
  const args = [script, '', 'quote"d', '한글', ''];
  const result = run(entry, [], { MIXDOG_SKILL_ARGV: argvCarrier(args) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args: ['', 'quote"d', '한글', ''], carried: null });
});

test('a failing script ends the process with exit code 1 and its stack; no target is usage and exit code 2', () => {
  const work = makeTempDirSync('launcher-exit');
  const entry = minimalPackage(work);
  const script = join(work, 'throws.mjs');
  put(script, "throw new Error('boom');");
  const failed = run(entry, [script]);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /boom/);
  const none = run(entry, []);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /Usage/);
});

test('the pptxgenjs files are copied as data beside the package', async () => {
  const work = makeTempDirSync('launcher-pptx-data');
  const modulesDir = join(work, 'node_modules');
  put(join(modulesDir, 'pptxgenjs', 'dist', 'pptxgen.cjs.js'), 'a');
  put(join(modulesDir, 'pptxgenjs', 'LICENSE'), 'b');
  put(join(modulesDir, 'jszip', 'dist', 'jszip.min.js'), 'c');
  put(join(modulesDir, 'jszip', 'LICENSE.markdown'), 'd');
  const packageDir = join(work, 'package');
  await copyPptxgenjsData({ modulesDir, packageDir });
  const dir = join(packageDir, PPTXGENJS_DATA_DIR);
  assert.equal(readFileSync(join(dir, 'pptxgen.cjs.js'), 'utf8'), 'a');
  for (const name of ['LICENSE-pptxgenjs', 'jszip.min.js', 'LICENSE-jszip.markdown'])
    assert.ok(existsSync(join(dir, name)));
});
