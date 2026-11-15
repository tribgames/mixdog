// The remote JS runtime keeps working with only the packages the entry points reach: the real staging
// (deriveRemoteRoots -> trimmed manifest and lockfile -> `npm ci`) builds a payload for this machine's
// platform, and the pptxgenjs authoring script entry (the one script the native office worker starts) plus every shipped
// skill script run from it under its own node, with no node_modules above it to fall back on. Network and a few
// minutes of npm; set MIXDOG_BUILD_SCRATCH (and TEMP, npm_config_cache) to a disk with room (~1 GB).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeTempDirSync } from '../../../../../scripts/lib/scoped-temp.mjs';
import { remoteJsEntries } from '../../../scripts/remote-js-roots.mjs';
import { buildJsPayload, packedFiles } from '../../../scripts/stage-js-bundle.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const key = `${process.platform}-${process.arch}`;
test('the pptxgenjs authoring entry and the skill scripts pass on the trimmed bundle', { timeout: 1_800_000 }, async () => {
  const work = process.env.MIXDOG_BUILD_SCRATCH ? resolve(process.env.MIXDOG_BUILD_SCRATCH, `trimmed-${process.pid}`) : makeTempDirSync('trimmed-bundle');
  const payloadDir = join(work, 'payload');
  await buildJsPayload({
    key,
    payloadDir,
    cacheDir: join(work, 'cache'),
    fetchNode: async () => ({ node: process.execPath, license: join(repoRoot, 'LICENSE'), version: process.version }),
    listPackageFiles: packedFiles,
  });
  const modules = join(payloadDir, 'js', 'pkg', 'node_modules');
  const packageRoot = join(modules, 'mixdog');
  // The payload's `node` is this machine's node.exe under an extensionless name, which Windows cannot run.
  const node = process.platform === 'win32' ? process.execPath : join(payloadDir, 'js', 'node');

  // What was left out stays out, and what the entry points reach is there.
  for (const gone of ['openai', '@img/sharp-wasm32', '@img/sharp-linuxmusl-x64', '@napi-rs/canvas-linux-x64-musl']) {
    assert.equal(existsSync(join(modules, gone)), false, `${gone} should not ship`);
  }
  for (const root of ['pptxgenjs', 'sharp', 'jsdom', 'pdf-lib', 'pdfjs-dist', 'puppeteer-core', '@napi-rs/canvas']) {
    assert.ok(existsSync(join(modules, root, 'package.json')), `${root} should ship`);
  }

  // NODE_TEST_CONTEXT would make an inner `node --test` run as a child of this test and print nothing.
  const env = { ...process.env, NODE_OPTIONS: '' };
  delete env.NODE_TEST_CONTEXT;

  // The authoring entry as the office worker starts it: one JSON request on stdin, one marked answer line on stdout.
  const output = join(work, 'deck.pptx');
  const script = [
    "const PptxGenJS = require('pptxgenjs');",
    'const pres = new PptxGenJS();',
    "pres.addSlide().addText('Hello', { x: 1, y: 1, w: 4, h: 1 });",
    'await pres.writeFile({ fileName: OUTPUT });',
  ].join('\n');
  const authored = spawnSync(node, [join(packageRoot, 'src', 'runtime', 'office', 'authoring', 'pptx-script-entry.mjs')], {
    cwd: work,
    env,
    input: JSON.stringify({ script, output, cwd: work }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(authored.status, 0, `${authored.stdout}\n${authored.stderr}`.slice(-6000));
  const marker = '\u0000mixdog-pptx-script-answer\u0000';
  const answerLine = authored.stdout.split('\n').find((line) => line.startsWith(marker));
  assert.ok(answerLine, `no answer line: ${authored.stdout.slice(-3000)}`);
  assert.equal(JSON.parse(answerLine.slice(marker.length)).thrown, undefined, answerLine);
  assert.ok(existsSync(output) && readFileSync(output).subarray(0, 2).toString() === 'PK', 'the deck is a zip');

  // Every shipped skill script's module graph loads under the bundle: importing is enough (the scripts only
  // run their main when they are the entry), and an import that reaches a package the trim left out fails.
  const scripts = remoteJsEntries(repoRoot).filter((entry) => entry.startsWith('src/defaults/skills/'));
  assert.ok(scripts.length >= 5, `skill scripts: ${scripts.join(', ')}`);
  for (const script of scripts) {
    const url = pathToFileURL(join(packageRoot, script)).href;
    const loaded = spawnSync(node, ['--input-type=module', '-e', `await import(${JSON.stringify(url)});`], { cwd: work, env, encoding: 'utf8' });
    assert.equal(loaded.status, 0, `${script}: ${loaded.stderr}`.slice(-3000));
  }
});