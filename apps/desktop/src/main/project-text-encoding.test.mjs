import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  decodeProjectText,
  readProjectTextFileIn as read,
  writeProjectTextFileIn as save,
  writeProjectTextFilesIn as saveMany,
} from './project-files.ts';

async function fixture(t, files) {
  const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-text-encoding-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(join(root, name), bytes);
  return root;
}

// Fixtures deliberately encode independently from the production codec.
function encoded(text, encoding, bom = false) {
  if (encoding === 'utf8' || encoding === 'utf8bom') {
    return Buffer.concat([Buffer.from(encoding === 'utf8bom' ? [0xef, 0xbb, 0xbf] : []), Buffer.from(text)]);
  }
  const little = Buffer.from(text, 'utf16le');
  const bytes = Buffer.from(little);
  if (encoding === 'utf16be') {
    for (let i = 0; i < bytes.length; i += 2) {
      bytes[i] = little[i + 1];
      bytes[i + 1] = little[i];
    }
  }
  return Buffer.concat([Buffer.from(bom ? (encoding === 'utf16be' ? [0xfe, 0xff] : [0xff, 0xfe]) : []), bytes]);
}

function hook(t, name, action) {
  const original = fs[name];
  const mock = t.mock.method(fs, name, (...args) => action(original, ...args));
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
}

const variants = [['utf8', false], ['utf8bom', true], ['utf16le', true], ['utf16be', true], ['utf16le', false], ['utf16be', false]];
const text = 'plain ASCII source '.repeat(8) + '\r\n한글 😀 \uFFFD\uFEFF\nlast\rline';
for (const [encoding, bom] of variants) {
  test(`ordinary ${encoding} (BOM ${bom}) saves and batch writes preserve bytes and BOM`, async (t) => {
    const bytes = encoded(text, encoding, bom);
    const root = await fixture(t, { 'a.txt': bytes });
    const opened = await read(root, 'a.txt');
    assert.equal(opened.readOnly, undefined);
    assert.equal(opened.content, text);
    assert.equal(opened.encoding, encoding);
    await save(root, 'a.txt', opened.content, opened.content);
    assert.deepEqual(await fs.readFile(join(root, 'a.txt')), bytes);
    const changed = text.replace('source', 'edited');
    await save(root, 'a.txt', changed, text);
    assert.deepEqual(await fs.readFile(join(root, 'a.txt')), encoded(changed, encoding, bom));
    await saveMany(root, [{ relPath: 'a.txt', content: text, expectedContent: changed }]);
    assert.deepEqual(await fs.readFile(join(root, 'a.txt')), bytes);
    assert.deepEqual(await fs.readdir(root), ['a.txt']);
  });
}

for (const [encoding, bom] of variants.slice(0, 4)) {
  for (const content of ['', '\uFEFFdata\r\n']) {
    test(`${encoding} empty/leading-FEFF payload ${JSON.stringify(content)} round-trips`, async (t) => {
      // In plain UTF-8 a leading FEFF is a BOM by definition; use a non-leading
      // FEFF there and test the double marker in the BOM-bearing variants.
      const value = encoding === 'utf8' && content ? `x${content}` : content;
      const bytes = encoded(value, encoding, bom);
      const root = await fixture(t, { 'a.txt': bytes });
      assert.equal((await read(root, 'a.txt')).content, value);
      await save(root, 'a.txt', value, value);
      assert.deepEqual(await fs.readFile(join(root, 'a.txt')), bytes);
    });
  }
  test(`explicit conversion to ${encoding} keeps the existing BOM-on conversion contract`, async (t) => {
    const root = await fixture(t, { 'a.txt': encoded(text, 'utf16le', false) });
    await save(root, 'a.txt', text, text, encoding);
    assert.deepEqual(await fs.readFile(join(root, 'a.txt')), encoded(text, encoding, bom));
  });
}

const malformed = [
  ['UTF8 continuation', Buffer.from([0x61, 0x80, 0x62])],
  ['UTF8 truncated', Buffer.from([0x61, 0xe2, 0x82])],
  ['UTF8 overlong', Buffer.from([0xc0, 0xaf])],
  ['UTF8 surrogate', Buffer.from([0xed, 0xa0, 0x80])],
  ['UTF8 beyond sniff', Buffer.concat([Buffer.alloc(9_000, 0x61), Buffer.from([0xff])])],
  ['UTF8 BOM malformed', Buffer.from([0xef, 0xbb, 0xbf, 0x80])],
  ['UTF16 LE odd', Buffer.from([0xff, 0xfe, 0x41, 0, 0x42])],
  ['UTF16 BE odd', Buffer.from([0xfe, 0xff, 0, 0x41, 0x42])],
  ['UTF16 LE high surrogate', Buffer.from([0xff, 0xfe, 0, 0xd8])],
  ['UTF16 BE low surrogate', Buffer.from([0xfe, 0xff, 0xdc, 0])],
  ['UTF16 LE BOM-less odd', Buffer.concat([encoded('abcdefgh', 'utf16le'), Buffer.from([65])])],
  ['UTF16 BE BOM-less odd', Buffer.concat([encoded('abcdefgh', 'utf16be'), Buffer.from([65])])],
];
for (const [name, bytes] of malformed) {
  test(`${name} is display-only; ordinary, conversion and batch writes cannot overwrite it`, async (t) => {
    const root = await fixture(t, { 'a.txt': bytes, 'b.txt': 'safe' });
    const opened = await read(root, 'a.txt');
    assert.equal(opened.binary, false);
    assert.equal(opened.readOnly, true);
    assert.equal(opened.readOnlyReason, 'encoding');
    assert.equal(decodeProjectText(bytes).lossless, false);
    let swaps = 0;
    hook(t, 'rename', (rename, ...args) => { swaps++; return rename(...args); });
    await assert.rejects(save(root, 'a.txt', opened.content, opened.content), /invalid text encoding/);
    await assert.rejects(save(root, 'a.txt', 'converted', opened.content, 'utf8'), /invalid text encoding/);
    await assert.rejects(saveMany(root, [
      { relPath: 'b.txt', content: 'updated', expectedContent: 'safe' },
      { relPath: 'a.txt', content: 'updated', expectedContent: opened.content },
    ]), /invalid text encoding/);
    assert.equal(swaps, 0, 'batch preflight must refuse before the first replacement');
    assert.deepEqual(await fs.readFile(join(root, 'a.txt')), bytes);
    assert.equal(await fs.readFile(join(root, 'b.txt'), 'utf8'), 'safe');
    assert.deepEqual((await fs.readdir(root)).sort(), ['a.txt', 'b.txt']);
  });
}

for (const bad of ['\ud800', '\udc00']) {
  for (const [encoding] of variants.slice(0, 4)) {
    test(`${encoding} rejects an unpaired output surrogate ${bad.charCodeAt(0).toString(16)}`, async (t) => {
      const root = await fixture(t, { 'a.txt': 'safe', 'b.txt': 'safe' });
      let creates = 0;
      hook(t, 'open', (open, ...args) => { creates++; return open(...args); });
      await assert.rejects(save(root, 'a.txt', bad, 'safe', encoding), /unpaired Unicode/);
      await assert.rejects(saveMany(root, [
        { relPath: 'a.txt', content: 'updated', expectedContent: 'safe' },
        { relPath: 'b.txt', content: bad, expectedContent: 'safe' },
      ]), /unpaired Unicode/);
      assert.equal(creates, 0, 'invalid output is rejected before temp-file creation');
      assert.equal(await fs.readFile(join(root, 'a.txt'), 'utf8'), 'safe');
      assert.equal(await fs.readFile(join(root, 'b.txt'), 'utf8'), 'safe');
    });
  }
}

for (const [name, before, external] of [
  ['BOM-only change', encoded('abcdefgh', 'utf16le'), encoded('abcdefgh', 'utf16le', true)],
  ['same decoded display with corrupt bytes', Buffer.from('a\uFFFDb'), Buffer.from([0x61, 0x80, 0x62])],
]) {
  test(`final byte recheck rejects ${name} during temp creation`, async (t) => {
    const root = await fixture(t, { 'a.txt': before });
    const file = join(root, 'a.txt');
    hook(t, 'open', async (open, path, ...args) => {
      const handle = await open(path, ...args);
      if (String(path).includes('.mixdog-save-')) await fs.writeFile(file, external);
      return handle;
    });
    await assert.rejects(save(root, 'a.txt', 'edited', decodeProjectText(before).content), /changed on disk/);
    assert.deepEqual(await fs.readFile(file), external);
    assert.deepEqual(await fs.readdir(root), ['a.txt']);
  });
}

test('invalid encoding takes precedence over the read-only size reason', async (t) => {
  const bytes = Buffer.concat([Buffer.alloc(1_048_576, 0x61), Buffer.from([0x80])]);
  const root = await fixture(t, { 'a.txt': bytes });
  const opened = await read(root, 'a.txt');
  assert.equal(opened.readOnly, true);
  assert.equal(opened.readOnlyReason, 'encoding');
});

test('a successful batch rollback preserves the original BOM-less UTF-16 bytes', async (t) => {
  const before = encoded('original text', 'utf16le');
  const root = await fixture(t, { 'a.txt': before, 'b.txt': 'second' });
  hook(t, 'rename', (rename, source, target) => {
    if (String(target) === join(root, 'b.txt')) throw Object.assign(new Error('injected save failure'), { code: 'EIO' });
    return rename(source, target);
  });
  await assert.rejects(saveMany(root, [
    { relPath: 'a.txt', content: 'replacement text', expectedContent: 'original text' },
    { relPath: 'b.txt', content: 'updated', expectedContent: 'second' },
  ]), /injected save failure/);
  assert.deepEqual(await fs.readFile(join(root, 'a.txt')), before);
  assert.equal(await fs.readFile(join(root, 'b.txt'), 'utf8'), 'second');
  assert.deepEqual((await fs.readdir(root)).sort(), ['a.txt', 'b.txt']);
});
