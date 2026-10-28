import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const helper = new URL('./electron-binary.mjs', import.meta.url).href;

/** A cold electron package: the real resolver, and an install step that
 *  "downloads" by printing progress to stdout and writing the binary. */
function coldPackage(t) {
  const dir = mkdtempSync(join(tmpdir(), 'electron-cold-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'electron', main: 'index.js' }));
  copyFileSync(require.resolve('electron/index.js'), join(dir, 'index.js'));
  writeFileSync(
    join(dir, 'install.js'),
    `const fs = require('fs'), path = require('path');
     console.log('Downloading electron-v0.0.0-win32-x64.zip: 100%');
     fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
     fs.writeFileSync(path.join(__dirname, 'dist', 'electron.exe'), '');
     fs.writeFileSync(path.join(__dirname, 'path.txt'), 'electron.exe');`
  );
  return dir;
}

function run(args) {
  const env = { ...process.env };
  delete env.ELECTRON_OVERRIDE_DIST_PATH;
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('a cold electron package prints its download to stdout when resolved directly', (t) => {
  const dir = coldPackage(t);
  const stdout = run(['-p', 'require(process.argv[1])', dir]);
  assert.match(stdout, /^Downloading Electron binary\.\.\.\n/);
  assert.notEqual(stdout.trim(), join(dir, 'dist', 'electron.exe'));
});

test('the Electron binary helper downloads a cold package and outputs only its path', (t) => {
  const dir = coldPackage(t);
  const binary = join(dir, 'dist', 'electron.exe');
  const resolve = () =>
    run([
      '--input-type=module',
      '-e',
      `import { electronBinary } from ${JSON.stringify(helper)}; process.stdout.write(electronBinary(process.argv[1]));`,
      dir,
    ]);
  assert.equal(resolve(), binary);
  assert.ok(existsSync(binary));
  // Warm: the binary is in place, and the path is still all that is written.
  assert.equal(resolve(), binary);
});
