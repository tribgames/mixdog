// An interrupted stage never leaves a tree that the next stage would package: createBundleArchive moves
// the payload into its assembly, so a killed run leaves the payload there (and none at payloadDir), and
// a failed tar puts it back. The next run rebuilds the payload from nothing and the archive holds only it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';
import { buildJsPayload, createBundleArchive, fetchPinnedNode } from './stage-js-bundle.mjs';

const put = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

test('a half-moved payload from an interrupted stage is rebuilt, never packaged', async () => {
  const work = makeTempDirSync('stage-interrupted');
  const payloadDir = join(work, 'payload');
  const binary = join(work, 'mixdogd');
  put(binary, 'binary');
  const fakeNode = join(work, 'node-src');
  put(fakeNode, 'node');
  put(join(work, 'LICENSE'), 'license');
  const build = () =>
    buildJsPayload({
      key: 'linux-x64',
      payloadDir,
      cacheDir: join(work, 'cache'),
      fetchNode: async () => ({ node: fakeNode, license: join(work, 'LICENSE'), version: 'v0' }),
      installModules: async (pkgDir) => mkdirSync(join(pkgDir, 'node_modules'), { recursive: true }),
      listPackageFiles: async () => [],
    });

  // A failed tar (its output directory does not exist) puts the payload back.
  await build();
  await assert.rejects(createBundleArchive({ binary, payloadDir, out: join(work, 'missing', 'bundle.tgz') }));
  assert.ok(existsSync(join(payloadDir, 'js', 'node')), 'payload restored after a failed tar');

  // A killed run: the payload is inside the assembly with a stale file, a truncated archive is left, and
  // payloadDir is gone.
  const assembly = `${payloadDir}.assembly`;
  put(join(assembly, 'payload', 'js', 'node'), 'half');
  put(join(assembly, 'payload', 'stale-partial-file'), 'x');
  put(join(assembly, 'mixdogd'), 'old');
  put(join(work, 'bundle.tgz'), 'truncated');
  await (await import('node:fs/promises')).rm(payloadDir, { recursive: true, force: true });

  await build();
  const out = join(work, 'bundle.tgz');
  await createBundleArchive({ binary, payloadDir, out });
  const listed = execFileSync('tar', ['-tzf', out], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  assert.ok(listed.some((name) => name.replace(/\/$/, '') === 'payload/js-runtime.json'));
  assert.ok(listed.some((name) => name === 'mixdogd'));
  assert.equal(listed.some((name) => name.includes('stale-partial-file')), false);
  assert.equal(existsSync(assembly), false);
  assert.equal(readFileSync(join(payloadDir, 'js', 'node'), 'utf8'), 'node');
});

test('the cached Node is verified against the pin every time; a tampered cache is fetched again', async () => {
  const work = makeTempDirSync('stage-node-pin');
  const name = 'node-v1.0.0-linux-x64';
  const src = join(work, 'src', name);
  put(join(src, 'bin', 'node'), 'real node');
  put(join(src, 'LICENSE'), 'license');
  const tarball = join(work, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', tarball, '-C', join(work, 'src'), name]);
  const bytes = readFileSync(tarball);
  const pin = { version: '1.0.0', sha256: { 'linux-x64': createHash('sha256').update(bytes).digest('hex') } };
  let fetches = 0;
  const fetchImpl = async () => {
    fetches++;
    return { ok: true, arrayBuffer: async () => bytes };
  };
  const cacheDir = join(work, 'cache');
  const fetchNode = () => fetchPinnedNode('linux-x64', cacheDir, { pin, fetchImpl });

  const first = await fetchNode();
  assert.equal(fetches, 1);
  assert.equal(readFileSync(first.node, 'utf8'), 'real node');
  await fetchNode();
  assert.equal(fetches, 1, 'a verified cache is reused');

  // A changed extraction is replaced from the verified tarball without a download.
  writeFileSync(first.node, 'evil node');
  assert.equal(readFileSync((await fetchNode()).node, 'utf8'), 'real node');
  assert.equal(fetches, 1);

  // A changed tarball fails the pin: it is deleted and fetched again, never bundled.
  writeFileSync(join(cacheDir, `${name}.tar.gz`), 'evil archive');
  assert.equal(readFileSync((await fetchNode()).node, 'utf8'), 'real node');
  assert.equal(fetches, 2);

  // A download that does not match the pin is refused.
  await assert.rejects(fetchPinnedNode('linux-x64', join(work, 'other'), { pin, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('x') }) }), /does not match its pin/);
});
