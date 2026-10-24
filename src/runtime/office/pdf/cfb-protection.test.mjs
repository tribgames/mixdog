import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCfb, currentUserStream, encryptedOoxmlEntries } from './cfb-fixture.mjs';
import {
  isEncryptedBinaryPresentation,
  isEncryptedOoxml,
  readEncryptedOoxml,
  readOoxmlEncryptionInfo,
} from './cfb-protection.mjs';

const ENCRYPTED_TOKEN = 0xf3d1c4df;
const PLAIN_TOKEN = 0xe391c05f;

function written(t, name, bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'cfb-protection-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

// What an unencrypted legacy .doc holds: a CFB container with no encryption streams at all.
const legacyWordEntries = () => [
  { name: 'WordDocument', data: Buffer.alloc(9000, 1) },
  { name: '1Table', data: Buffer.alloc(5000, 2) },
  { name: '\u0001CompObj', data: Buffer.alloc(100, 3) },
  { name: '\u0005SummaryInformation', data: Buffer.alloc(300, 4) },
];

test('an encrypted OOXML container (EncryptionInfo + EncryptedPackage at the root) is protected', async (t) => {
  for (const version of [3, 4]) {
    const path = written(t, `secret-v${version}.docx`, buildCfb(encryptedOoxmlEntries(), { version }));
    assert.equal(await isEncryptedOoxml(path), true, `CFB version ${version}`);
  }
});

test('stream names match case-insensitively, as CFB compares them', async (t) => {
  const entries = [
    { name: 'ENCRYPTIONINFO', data: Buffer.alloc(40) },
    { name: 'encryptedpackage', data: Buffer.alloc(40) },
  ];
  assert.equal(await isEncryptedOoxml(written(t, 'shout.xlsx', buildCfb(entries))), true);
});

test('a plain CFB container renamed .docx is not protected', async (t) => {
  assert.equal(await isEncryptedOoxml(written(t, 'renamed-legacy.docx', buildCfb(legacyWordEntries()))), false);
});

test('both encryption streams are required, and only at the root', async (t) => {
  const [info, encryptedPackage] = encryptedOoxmlEntries();
  assert.equal(await isEncryptedOoxml(written(t, 'no-info.docx', buildCfb([encryptedPackage]))), false);
  assert.equal(await isEncryptedOoxml(written(t, 'no-package.docx', buildCfb([info]))), false);
  const nested = [{ name: 'Nested', children: [info, encryptedPackage] }, ...legacyWordEntries()];
  assert.equal(await isEncryptedOoxml(written(t, 'nested.docx', buildCfb(nested))), false);
});

test('a directory placed beyond the 109 header FAT entries is reached through the DIFAT chain', async (t) => {
  // 109 FAT sectors of 128 entries map 7,143,424 bytes of 512-byte sectors; the directory follows the data.
  const packageBytes = 7_700_000;
  const big = buildCfb(encryptedOoxmlEntries(packageBytes));
  assert.ok(big.readUInt32LE(72) >= 1, 'the fixture needs a DIFAT sector');
  assert.equal(await isEncryptedOoxml(written(t, 'big.xlsx', big)), true);
  const bigPlain = buildCfb([{ name: 'Workbook', data: Buffer.alloc(packageBytes) }]);
  assert.equal(await isEncryptedOoxml(written(t, 'big-plain.xlsx', bigPlain)), false);
});

test('a truncated container is not protected', async (t) => {
  const whole = buildCfb(encryptedOoxmlEntries());
  const directoryAt = (whole.readUInt32LE(48) + 1) * 512;
  for (const length of [0, 7, 100, 512, 1024, directoryAt, directoryAt + 60]) {
    const path = written(t, 'cut.docx', whole.subarray(0, length));
    assert.equal(await isEncryptedOoxml(path), false, `cut at ${length} bytes`);
  }
  assert.equal(await isEncryptedOoxml(join(tmpdir(), 'cfb-protection-missing.docx')), false);
});

test('a corrupt container is not protected', async (t) => {
  const corrupt = (name, change) => {
    const bytes = Buffer.from(buildCfb(encryptedOoxmlEntries()));
    change(bytes, (bytes.readUInt32LE(48) + 1) * 512);
    return written(t, name, bytes);
  };
  const cases = {
    'bad signature': (bytes) => {
      bytes[0] ^= 0xff;
    },
    'bad byte order': (bytes) => bytes.writeUInt16LE(0xfeff, 28),
    'sector size that does not match the version': (bytes) => bytes.writeUInt16LE(12, 30),
    'directory start is free': (bytes) => bytes.writeUInt32LE(0xffffffff, 48),
    'directory start past the file': (bytes) => bytes.writeUInt32LE(0x00ffffff, 48),
    'directory chain loops on itself': (bytes) => {
      const fatSector = bytes.readUInt32LE(76);
      const start = bytes.readUInt32LE(48);
      bytes.writeUInt32LE(start, (fatSector + 1) * 512 + start * 4);
    },
    'no root storage': (bytes, directoryAt) => {
      bytes[directoryAt + 66] = 0;
    },
    'sibling tree loops': (bytes, directoryAt) => bytes.writeUInt32LE(1, directoryAt + 2 * 128 + 72),
    'entry id past the directory': (bytes, directoryAt) => bytes.writeUInt32LE(900, directoryAt + 76),
    'entry name too long': (bytes, directoryAt) => bytes.writeUInt16LE(200, directoryAt + 128 + 64),
  };
  for (const [name, change] of Object.entries(cases)) {
    assert.equal(await isEncryptedOoxml(corrupt(`${name}.docx`, change)), false, name);
  }
});

test('a non-CFB file is not protected, whatever its extension or content', async (t) => {
  assert.equal(await isEncryptedOoxml(written(t, 'zip.docx', Buffer.from('PK\x03\x04 zip bytes'))), false);
  assert.equal(await isEncryptedBinaryPresentation(written(t, 'text.ppt', 'source bytes')), false);
});

test('an encrypted binary presentation is found by its Current User headerToken', async (t) => {
  // A summary stream ahead of it puts "Current User" at mini sector 16, in the third sector of the mini stream.
  const entries = (token) => [
    { name: '\u0005SummaryInformation', data: Buffer.alloc(1000) },
    currentUserStream(token),
    { name: 'PowerPoint Document', data: Buffer.alloc(6000, 7) },
  ];
  assert.equal(await isEncryptedBinaryPresentation(written(t, 'locked.ppt', buildCfb(entries(ENCRYPTED_TOKEN)))), true);
  assert.equal(await isEncryptedBinaryPresentation(written(t, 'open.ppt', buildCfb(entries(PLAIN_TOKEN)))), false);
  assert.equal(
    await isEncryptedBinaryPresentation(written(t, 'locked4.ppt', buildCfb(entries(ENCRYPTED_TOKEN), { version: 4 }))),
    true
  );
});

test('a Current User stream past the declared mini-stream size of the root entry is not read', async (t) => {
  const bytes = Buffer.from(buildCfb([currentUserStream(ENCRYPTED_TOKEN)]));
  // The root entry is the first directory entry; its stream size sits at byte 120.
  bytes.writeBigUInt64LE(0n, (bytes.readUInt32LE(48) + 1) * 512 + 120);
  assert.equal(await isEncryptedBinaryPresentation(written(t, 'sizeless.ppt', bytes)), false);
});

test('a Current User stream above the mini-stream cutoff is read from its regular sectors', async (t) => {
  const stream = currentUserStream(ENCRYPTED_TOKEN);
  stream.data = Buffer.concat([stream.data, Buffer.alloc(5000)]);
  assert.equal(await isEncryptedBinaryPresentation(written(t, 'padded.ppt', buildCfb([stream]))), true);
});

test('an EncryptedSummary stream marks an encrypted binary presentation', async (t) => {
  const entries = [currentUserStream(PLAIN_TOKEN), { name: 'EncryptedSummary', data: Buffer.alloc(200) }];
  assert.equal(await isEncryptedBinaryPresentation(written(t, 'summary.ppt', buildCfb(entries))), true);
});

// Offsets inside a container built by the fixture (its FAT sectors are all listed in the header).
const sectorSizeOf = (bytes) => 1 << bytes.readUInt16LE(30);
const sectorAt = (bytes, sector) => (sector + 1) * sectorSizeOf(bytes);
const fatEntryAt = (bytes, sector) => {
  const perSector = sectorSizeOf(bytes) / 4;
  return sectorAt(bytes, bytes.readUInt32LE(76 + Math.floor(sector / perSector) * 4)) + (sector % perSector) * 4;
};
const entryAt = (bytes, name) => {
  const directory = sectorAt(bytes, bytes.readUInt32LE(48));
  for (let at = directory; ; at += 128) {
    if (bytes.toString('utf16le', at, at + bytes.readUInt16LE(at + 64) - 2) === name) return at;
  }
};
const startOf = (bytes, name) => bytes.readUInt32LE(entryAt(bytes, name) + 116);

// Every case must settle quickly: a walk that trusted the file would loop or allocate without end.
const bounded = { timeout: 10_000 };

test('a cyclic mini-stream chain is refused, even under a root size far beyond the file', bounded, async (t) => {
  // "Current User" sits at mini sector 16, in the third sector of the mini stream: reading it follows the chain.
  const presentation = [{ name: '\u0005SummaryInformation', data: Buffer.alloc(1000) }, currentUserStream(0xf3d1c4df)];
  const looped = (entries, version, rootSize) => {
    const bytes = Buffer.from(buildCfb(entries, { version }));
    const root = startOf(bytes, 'Root Entry');
    bytes.writeUInt32LE(root, fatEntryAt(bytes, root));
    if (rootSize !== undefined) bytes.writeBigUInt64LE(rootSize, entryAt(bytes, 'Root Entry') + 120);
    return bytes;
  };
  assert.equal(await isEncryptedBinaryPresentation(written(t, 'loop.ppt', looped(presentation, 3))), false);
  for (const [version, rootSize] of [
    [3, 0xffffffc0n],
    [4, 1n << 40n],
  ]) {
    const presentationPath = written(t, `huge-${version}.ppt`, looped(presentation, version, rootSize));
    assert.equal(await isEncryptedBinaryPresentation(presentationPath), false, `version ${version}`);
    const ooxmlPath = written(t, `huge-${version}.docx`, looped(encryptedOoxmlEntries(), version, rootSize));
    assert.equal(await readOoxmlEncryptionInfo(ooxmlPath), null, `version ${version}`);
    assert.equal(await readEncryptedOoxml(ooxmlPath), null, `version ${version}`);
  }
});

test('a cyclic mini sector chain, or a mini FAT larger than the file, is refused', bounded, async (t) => {
  const entries = () => [
    { name: 'EncryptionInfo', data: Buffer.alloc(200, 1) },
    { name: 'EncryptedPackage', data: Buffer.alloc(5000, 2) },
  ];
  const intact = written(t, 'intact.docx', buildCfb(entries()));
  assert.deepEqual(await readOoxmlEncryptionInfo(intact), Buffer.alloc(200, 1));
  // EncryptionInfo holds mini sectors 0 to 3; sending the third back to the second closes a loop.
  const cyclic = Buffer.from(buildCfb(entries()));
  cyclic.writeUInt32LE(1, sectorAt(cyclic, cyclic.readUInt32LE(60)) + 2 * 4);
  assert.equal(await readOoxmlEncryptionInfo(written(t, 'mini-loop.docx', cyclic)), null);
  const oversized = Buffer.from(buildCfb(entries()));
  oversized.writeUInt32LE(0xffffffff, 64);
  assert.equal(await isEncryptedOoxml(written(t, 'mini-fat.docx', oversized)), false);
});

test('a cyclic stream chain, or one that leaves the file, is refused', bounded, async (t) => {
  const changed = (name, next) => {
    const bytes = Buffer.from(buildCfb(encryptedOoxmlEntries()));
    const start = startOf(bytes, 'EncryptedPackage');
    bytes.writeUInt32LE(next(start), fatEntryAt(bytes, start + 1));
    return written(t, name, bytes);
  };
  assert.notEqual(await readEncryptedOoxml(changed('intact.docx', (start) => start + 2)), null);
  assert.equal(await readEncryptedOoxml(changed('loop.docx', (start) => start)), null);
  assert.equal(await readEncryptedOoxml(changed('outside.docx', () => 0x00ffffff)), null);
});

test(
  'header counts beyond the file, or a mini-stream cutoff other than 4096, are not a container',
  bounded,
  async (t) => {
    const cases = {
      'FAT sectors': (bytes) => bytes.writeUInt32LE(0x7fffffff, 44),
      'DIFAT sectors': (bytes) => bytes.writeUInt32LE(0x7fffffff, 72),
      'mini FAT sectors': (bytes) => bytes.writeUInt32LE(0x7fffffff, 64),
      'mini-stream cutoff': (bytes) => bytes.writeUInt32LE(0xffffffff, 56),
    };
    for (const [name, change] of Object.entries(cases)) {
      const bytes = Buffer.from(buildCfb(encryptedOoxmlEntries()));
      change(bytes);
      assert.equal(await isEncryptedOoxml(written(t, `${name}.docx`, bytes)), false, name);
    }
  }
);

test('stray headerToken bytes elsewhere do not mark a binary presentation as encrypted', async (t) => {
  const atom = currentUserStream(ENCRYPTED_TOKEN).data;
  const strays = [
    // The atom inside another stream, with no root "Current User" stream.
    [{ name: 'PowerPoint Document', data: Buffer.concat([Buffer.alloc(64), atom, Buffer.alloc(64)]) }],
    // The atom under a sub-storage, not at the root.
    [
      { name: 'Nested', children: [{ name: 'Current User', data: atom }] },
      { name: 'Pictures', data: Buffer.alloc(100) },
    ],
    // A Current User stream too short to hold the atom's headerToken.
    [{ name: 'Current User', data: atom.subarray(0, 14) }],
  ];
  for (const [index, entries] of strays.entries()) {
    assert.equal(await isEncryptedBinaryPresentation(written(t, `stray-${index}.ppt`, buildCfb(entries))), false);
  }
  const token = Buffer.from([0xdf, 0xc4, 0xd1, 0xf3]);
  const rawBytes = written(t, 'raw.ppt', Buffer.concat([Buffer.alloc(64), token, Buffer.alloc(64)]));
  assert.equal(await isEncryptedBinaryPresentation(rawBytes), false);
});
