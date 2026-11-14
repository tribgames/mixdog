#!/usr/bin/env node
// What Node's password-protected Office code answers (src/runtime/office/pdf/cfb-protection.mjs, ooxml-crypto.mjs and
// cfb-fixture.mjs, the container writer of its tests), for the Rust crate mixdog-office-crypto
// (crates/mixdog-office-crypto/tests/twin_crypto.rs replays it):
//   containers  compound files the fixture writer builds (and corrupted in every way the reader must refuse), with the
//               four probes' verdicts and the two stream readers' answers;
//   packages    encrypted OOXML packages made with Node crypto for every hash name and scheme the fixture writer
//               supports, with the descriptor Node reads, the key it derives for the right password, the HMAC verdict,
//               the decrypted bytes (or the error text) and the answer for a wrong password;
//   descriptors one descriptor rewritten many ways, with what Node reads from each (null when it refuses);
//   hashes      createHash / createHmac answers per algorithm name (the digest, or the error text Node throws).
//
//   node benchmarks/rust-core/recorders/record-office-crypto.mjs --tree <product tree with node_modules>
//
// Output: native/core/fixtures/office-crypto/golden.json (and its MANIFEST.json). The product tree is only read; the
// containers are written under the staging directory and removed again.
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'office-crypto');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-office-crypto.mjs';
const work = join(stage, '.work');
mkdirSync(work, { recursive: true });

const fixture = await importFrom(tree, 'src/runtime/office/pdf/cfb-fixture.mjs');
const protection = await importFrom(tree, 'src/runtime/office/pdf/cfb-protection.mjs');
const crypto = await importFrom(tree, 'src/runtime/office/pdf/ooxml-crypto.mjs');
const { buildCfb, currentUserStream, encryptedOoxmlEntries, encryptOoxmlEntries, wordDocumentStream } = fixture;

const b64 = (bytes) => (bytes === null ? null : Buffer.from(bytes).toString('base64'));
const PASSWORD = 'Korée päss \u{1F511}';
const ENCRYPTED_TOKEN = 0xf3d1c4df;
const PLAIN_TOKEN = 0xe391c05f;

// ---- containers -------------------------------------------------------------------------------------------------
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

const containers = [];
const add = (name, bytes) => containers.push({ name, bytes: Buffer.from(bytes) });
const mutated = (entries, version, change) => {
  const bytes = Buffer.from(buildCfb(entries, { version }));
  change(bytes, (bytes.readUInt32LE(48) + 1) * 512);
  return bytes;
};

const legacyWord = () => [
  { name: 'WordDocument', data: Buffer.alloc(9000, 1) },
  { name: '1Table', data: Buffer.alloc(5000, 2) },
  { name: '\u0001CompObj', data: Buffer.alloc(100, 3) },
  { name: '\u0005SummaryInformation', data: Buffer.alloc(300, 4) },
];
const presentation = (token) => [
  { name: '\u0005SummaryInformation', data: Buffer.alloc(1000) },
  currentUserStream(token),
  { name: 'PowerPoint Document', data: Buffer.alloc(6000, 7) },
];
const twoStreams = () => [
  { name: 'EncryptionInfo', data: Buffer.alloc(200, 1) },
  { name: 'EncryptedPackage', data: Buffer.alloc(5000, 2) },
];

for (const version of [3, 4]) {
  add(`ooxml-v${version}`, buildCfb(encryptedOoxmlEntries(), { version }));
  add(`presentation-locked-v${version}`, buildCfb(presentation(ENCRYPTED_TOKEN), { version }));
  add(`word-encrypted-v${version}`, buildCfb([wordDocumentStream(true), { name: '1Table', data: Buffer.alloc(5000, 2) }], { version }));
}
add('presentation-open', buildCfb(presentation(PLAIN_TOKEN)));
add('word-plain', buildCfb([wordDocumentStream(false), { name: '1Table', data: Buffer.alloc(5000, 2) }]));
add('upper-case-names', buildCfb([{ name: 'ENCRYPTIONINFO', data: Buffer.alloc(40) }, { name: 'encryptedpackage', data: Buffer.alloc(40) }]));
add('legacy-word', buildCfb(legacyWord()));
const [info, encryptedPackage] = encryptedOoxmlEntries();
add('info-only', buildCfb([info]));
add('package-only', buildCfb([encryptedPackage]));
add('nested', buildCfb([{ name: 'Nested', children: [info, encryptedPackage] }, ...legacyWord()]));
add('encrypted-summary', buildCfb([currentUserStream(PLAIN_TOKEN), { name: 'EncryptedSummary', data: Buffer.alloc(200) }]));
const above = currentUserStream(ENCRYPTED_TOKEN);
above.data = Buffer.concat([above.data, Buffer.alloc(5000)]);
add('current-user-above-cutoff', buildCfb([above]));
add('two-streams', buildCfb(twoStreams()));
const atom = currentUserStream(ENCRYPTED_TOKEN).data;
add('stray-in-other-stream', buildCfb([{ name: 'PowerPoint Document', data: Buffer.concat([Buffer.alloc(64), atom, Buffer.alloc(64)]) }]));
add('stray-under-storage', buildCfb([{ name: 'Nested', children: [{ name: 'Current User', data: atom }] }, { name: 'Pictures', data: Buffer.alloc(100) }]));
add('stray-short-current-user', buildCfb([{ name: 'Current User', data: atom.subarray(0, 14) }]));
add('raw-token-bytes', Buffer.concat([Buffer.alloc(64), Buffer.from([0xdf, 0xc4, 0xd1, 0xf3]), Buffer.alloc(64)]));
add('zip-bytes', Buffer.from('PK\x03\x04 zip bytes'));
add('text-bytes', Buffer.from('source bytes'));

const whole = buildCfb(encryptedOoxmlEntries());
const directoryAt = (whole.readUInt32LE(48) + 1) * 512;
for (const length of [0, 7, 100, 512, 1024, directoryAt, directoryAt + 60]) add(`cut-at-${length}`, whole.subarray(0, length));

const corrupt = {
  'bad-signature': (bytes) => { bytes[0] ^= 0xff; },
  'bad-byte-order': (bytes) => bytes.writeUInt16LE(0xfeff, 28),
  'sector-size-mismatch': (bytes) => bytes.writeUInt16LE(12, 30),
  'directory-start-free': (bytes) => bytes.writeUInt32LE(0xffffffff, 48),
  'directory-start-past-file': (bytes) => bytes.writeUInt32LE(0x00ffffff, 48),
  'directory-chain-loop': (bytes) => {
    const fatSector = bytes.readUInt32LE(76);
    const start = bytes.readUInt32LE(48);
    bytes.writeUInt32LE(start, (fatSector + 1) * 512 + start * 4);
  },
  'no-root-storage': (bytes, at) => { bytes[at + 66] = 0; },
  'sibling-tree-loop': (bytes, at) => bytes.writeUInt32LE(1, at + 2 * 128 + 72),
  'entry-id-past-directory': (bytes, at) => bytes.writeUInt32LE(900, at + 76),
  'entry-name-too-long': (bytes, at) => bytes.writeUInt16LE(200, at + 128 + 64),
  'fat-count-beyond-file': (bytes) => bytes.writeUInt32LE(0x7fffffff, 44),
  'difat-count-beyond-file': (bytes) => bytes.writeUInt32LE(0x7fffffff, 72),
  'mini-fat-count-beyond-file': (bytes) => bytes.writeUInt32LE(0x7fffffff, 64),
  'mini-cutoff-not-4096': (bytes) => bytes.writeUInt32LE(0xffffffff, 56),
};
for (const [name, change] of Object.entries(corrupt)) add(`corrupt-${name}`, mutated(encryptedOoxmlEntries(), 3, change));

const presentationDeck = () => [{ name: '\u0005SummaryInformation', data: Buffer.alloc(1000) }, currentUserStream(ENCRYPTED_TOKEN)];
const looped = (entries, version, rootSize) => {
  const bytes = Buffer.from(buildCfb(entries, { version }));
  const root = startOf(bytes, 'Root Entry');
  bytes.writeUInt32LE(root, fatEntryAt(bytes, root));
  if (rootSize !== undefined) bytes.writeBigUInt64LE(rootSize, entryAt(bytes, 'Root Entry') + 120);
  return bytes;
};
add('mini-stream-loop', looped(presentationDeck(), 3));
add('mini-stream-huge-root-v3', looped(presentationDeck(), 3, 0xffffffc0n));
add('mini-stream-huge-root-v4', looped(presentationDeck(), 4, 1n << 40n));
add('ooxml-huge-root-v3', looped(encryptedOoxmlEntries(), 3, 0xffffffc0n));
add('ooxml-huge-root-v4', looped(encryptedOoxmlEntries(), 4, 1n << 40n));
const sizeless = Buffer.from(buildCfb([currentUserStream(ENCRYPTED_TOKEN)]));
sizeless.writeBigUInt64LE(0n, (sizeless.readUInt32LE(48) + 1) * 512 + 120);
add('current-user-sizeless-root', sizeless);
const miniLoop = Buffer.from(buildCfb(twoStreams()));
miniLoop.writeUInt32LE(1, sectorAt(miniLoop, miniLoop.readUInt32LE(60)) + 2 * 4);
add('mini-sector-loop', miniLoop);
const miniFatBig = Buffer.from(buildCfb(twoStreams()));
miniFatBig.writeUInt32LE(0xffffffff, 64);
add('mini-fat-count-huge', miniFatBig);
const streamChain = (next) => {
  const bytes = Buffer.from(buildCfb(encryptedOoxmlEntries()));
  const start = startOf(bytes, 'EncryptedPackage');
  bytes.writeUInt32LE(next(start), fatEntryAt(bytes, start + 1));
  return bytes;
};
add('stream-chain-intact', streamChain((start) => start + 2));
add('stream-chain-loop', streamChain((start) => start));
add('stream-chain-outside', streamChain(() => 0x00ffffff));

const containerRecords = [];
for (const { name, bytes } of containers) {
  const path = join(work, `${containerRecords.length}.bin`);
  writeFileSync(path, bytes);
  const read = await protection.readEncryptedOoxml(path);
  containerRecords.push({
    name,
    bytes: b64(bytes),
    isEncryptedOoxml: await protection.isEncryptedOoxml(path),
    isEncryptedWordDocument: await protection.isEncryptedWordDocument(path),
    isEncryptedBinaryPresentation: await protection.isEncryptedBinaryPresentation(path),
    encryptionInfo: b64(await protection.readOoxmlEncryptionInfo(path)),
    encryptedOoxml: read ? { encryptionInfo: b64(read.encryptionInfo), encryptedPackage: b64(read.encryptedPackage) } : null,
  });
}
const missing = join(work, 'missing.bin');
const missingRecord = {
  isEncryptedOoxml: await protection.isEncryptedOoxml(missing),
  isEncryptedWordDocument: await protection.isEncryptedWordDocument(missing),
  isEncryptedBinaryPresentation: await protection.isEncryptedBinaryPresentation(missing),
  encryptionInfo: await protection.readOoxmlEncryptionInfo(missing),
  encryptedOoxml: await protection.readEncryptedOoxml(missing),
};

// ---- packages -------------------------------------------------------------------------------------------------
const summarize = (descriptor) => {
  if (descriptor === null) return null;
  if (descriptor.type === 'standard') {
    return {
      type: 'standard',
      keyBits: descriptor.keyBits,
      salt: b64(descriptor.salt),
      verifier: b64(descriptor.verifier),
      verifierHash: b64(descriptor.verifierHash),
      verifierHashSize: descriptor.verifierHashSize,
    };
  }
  const cipher = ({ keyBits, blockSize, saltSize, hashSize, algorithm, salt }) => ({ keyBits, blockSize, saltSize, hashSize, algorithm, salt: b64(salt) });
  let integrity = 'none';
  if (descriptor.integrity?.malformed) integrity = 'malformed';
  else if (descriptor.integrity) {
    integrity = { hmacKey: b64(descriptor.integrity.hmacKey), hmacValue: b64(descriptor.integrity.hmacValue), saltLength: descriptor.integrity.saltLength };
  }
  return {
    type: 'agile',
    data: cipher(descriptor.data),
    key: cipher(descriptor.key),
    spinCount: descriptor.spinCount,
    verifierInput: b64(descriptor.verifierInput),
    verifierHash: b64(descriptor.verifierHash),
    encryptedKey: b64(descriptor.encryptedKey),
    integrity,
  };
};

async function packageRecord(name, entries, plain) {
  const [infoEntry, packageEntry] = entries;
  const encryptionInfo = infoEntry.data;
  const encryptedPackageBytes = packageEntry.data;
  const descriptor = crypto.ooxmlEncryption(encryptionInfo);
  const record = {
    name,
    plainSha256: plain ? createHash('sha256').update(plain).digest('hex') : null,
    plainLength: plain ? plain.length : null,
    encryptionInfo: b64(encryptionInfo),
    encryptedPackage: b64(encryptedPackageBytes),
    descriptor: summarize(descriptor),
  };
  if (!descriptor) return record;
  const key = await crypto.ooxmlPasswordKey(descriptor, PASSWORD);
  record.key = b64(key);
  record.wrongPasswordKey = b64(await crypto.ooxmlPasswordKey(descriptor, `${PASSWORD}x`));
  record.emptyPasswordKey = b64(await crypto.ooxmlPasswordKey(descriptor, ''));
  if (key) {
    record.intact = crypto.ooxmlPackageIntact(descriptor, key, encryptedPackageBytes);
    try {
      record.decrypted = b64(crypto.decryptOoxmlPackage(descriptor, key, encryptedPackageBytes));
    } catch (error) {
      record.decryptError = error.message;
    }
  }
  return record;
}

const packages = [];
const plainOf = (length) => Buffer.alloc(length, 0x41).map((_, index) => (index * 7 + 3) & 0xff);
const make = async (name, length, options = {}) => {
  const plain = plainOf(length);
  const entries = encryptOoxmlEntries(plain, PASSWORD, options);
  packages.push(await packageRecord(name, entries, plain));
  return { plain, entries };
};
for (const hashAlgorithm of ['SHA-1', 'SHA1', 'SHA256', 'SHA384', 'SHA512']) {
  await make(`agile-${hashAlgorithm}`, 5000, { hashAlgorithm });
  await make(`agile-${hashAlgorithm}-no-integrity`, 5000, { hashAlgorithm, integrity: false });
}
for (const [hashAlgorithm, keySaltSize, hmacSaltSize] of [['SHA512', 16, 16], ['SHA512', 16, 64], ['SHA512', 64, 64], ['SHA512', 129, 129], ['SHA-1', 16, 16], ['SHA-1', 16, 20], ['SHA-1', 64, 64], ['SHA-1', 129, 129]]) {
  await make(`salts-${hashAlgorithm}-${keySaltSize}-${hmacSaltSize}`, 5000, { hashAlgorithm, keySaltSize, hmacSaltSize });
}
for (const length of [0, 1, 15, 16, 17, 4095, 4096, 4097, 8192, 8193]) {
  await make(`agile-size-${length}`, length);
  await make(`standard-size-${length}`, length, { scheme: 'standard' });
}
const base = await make('agile-base', 5000);
const flipped = Buffer.from(base.entries[1].data);
flipped[100] ^= 1;
packages.push(await packageRecord('agile-flipped-byte', [base.entries[0], { ...base.entries[1], data: flipped }, base.entries[2]], base.plain));
const resized = Buffer.from(base.entries[1].data);
resized.writeBigUInt64LE(BigInt(base.plain.length - 1), 0);
packages.push(await packageRecord('agile-stream-size-changed', [base.entries[0], { ...base.entries[1], data: resized }, base.entries[2]], base.plain));
const standardBase = await make('standard-base', 5000, { scheme: 'standard' });
for (const [label, data] of [
  ['truncated-to-7-bytes', standardBase.entries[1].data.subarray(0, 7)],
  ['size-beyond-body', Buffer.concat([Buffer.from(standardBase.entries[1].data.subarray(0, 8)).fill(0xff, 4, 8), standardBase.entries[1].data.subarray(8)])],
]) {
  packages.push(await packageRecord(`standard-${label}`, [standardBase.entries[0], { ...standardBase.entries[1], data }, standardBase.entries[2]], null));
}

// ---- descriptors -------------------------------------------------------------------------------------------------
const AGILE_HEADER = Buffer.from([4, 0, 4, 0, 0x40, 0, 0, 0]);
const withXml = (xml) => Buffer.concat([AGILE_HEADER, Buffer.from(xml, 'utf8')]);
const agileInfo = base.entries[0].data;
const xml = agileInfo.subarray(8).toString('utf8');
const ENCRYPTION_NS = 'http://schemas.microsoft.com/office/2006/encryption';
const PASSWORD_NS = 'http://schemas.microsoft.com/office/2006/keyEncryptor/password';
const certificate =
  '<keyEncryptor uri="http://schemas.microsoft.com/office/2006/keyEncryptor/certificate">' +
  '<c:encryptedKey xmlns:c="http://schemas.microsoft.com/office/2006/keyEncryptor/certificate" encryptedKeyValue="" X509Certificate="" certVerifier=""/>' +
  '</keyEncryptor>';
const variants = {
  intact: xml,
  prefixed: xml
    .replace(`xmlns="${ENCRYPTION_NS}"`, `xmlns:e="${ENCRYPTION_NS}"`)
    .replace(/<(\/?)(encryption|keyData|dataIntegrity|keyEncryptors|keyEncryptor)\b/g, '<$1e:$2'),
  comment: xml.replace('<keyData', '<!-- <keyData saltSize="1"/> --><keyData'),
  certificate: xml.replace('<keyEncryptors>', `<keyEncryptors>${certificate}`),
  'token with spaces': xml.replace(`uri="${PASSWORD_NS}"`, `uri="  ${PASSWORD_NS} "`),
  'a DTD': xml.replace('?>', '?><!DOCTYPE encryption [<!ENTITY x "SHA512">]>'),
  'an external entity': xml.replace('?>', `?><!DOCTYPE encryption SYSTEM "file:///etc/passwd">`),
  'an undefined entity': xml.replace('hashAlgorithm="SHA512"', 'hashAlgorithm="&x;"'),
  'another encoding': xml.replace('encoding="UTF-8"', 'encoding="UTF-16"'),
  'password key outside its namespace': xml.replace(/<p:encryptedKey\b/, '<encryptedKey'),
  'keyData in no namespace': xml.replace('<keyData', `<keyData xmlns=""`),
  'dataIntegrity after keyEncryptors': xml
    .replace(/<dataIntegrity[^>]*\/>/, '')
    .replace('</encryption>', `${xml.match(/<dataIntegrity[^>]*\/>/)[0]}</encryption>`),
  'two keyData elements': xml.replace(/(<keyData[^>]*\/>)/, '$1$1'),
  'an element the schema does not have': xml.replace('<keyEncryptors>', '<extra/><keyEncryptors>'),
  'a child inside keyData': xml.replace(/<keyData([^>]*)\/>/, '<keyData$1><x/></keyData>'),
  'two password key encryptors': xml.replace(/(<keyEncryptor\b.*<\/keyEncryptor>)/, '$1$1'),
  'no password key encryptor': xml.replace(`uri="${PASSWORD_NS}"`, 'uri="urn:other"'),
  'spinCount over the maximum': xml.replace('spinCount="1000"', 'spinCount="10000001"'),
  'spinCount at the maximum': xml.replace('spinCount="1000"', 'spinCount="10000000"'),
  'an empty spinCount': xml.replace('spinCount="1000"', 'spinCount=""'),
  'a plus sign in spinCount': xml.replace('spinCount="1000"', 'spinCount="+1000"'),
  'a salt that is not base64': xml.replace(/(<keyData[^>]*saltValue=")[^"]*/, '$1***'),
  'malformed XML': xml.replace('</keyEncryptors>', ''),
  'text outside the root': `${xml}stray`,
  'an unbound prefix': xml.replace('<keyData', '<q:keyData'),
  'an empty HMAC key': xml.replace(/encryptedHmacKey="[^"]*"/, 'encryptedHmacKey=""'),
  'an HMAC key of neither length': xml.replace(/encryptedHmacKey="[^"]*"/, `encryptedHmacKey="${Buffer.alloc(32).toString('base64')}"`),
  'an HMAC value that is not base64': xml.replace(/encryptedHmacValue="[^"]*"/, 'encryptedHmacValue="%%%%"'),
  'an HMAC value of the wrong length': xml.replace(/encryptedHmacValue="[^"]*"/, `encryptedHmacValue="${Buffer.alloc(16).toString('base64')}"`),
  'no HMAC value': xml.replace(/ encryptedHmacValue="[^"]*"/, ''),
  'a lower-case hash name': xml.replaceAll('SHA512', 'sha512'),
  'a hyphenated hash name': xml.replaceAll('SHA512', 'SHA-512'),
};
for (const name of ['SHA-1', 'SHA1', 'SHA256', 'SHA384', 'MD5', 'MD4', 'MD2', 'RIPEMD-128', 'RIPEMD-160', 'WHIRLPOOL']) {
  variants[`hash name ${name}`] = xml.replaceAll('SHA512', name);
}
const descriptorRecords = Object.entries(variants).map(([name, text]) => ({
  name,
  encryptionInfo: b64(withXml(text)),
  descriptor: summarize(crypto.ooxmlEncryption(withXml(text))),
}));
const rawInfos = {
  'extensible 4.3': Buffer.from([4, 0, 3, 0, 0, 0, 0, 0, 1, 2, 3, 4]),
  'agile with an empty descriptor': Buffer.from([4, 0, 4, 0, 0x40, 0, 0, 0, ...Buffer.from('<encryption/>')]),
  'agile with another reserved word': Buffer.concat([Buffer.from([4, 0, 4, 0, 0x41, 0, 0, 0]), Buffer.from(xml)]),
  'too short': Buffer.from([4, 0, 4]),
  'invalid UTF-8': Buffer.concat([agileInfo, Buffer.from([0xff])]),
  'a byte order mark': Buffer.concat([AGILE_HEADER, Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml)]),
  'standard 3.2': standardBase.entries[0].data,
  'standard 2.2': Buffer.concat([Buffer.from([2, 0, 2, 0]), standardBase.entries[0].data.subarray(4)]),
  'standard 5.2': Buffer.concat([Buffer.from([5, 0, 2, 0]), standardBase.entries[0].data.subarray(4)]),
  'standard header size 31': (() => { const bytes = Buffer.from(standardBase.entries[0].data); bytes.writeUInt32LE(31, 8); return bytes; })(),
  'standard without fAES': (() => { const bytes = Buffer.from(standardBase.entries[0].data); bytes.writeUInt32LE(0x04, 12); return bytes; })(),
  'standard with RC4': (() => { const bytes = Buffer.from(standardBase.entries[0].data); bytes.writeUInt32LE(0x6801, 20); return bytes; })(),
  'standard with another hash': (() => { const bytes = Buffer.from(standardBase.entries[0].data); bytes.writeUInt32LE(0x800c, 24); return bytes; })(),
  'standard with 192-bit key bits mismatch': (() => { const bytes = Buffer.from(standardBase.entries[0].data); bytes.writeUInt32LE(0x660f, 20); return bytes; })(),
};
for (const [name, bytes] of Object.entries(rawInfos)) {
  descriptorRecords.push({ name, encryptionInfo: b64(bytes), descriptor: summarize(crypto.ooxmlEncryption(bytes)) });
}

// ---- hashes -------------------------------------------------------------------------------------------------
const hashInputs = [Buffer.alloc(0), Buffer.from('abc'), Buffer.from(Array.from({ length: 200 }, (_, index) => (index * 31 + 5) & 0xff))];
const hashNames = ['sha1', 'sha256', 'sha384', 'sha512', 'md5', 'ripemd160', 'md4', 'md2', 'ripemd128', 'whirlpool'];
const attempt = (action) => {
  try {
    return { ok: b64(action()) };
  } catch (error) {
    return { error: error.message };
  }
};
const hashes = hashNames.map((name) => ({
  name,
  digests: hashInputs.map((input) => attempt(() => createHash(name).update(input).digest())),
  hmacs: [0, 5, 64, 65, 128, 129].map((keyLength) => ({
    keyLength,
    result: attempt(() => createHmac(name, Buffer.from(Array.from({ length: keyLength }, (_, index) => (index * 13 + 1) & 0xff))).update(hashInputs[2]).digest()),
  })),
}));

writeJson(join(stage, 'golden.json'), {
  password: PASSWORD,
  hashInputs: hashInputs.map(b64),
  containers: containerRecords,
  missingFile: missingRecord,
  packages,
  descriptors: descriptorRecords,
  hashes,
});
rmSync(work, { recursive: true, force: true });
writeSetManifest(stage, { set: 'office-crypto', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
