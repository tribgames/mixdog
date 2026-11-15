import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { linkedModuleRoots, otherDriveAssetHandler, otherDriveFile, ownDrive } from './dev-linked-assets.ts';

// What the renderer asks for at start when node_modules really is on C: and the dev server runs on D: (the two Hangul
// slices and the mono face bootstrap.tsx loads before the first layout).
const MODULES = '/@fs/C:/install/node_modules';
const HANGUL = `${MODULES}/pretendard/dist/web/variable/woff2-dynamic-subset/PretendardVariable.subset.90.woff2`;
const MONO = `${MODULES}/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2`;

test('the allow list gets the real location of a linked node_modules', () => {
  const asked = [];
  const roots = linkedModuleRoots('D:/tree/apps/desktop', (path) => {
    asked.push(path);
    return 'C:\\install\\node_modules';
  });
  assert.deepEqual(asked, [resolve('D:/tree/apps/desktop', 'node_modules')]);
  assert.deepEqual(roots, ['C:\\install\\node_modules']);
  // No node_modules: nothing is added and the config still loads.
  assert.deepEqual(
    linkedModuleRoots('D:/tree/apps/desktop', () => {
      throw new Error('ENOENT');
    }),
    []
  );
});

test('the own drive is the working directory root Vite serves /@fs/ from', () => {
  assert.equal(ownDrive('D:\\'), 'D');
  assert.equal(ownDrive('d:\\'), 'D');
  // No drives (Linux, macOS): no request is taken over.
  assert.equal(ownDrive('/'), '');
  assert.equal(otherDriveFile(HANGUL, ''), null);
});

test('only an asset request for another drive is taken over', () => {
  assert.equal(otherDriveFile(HANGUL, 'D'), HANGUL.slice('/@fs/'.length));
  assert.equal(otherDriveFile(MONO, 'D'), MONO.slice('/@fs/'.length));
  // The codicon font carries a hash query; an encoded path is decoded.
  assert.equal(
    otherDriveFile(`${MODULES}/@vscode/codicons/dist/codicon.ttf?9aab63`, 'D'),
    'C:/install/node_modules/@vscode/codicons/dist/codicon.ttf'
  );
  assert.equal(otherDriveFile('/@fs/C:/my%20install/a.woff2', 'D'), 'C:/my install/a.woff2');
  // The same drive, in either case, is the dev server's own: it finds that file itself.
  assert.equal(otherDriveFile(HANGUL, 'C'), null);
  assert.equal(otherDriveFile(HANGUL.replace('C:', 'c:'), 'C'), null);
  // A module request of an asset is the transform middleware's.
  for (const query of ['?import', '?url', '?raw', '?inline', '?t=1&import', '?worker']) {
    assert.equal(otherDriveFile(`${MONO}${query}`, 'D'), null, query);
  }
  // Not an /@fs/ request, no drive, or a path that climbs.
  assert.equal(otherDriveFile('/seti.woff', 'D'), null);
  assert.equal(otherDriveFile('/@fs/install/a.woff2', 'D'), null);
  assert.equal(otherDriveFile('/@fs/C:/install/../secret/a.woff2', 'D'), null);
  assert.equal(otherDriveFile('/@fs/C:/install/%E0%A4%A/a.woff2', 'D'), null);
});

function response() {
  const chunks = [];
  const headers = {};
  const res = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  res.setHeader = (name, value) => {
    headers[name.toLowerCase()] = value;
  };
  res.statusCode = 0;
  return { res, headers, body: () => Buffer.concat(chunks), ended: new Promise((done) => res.on('finish', done)) };
}

const windowsOnly = { skip: process.platform !== 'win32' };

test('the font of another drive is answered with its bytes, not handed to the page fallback', windowsOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-linked-assets-'));
  try {
    const font = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 2, 3]);
    writeFileSync(join(dir, 'face.woff2'), font);
    const file = join(dir, 'face.woff2').replace(/\\/g, '/');
    const url = `/@fs/${encodeURI(file)}`;
    // The dev server "runs" on a drive that is not the file's.
    const own = parse(dir).root[0].toUpperCase() === 'Q' ? 'R' : 'Q';
    const served = [];
    const serves = (path) => served.push(path) > 0;
    const handler = otherDriveAssetHandler({ own, serves, headers: () => ({ 'X-Dev': '1' }) });

    const got = response();
    let passed = 0;
    handler({ method: 'GET', url }, got.res, () => passed++);
    await got.ended;
    assert.equal(passed, 0);
    assert.deepEqual(served, [file]);
    assert.equal(got.res.statusCode, 200);
    assert.equal(got.headers['content-type'], 'font/woff2');
    assert.equal(got.headers['content-length'], font.length);
    assert.equal(got.headers['x-dev'], '1');
    assert.deepEqual(got.body(), font);

    const head = response();
    handler({ method: 'HEAD', url }, head.res, () => passed++);
    await head.ended;
    assert.equal(head.res.statusCode, 200);
    assert.equal(head.body().length, 0);

    // Outside the allow list, a missing file, a folder, another method: the dev server's own answer.
    const refused = otherDriveAssetHandler({ own, serves: () => false });
    refused({ method: 'GET', url }, response().res, () => passed++);
    handler({ method: 'GET', url: `${url}.missing` }, response().res, () => passed++);
    handler({ method: 'GET', url: `/@fs/${encodeURI(dir.replace(/\\/g, '/'))}` }, response().res, () => passed++);
    handler({ method: 'POST', url }, response().res, () => passed++);
    assert.equal(passed, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
