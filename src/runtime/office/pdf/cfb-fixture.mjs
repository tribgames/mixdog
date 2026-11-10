// A minimal Compound File Binary ([MS-CFB]) writer for tests: real container structure (header, FAT, DIFAT, mini
// FAT, mini stream, directory with sibling trees), laid out the way Office writes it.
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

const END_OF_CHAIN = 0xfffffffe;
const FAT_SECTOR = 0xfffffffd;
const DIFAT_SECTOR = 0xfffffffc;
const NO_STREAM = 0xffffffff;
const MINI_SECTOR_SIZE = 64;
const MINI_STREAM_CUTOFF = 4096;
const HEADER_DIFAT_ENTRIES = 109;

/**
 * Entries under the root storage: `{ name, data }` is a stream, `{ name, children }` a storage of further entries.
 * `version` is the CFB major version: 3 (512-byte sectors) or 4 (4096-byte sectors).
 */
export function buildCfb(entries, { version = 3 } = {}) {
  const sectorSize = version === 4 ? 4096 : 512;
  const entriesPerSector = sectorSize / 4;
  const root = { name: 'Root Entry', type: 5, children: entries };

  // Directory ids in storage order, root first; the siblings under each storage form one balanced tree.
  const nodes = [];
  const register = (node) => {
    node.id = nodes.length;
    nodes.push(node);
    for (const child of node.children ?? []) register(child);
  };
  register(root);
  const link = (siblings) => {
    const ordered = [...siblings].sort(
      (a, b) => a.name.length - b.name.length || (a.name.toUpperCase() < b.name.toUpperCase() ? -1 : 1)
    );
    const build = (low, high) => {
      if (low > high) return NO_STREAM;
      const middle = (low + high) >> 1;
      const node = ordered[middle];
      node.left = build(low, middle - 1);
      node.right = build(middle + 1, high);
      return node.id;
    };
    return build(0, ordered.length - 1);
  };
  for (const node of nodes) {
    node.left ??= NO_STREAM;
    node.right ??= NO_STREAM;
    node.type ??= node.children ? 1 : 2;
    if (node.children) node.child = link(node.children);
  }

  const sectors = [];
  const fat = [];
  const allocate = (bytes) => {
    const count = Math.ceil(bytes.length / sectorSize);
    const start = sectors.length;
    for (let i = 0; i < count; i++) {
      const sector = Buffer.alloc(sectorSize);
      bytes.copy(sector, 0, i * sectorSize, (i + 1) * sectorSize);
      sectors.push(sector);
      fat.push(i === count - 1 ? END_OF_CHAIN : sectors.length);
    }
    return count ? start : END_OF_CHAIN;
  };

  const miniStreams = [];
  const miniFat = [];
  for (const node of nodes) {
    if (node.type !== 2) continue;
    node.size = node.data.length;
    if (node.size >= MINI_STREAM_CUTOFF) {
      node.start = allocate(node.data);
    } else if (node.size === 0) {
      node.start = END_OF_CHAIN;
    } else {
      const count = Math.ceil(node.size / MINI_SECTOR_SIZE);
      node.start = miniFat.length;
      for (let i = 0; i < count; i++) miniFat.push(i === count - 1 ? END_OF_CHAIN : miniFat.length + 1);
      miniStreams.push(Buffer.concat([node.data, Buffer.alloc(count * MINI_SECTOR_SIZE - node.size)]));
    }
  }
  const miniStream = Buffer.concat(miniStreams);
  root.size = miniStream.length;
  root.start = allocate(miniStream);

  const miniFatBytes = Buffer.alloc(Math.ceil(miniFat.length / entriesPerSector) * entriesPerSector * 4, 0xff);
  miniFat.forEach((next, i) => {
    miniFatBytes.writeUInt32LE(next, i * 4);
  });
  const miniFatStart = allocate(miniFatBytes);

  const directoryBytes = Buffer.alloc(Math.ceil(nodes.length / (sectorSize / 128)) * sectorSize);
  directoryBytes.fill(0xff, 0, directoryBytes.length);
  nodes.forEach((node, i) => {
    const at = i * 128;
    directoryBytes.fill(0, at, at + 128);
    directoryBytes.write(node.name, at, 'utf16le');
    directoryBytes.writeUInt16LE((node.name.length + 1) * 2, at + 64);
    directoryBytes[at + 66] = node.type;
    directoryBytes[at + 67] = 1;
    directoryBytes.writeUInt32LE(node.left, at + 68);
    directoryBytes.writeUInt32LE(node.right, at + 72);
    directoryBytes.writeUInt32LE(node.child ?? NO_STREAM, at + 76);
    directoryBytes.writeUInt32LE(node.start ?? 0, at + 116);
    directoryBytes.writeUInt32LE(node.size ?? 0, at + 120);
  });
  // Entries past the last one are unallocated: type 0, with every id unset.
  for (let at = nodes.length * 128; at < directoryBytes.length; at += 128) directoryBytes.fill(0, at, at + 68);
  const directoryStart = allocate(directoryBytes);

  // The FAT describes every sector including its own and the DIFAT's, so their counts settle together.
  let fatCount = 0;
  let difatCount = 0;
  while (fatCount * entriesPerSector < fat.length + fatCount + difatCount) {
    fatCount++;
    difatCount =
      fatCount > HEADER_DIFAT_ENTRIES ? Math.ceil((fatCount - HEADER_DIFAT_ENTRIES) / (entriesPerSector - 1)) : 0;
  }
  const fatSectorIds = Array.from({ length: fatCount }, (_, i) => sectors.length + i);
  const difatSectorIds = Array.from({ length: difatCount }, (_, i) => sectors.length + fatCount + i);
  const fatEntries = [...fat, ...fatSectorIds.map(() => FAT_SECTOR), ...difatSectorIds.map(() => DIFAT_SECTOR)];
  const fatBytes = Buffer.alloc(fatCount * sectorSize, 0xff);
  fatEntries.forEach((next, i) => {
    fatBytes.writeUInt32LE(next, i * 4);
  });
  for (let i = 0; i < fatCount; i++) sectors.push(fatBytes.subarray(i * sectorSize, (i + 1) * sectorSize));
  const beyondHeader = fatSectorIds.slice(HEADER_DIFAT_ENTRIES);
  for (let i = 0; i < difatCount; i++) {
    const sector = Buffer.alloc(sectorSize, 0xff);
    beyondHeader.slice(i * (entriesPerSector - 1), (i + 1) * (entriesPerSector - 1)).forEach((id, j) => {
      sector.writeUInt32LE(id, j * 4);
    });
    sector.writeUInt32LE(i === difatCount - 1 ? END_OF_CHAIN : difatSectorIds[i + 1], sectorSize - 4);
    sectors.push(sector);
  }

  const header = Buffer.alloc(sectorSize);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x3e, 24);
  header.writeUInt16LE(version, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(version === 4 ? 12 : 9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(version === 4 ? directoryBytes.length / sectorSize : 0, 40);
  header.writeUInt32LE(fatCount, 44);
  header.writeUInt32LE(directoryStart, 48);
  header.writeUInt32LE(MINI_STREAM_CUTOFF, 56);
  header.writeUInt32LE(miniFatStart, 60);
  header.writeUInt32LE(miniFatBytes.length / sectorSize, 64);
  header.writeUInt32LE(difatCount ? difatSectorIds[0] : END_OF_CHAIN, 68);
  header.writeUInt32LE(difatCount, 72);
  header.fill(0xff, 76, 512);
  fatSectorIds.slice(0, HEADER_DIFAT_ENTRIES).forEach((id, i) => {
    header.writeUInt32LE(id, 76 + i * 4);
  });
  return Buffer.concat([header, ...sectors]);
}

/** The root-level streams of an encrypted OOXML document ([MS-OFFCRYPTO] 2.3.4), with the given ciphertext size. */
export function encryptedOoxmlEntries(packageBytes = 5000) {
  return [
    { name: 'EncryptionInfo', data: Buffer.from([4, 0, 4, 0, 0x40, 0, 0, 0, ...Buffer.from('<encryption/>')]) },
    { name: 'EncryptedPackage', data: Buffer.concat([Buffer.alloc(8), Buffer.alloc(packageBytes, 0x5a)]) },
    {
      name: '\u0006DataSpaces',
      children: [
        { name: 'Version', data: Buffer.alloc(76) },
        { name: 'DataSpaceMap', data: Buffer.alloc(112) },
      ],
    },
  ];
}

const sha = (algorithm, ...parts) => {
  const digest = createHash(algorithm);
  for (const part of parts) digest.update(part);
  return digest.digest();
};
const le32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value, 0);
  return bytes;
};
const padTo = (bytes, block) => Buffer.concat([bytes, Buffer.alloc((block - (bytes.length % block)) % block)]);
const aes = (mode, key, iv, data) => {
  const cipher = createCipheriv(`aes-${key.length * 8}-${mode}`, key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
};
const spun = (algorithm, salt, password, count) => {
  let value = sha(algorithm, salt, Buffer.from(password, 'utf16le'));
  for (let i = 0; i < count; i++) value = sha(algorithm, le32(i), value);
  return value;
};
const withSize = (plain, ciphertext) => {
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(plain.length), 0);
  return Buffer.concat([size, ciphertext]);
};

// 2.3.4.10 HashAlgorithm values the fixture writes, with their OpenSSL names.
const AGILE_HASHES = { 'SHA-1': 'sha1', SHA1: 'sha1', SHA256: 'sha256', SHA384: 'sha384', SHA512: 'sha512' };
// Truncated to, or padded with 0x36 up to, `length` bytes (2.3.4.11, 2.3.4.12).
const fitted = (bytes, length) =>
  bytes.length >= length
    ? bytes.subarray(0, length)
    : Buffer.concat([bytes, Buffer.alloc(length - bytes.length, 0x36)]);

/**
 * The root-level streams of `plain` encrypted with `password` the way Office writes it, following [MS-OFFCRYPTO]
 * in the encrypting direction: agile encryption (2.3.4.10–2.3.4.15, AES-256-CBC, SHA-512 or `hashAlgorithm`) by
 * default, or standard encryption (2.3.4.5–2.3.4.9, AES-128-ECB, SHA-1). `spinCount` is lowered for agile tests to
 * keep them fast. The keyData salt is `keySaltSize` bytes. Agile encryption carries dataIntegrity (2.3.4.14) unless
 * `integrity` is false, its HMAC key a salt of `hmacSaltSize` bytes: hashSize, as Excel writes it, unless given.
 */
export function encryptOoxmlEntries(
  plain,
  password,
  {
    scheme = 'agile',
    spinCount = 1000,
    hashAlgorithm = 'SHA512',
    keySaltSize = 16,
    integrity = true,
    hmacSaltSize,
  } = {}
) {
  let encryptionInfo;
  let encryptedPackage;
  if (scheme === 'agile') {
    const algorithm = AGILE_HASHES[hashAlgorithm];
    const hashSize = sha(algorithm).length;
    const secret = randomBytes(32);
    const keySalt = randomBytes(keySaltSize);
    const passwordSalt = randomBytes(16);
    const hashed = spun(algorithm, passwordSalt, password, spinCount);
    const keyFor = (block) => fitted(sha(algorithm, hashed, Buffer.from(block)), 32);
    const verifierInput = randomBytes(16);
    const encrypted = (block, data) => aes('cbc', keyFor(block), passwordSalt, padTo(data, 16)).toString('base64');
    const segments = [];
    for (let offset = 0, index = 0; offset < plain.length; offset += 4096, index++) {
      const iv = fitted(sha(algorithm, keySalt, le32(index)), 16);
      segments.push(aes('cbc', secret, iv, padTo(plain.subarray(offset, offset + 4096), 16)));
    }
    encryptedPackage = withSize(plain, Buffer.concat(segments));
    // 2.3.4.14: an HMAC of the whole stream keyed by a random salt, both encrypted with the package key.
    const sealed = (block, data) =>
      aes('cbc', secret, fitted(sha(algorithm, keySalt, Buffer.from(block)), 16), padTo(data, 16)).toString('base64');
    const hmacSalt = randomBytes(hmacSaltSize ?? hashSize);
    const hmac = createHmac(algorithm, hmacSalt).update(encryptedPackage).digest();
    const dataIntegrity = integrity
      ? `<dataIntegrity encryptedHmacKey="${sealed([0x5f, 0xb2, 0xad, 0x01, 0x0c, 0xb9, 0xe1, 0xf6], hmacSalt)}"` +
        ` encryptedHmacValue="${sealed([0xa0, 0x67, 0x7f, 0x02, 0xb2, 0x2c, 0x84, 0x33], hmac)}"/>`
      : '';
    const cipher = `blockSize="16" keyBits="256" hashSize="${hashSize}" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="${hashAlgorithm}"`;
    const xml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
      `<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption" xmlns:p="http://schemas.microsoft.com/office/2006/keyEncryptor/password">` +
      `<keyData saltSize="${keySaltSize}" ${cipher} saltValue="${keySalt.toString('base64')}"/>` +
      dataIntegrity +
      `<keyEncryptors><keyEncryptor uri="http://schemas.microsoft.com/office/2006/keyEncryptor/password">` +
      `<p:encryptedKey spinCount="${spinCount}" saltSize="16" ${cipher} saltValue="${passwordSalt.toString('base64')}"` +
      ` encryptedVerifierHashInput="${encrypted([0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79], verifierInput)}"` +
      ` encryptedVerifierHashValue="${encrypted([0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e], sha(algorithm, verifierInput))}"` +
      ` encryptedKeyValue="${encrypted([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6], secret)}"/>` +
      `</keyEncryptor></keyEncryptors></encryption>`;
    encryptionInfo = Buffer.concat([Buffer.from([4, 0, 4, 0, 0x40, 0, 0, 0]), Buffer.from(xml, 'utf8')]);
  } else {
    const salt = randomBytes(16);
    const final = sha('sha1', spun('sha1', salt, password, 50_000), le32(0));
    const derive = (fill) => {
      const buffer = Buffer.alloc(64, fill);
      for (let i = 0; i < final.length; i++) buffer[i] ^= final[i];
      return sha('sha1', buffer);
    };
    const key = Buffer.concat([derive(0x36), derive(0x5c)]).subarray(0, 16);
    const verifier = randomBytes(16);
    const csp = Buffer.from('Microsoft Enhanced RSA and AES Cryptographic Provider\0', 'utf16le');
    const header = Buffer.concat([...[0x24, 0, 0x660e, 0x8004, 128, 0x18, 0, 0].map(le32), csp]);
    encryptionInfo = Buffer.concat([
      Buffer.from([3, 0, 2, 0]),
      le32(0x24),
      le32(header.length),
      header,
      le32(16),
      salt,
      aes('ecb', key, null, verifier),
      le32(20),
      aes('ecb', key, null, padTo(sha('sha1', verifier), 16)),
    ]);
    encryptedPackage = withSize(plain, aes('ecb', key, null, padTo(plain, 16)));
  }
  return [
    { name: 'EncryptionInfo', data: encryptionInfo },
    { name: 'EncryptedPackage', data: encryptedPackage },
    {
      name: '\u0006DataSpaces',
      children: [
        { name: 'Version', data: Buffer.alloc(76) },
        { name: 'DataSpaceMap', data: Buffer.alloc(112) },
      ],
    },
  ];
}

/** A binary Word document's "WordDocument" stream whose FibBase ([MS-DOC] 2.5.1) has fEncrypted set or clear. */
export function wordDocumentStream(encrypted) {
  const data = Buffer.alloc(6000, 3);
  data.writeUInt16LE(0xa5ec, 0);
  data.writeUInt16LE(0x00c1, 2);
  data.writeUInt16LE(encrypted ? 0x0100 | 0x0200 : 0x0200, 10);
  return { name: 'WordDocument', data };
}

/** A "Current User" stream holding a CurrentUserAtom ([MS-PPT] 2.3.2) with this headerToken. */
export function currentUserStream(headerToken, userName = 'Mixdog') {
  const name = Buffer.from(userName, 'latin1');
  const atom = Buffer.alloc(28 + name.length + 4);
  atom.writeUInt16LE(0x0ff6, 2);
  atom.writeUInt32LE(atom.length - 8, 4);
  atom.writeUInt32LE(0x14, 8);
  atom.writeUInt32LE(headerToken, 12);
  atom.writeUInt16LE(name.length, 20);
  atom.writeUInt16LE(0x03f4, 22);
  atom[24] = 3;
  name.copy(atom, 28);
  atom.writeUInt32LE(8, 28 + name.length);
  return { name: 'Current User', data: atom };
}
