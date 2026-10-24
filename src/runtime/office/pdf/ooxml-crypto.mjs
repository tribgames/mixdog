// Opening an encrypted Office Open XML package with its password, exactly as [MS-OFFCRYPTO] 2.3.4 specifies it.
//
// The \EncryptionInfo stream says how the package was encrypted and carries a password verifier: agile encryption
// (2.3.4.10) with an XML descriptor, or standard encryption (2.3.4.5) with a binary header. The verifier decides
// whether a password is right before anything else happens (2.3.4.9, 2.3.4.13); for agile encryption the
// descriptor's HMAC then has to prove \EncryptedPackage intact (2.3.4.14), and only then does the key decrypt it
// back into the plain package (2.3.4.15). Anything outside those two schemes (extensible encryption, a cipher or
// chaining mode the spec allows but Office does not write) is "unsupported", never a guess. The password hashing
// (up to 10,000,000 rounds) runs on a worker thread that a cancelled request ends.
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { SaxesParser } from 'saxes';
import { workerExecArgv } from '../../shared/worker-exec-argv.mjs';

// The agile descriptor is XML, read with saxes (the namespace-aware parser jsdom also parses XML with). saxes
// resolves no external entity and knows only the predefined ones; a DTD is refused outright (descriptorFields).

const ENCRYPTION_NAMESPACE = 'http://schemas.microsoft.com/office/2006/encryption';
const PASSWORD_KEY_ENCRYPTOR = 'http://schemas.microsoft.com/office/2006/keyEncryptor/password';
// 2.3.4.13: the block keys of the verifier input, the verifier hash and the encrypted key.
const VERIFIER_INPUT_BLOCK = Buffer.from([0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79]);
const VERIFIER_HASH_BLOCK = Buffer.from([0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e]);
const ENCRYPTED_KEY_BLOCK = Buffer.from([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]);
// 2.3.4.14: the block keys of the HMAC key and the HMAC value.
const INTEGRITY_KEY_BLOCK = Buffer.from([0x5f, 0xb2, 0xad, 0x01, 0x0c, 0xb9, 0xe1, 0xf6]);
const INTEGRITY_VALUE_BLOCK = Buffer.from([0xa0, 0x67, 0x7f, 0x02, 0xb2, 0x2c, 0x84, 0x33]);
// 2.3.4.10: spinCount MUST NOT exceed 10,000,000.
const MAX_SPIN_COUNT = 10_000_000;
// 2.3.4.7: standard encryption hashes the password 50,000 times.
const STANDARD_SPIN_COUNT = 50_000;
const SEGMENT_LENGTH = 4096;
// 2.3.4.10 HashAlgorithm: the values the table defines, by their OpenSSL names. "SHA1" is not in the table; it is
// the name Windows resolves SHA-1 by (as it resolves SHA256, SHA384 and SHA512), which footnote <21> allows: "any
// algorithm that can be resolved by name by the underlying operating system can be used for hashing". A defined
// algorithm this runtime cannot compute (MD2, RIPEMD-128, ...) leaves the document unsupported.
const HASH_ALGORITHMS = new Map([
  ['SHA-1', 'sha1'],
  ['SHA1', 'sha1'],
  ['SHA256', 'sha256'],
  ['SHA384', 'sha384'],
  ['SHA512', 'sha512'],
  ['MD5', 'md5'],
  ['MD4', 'md4'],
  ['MD2', 'md2'],
  ['RIPEMD-128', 'ripemd128'],
  ['RIPEMD-160', 'ripemd160'],
  ['WHIRLPOOL', 'whirlpool'],
]);
const AES_ALGORITHMS = new Map([
  [0x660e, 128],
  [0x660f, 192],
  [0x6610, 256],
]);
const STANDARD_FLAG_CRYPTOAPI = 0x04;
const STANDARD_FLAG_AES = 0x20;

const hash = (algorithm, ...parts) => {
  const digest = createHash(algorithm);
  for (const part of parts) digest.update(part);
  return digest.digest();
};
const uint32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0, 0);
  return bytes;
};
// Truncated to, or padded with 0x36 up to, `length` bytes (2.3.4.11, 2.3.4.12).
const fitted = (bytes, length) =>
  bytes.length >= length
    ? bytes.subarray(0, length)
    : Buffer.concat([bytes, Buffer.alloc(length - bytes.length, 0x36)]);

function decrypt(mode, keyBits, key, iv, data) {
  const decipher = createDecipheriv(`aes-${keyBits}-${mode}`, key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// The digest length of an OpenSSL hash, or null when this runtime cannot compute it.
const digestLengths = new Map();
function digestLength(algorithm) {
  if (!digestLengths.has(algorithm)) {
    let length = null;
    try {
      length = createHash(algorithm).digest().length;
    } catch {}
    digestLengths.set(algorithm, length);
  }
  return digestLengths.get(algorithm);
}

// [W3C-XSD] lexical forms of the attribute types the descriptor uses.
const XML_SPACE = /[\t\n\r ]+/g;
// xs:unsignedInt (whitespace collapsed): decimal digits with an optional "+", at most 4,294,967,295.
function unsignedInt(value) {
  const text = typeof value === 'string' ? value.replace(XML_SPACE, ' ').trim() : '';
  if (!/^\+?[0-9]+$/.test(text)) return null;
  const number = Number(text);
  return number <= 0xffffffff ? number : null;
}
// xs:base64Binary: whole quads of the base64 alphabet (whitespace between them allowed), the last one padded with
// "=" over the unused bits, which must be zero.
function base64Binary(value) {
  const text = typeof value === 'string' ? value.replace(XML_SPACE, '') : '';
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/.test(text)) return null;
  return Buffer.from(text, 'base64');
}
// xs:token: whitespace collapsed.
const token = (value) => (typeof value === 'string' ? value.replace(XML_SPACE, ' ').trim() : null);

// The unqualified attributes of an element (the descriptor's schemas set attributeFormDefault="unqualified").
function unqualified(tag) {
  const values = Object.create(null);
  for (const attribute of Object.values(tag.attributes)) {
    if (attribute.uri === '') values[attribute.local] = attribute.value;
  }
  return values;
}

// CT_Encryption is this sequence: keyData, an optional dataIntegrity, keyEncryptors.
const ENCRYPTION_SEQUENCE = ['keyData', 'dataIntegrity', 'keyEncryptors'];

/**
 * The attributes of keyData, dataIntegrity (null when absent) and the password encryptedKey of an
 * XmlEncryptionDescriptor (2.3.4.10), read by namespace: the root is encryption, its children follow the
 * CT_Encryption sequence, keyEncryptors holds at least one keyEncryptor of exactly one element each, and exactly one
 * of them is the password key encryptor (uri "…/keyEncryptor/password") holding the encryptedKey of that namespace.
 * Throws for a DTD, malformed XML, an encoding other than UTF-8, or any other structure where these fields live.
 */
function descriptorFields(xml) {
  const parser = new SaxesParser({ xmlns: true, position: false });
  const fields = { keyData: null, dataIntegrity: null, encryptedKey: null };
  const open = [];
  let position = -1;
  let keyEncryptors = 0;
  let passwordKeyEncryptors = 0;
  parser.on('xmldecl', ({ encoding }) => {
    if (encoding !== undefined && encoding.toLowerCase() !== 'utf-8') throw new Error('descriptor is not UTF-8');
  });
  parser.on('doctype', () => {
    throw new Error('a DTD is not allowed in the descriptor');
  });
  parser.on('opentag', (tag) => {
    const parent = open.at(-1);
    const encryption = tag.uri === ENCRYPTION_NAMESPACE;
    let kind;
    if (!parent) {
      if (!encryption || tag.local !== 'encryption') throw new Error('not an encryption descriptor');
      kind = 'encryption';
    } else if (parent.kind === 'encryption') {
      const at = ENCRYPTION_SEQUENCE.indexOf(tag.local);
      if (!encryption || at <= position) throw new Error('unexpected element in encryption');
      position = at;
      kind = tag.local;
      if (kind !== 'keyEncryptors') fields[kind] = unqualified(tag);
    } else if (parent.kind === 'keyEncryptors') {
      if (!encryption || tag.local !== 'keyEncryptor') throw new Error('unexpected element in keyEncryptors');
      keyEncryptors++;
      const password = token(unqualified(tag).uri) === PASSWORD_KEY_ENCRYPTOR;
      if (password) passwordKeyEncryptors++;
      kind = password ? 'passwordKeyEncryptor' : 'keyEncryptor';
    } else if (parent.kind === 'passwordKeyEncryptor' || parent.kind === 'keyEncryptor') {
      if (++parent.children > 1) throw new Error('a keyEncryptor holds one element');
      if (parent.kind === 'passwordKeyEncryptor') {
        if (tag.uri !== PASSWORD_KEY_ENCRYPTOR || tag.local !== 'encryptedKey') throw new Error('not a password key');
        fields.encryptedKey = unqualified(tag);
        kind = 'encryptedKey';
      } else {
        kind = 'other';
      }
    } else if (parent.kind === 'other') {
      kind = 'other';
    } else {
      // keyData, dataIntegrity and encryptedKey are attributes only.
      throw new Error(`${parent.kind} has no child elements`);
    }
    open.push({ kind, children: 0 });
  });
  parser.on('closetag', () => {
    const closed = open.pop();
    if ((closed.kind === 'keyEncryptor' || closed.kind === 'passwordKeyEncryptor') && closed.children !== 1) {
      throw new Error('a keyEncryptor holds one element');
    }
  });
  parser.write(xml).close();
  if (!fields.keyData || position !== 2 || keyEncryptors < 1 || passwordKeyEncryptors !== 1) {
    throw new Error('incomplete encryption descriptor');
  }
  return fields;
}

// One cipher description (keyData, or the password encryptedKey), or null when it is not AES-CBC with a hash this
// runtime computes, or its values do not match their schema types.
function agileCipher(values) {
  const keyBits = unsignedInt(values.keyBits);
  const blockSize = unsignedInt(values.blockSize);
  const saltSize = unsignedInt(values.saltSize);
  const hashSize = unsignedInt(values.hashSize);
  const algorithm = HASH_ALGORITHMS.get(values.hashAlgorithm);
  const salt = base64Binary(values.saltValue);
  if (values.cipherAlgorithm !== 'AES' || values.cipherChaining !== 'ChainingModeCBC') return null;
  if (![128, 192, 256].includes(keyBits) || blockSize !== 16 || !algorithm) return null;
  if (digestLength(algorithm) !== hashSize || !salt || saltSize < 1 || salt.length !== saltSize) return null;
  return { keyBits, blockSize, saltSize, hashSize, algorithm, salt };
}

// base64Binary ciphertext of whole cipher blocks holding at least `least` bytes, or null.
function ciphertext(value, blockSize, least) {
  const bytes = base64Binary(value);
  return bytes && bytes.length >= least && bytes.length % blockSize === 0 ? bytes : null;
}

const wholeBlocks = (length, blockSize) => Math.ceil(length / blockSize) * blockSize;

// 2.3.4.14: the encrypted salt (the HMAC key) and the encrypted HMAC (hashSize bytes), each padded with 0x00 to
// whole blocks. Step 2 makes the salt KeyData.saltSize bytes long. Excel writes hashSize bytes instead (a file it
// saves holds saltSize 16, hashSize 64 and a 64-byte encryptedHmacKey whose bytes past the 16th are not padding),
// as Apache POI and msoffcrypto-tool do. The padded length says which of the two a file holds; where both pad to
// the same size the longer is taken, because the shorter one's further bytes are its 0x00 padding and [RFC2104]
// keys the HMAC identically with them (that size is at most 64 bytes, within one hash block). A present element
// that is anything else is malformed: the package is then never rendered.
function dataIntegrity(values, data) {
  if (!values) return null;
  const hmacKey = base64Binary(values.encryptedHmacKey);
  const hmacValue = base64Binary(values.encryptedHmacValue);
  const saltLengths = [data.saltSize, data.hashSize].filter(
    (length) => hmacKey?.length === wholeBlocks(length, data.blockSize)
  );
  if (!saltLengths.length || hmacValue?.length !== wholeBlocks(data.hashSize, data.blockSize)) {
    return { malformed: true };
  }
  return { hmacKey, hmacValue, saltLength: Math.max(...saltLengths) };
}

function agileDescriptor(info) {
  let fields;
  try {
    fields = descriptorFields(new TextDecoder('utf-8', { fatal: true }).decode(info.subarray(8)));
  } catch {
    return null;
  }
  const values = fields.encryptedKey;
  const data = agileCipher(fields.keyData);
  const key = agileCipher(values);
  const spinCount = unsignedInt(values.spinCount);
  if (!data || !key || spinCount === null || spinCount > MAX_SPIN_COUNT) return null;
  // The password key encryptor MUST use the keyData's cipher (both AES here) and hash algorithm.
  if (key.algorithm !== data.algorithm) return null;
  // 2.3.4.13: the verifier input (saltSize bytes), its hash and the intermediate key, each padded to whole blocks.
  const verifierInput = ciphertext(values.encryptedVerifierHashInput, key.blockSize, key.saltSize);
  const verifierHash = ciphertext(values.encryptedVerifierHashValue, key.blockSize, key.hashSize);
  const encryptedKey = ciphertext(values.encryptedKeyValue, key.blockSize, data.keyBits / 8);
  if (!verifierInput || !verifierHash || !encryptedKey) return null;
  return {
    type: 'agile',
    data,
    key,
    spinCount,
    verifierInput,
    verifierHash,
    encryptedKey,
    integrity: dataIntegrity(fields.dataIntegrity, data),
  };
}

function standardDescriptor(info) {
  if (info.length < 12) return null;
  const headerSize = info.readUInt32LE(8);
  if (headerSize < 32 || 12 + headerSize + 4 > info.length) return null;
  // 2.3.2 EncryptionHeader.Flags: standard encryption sets fCryptoAPI and fAES.
  const flags = info.readUInt32LE(12);
  const keyBits = AES_ALGORITHMS.get(info.readUInt32LE(20));
  const hashAlgorithm = info.readUInt32LE(24);
  if (!(flags & STANDARD_FLAG_CRYPTOAPI) || !(flags & STANDARD_FLAG_AES)) return null;
  if (!keyBits || info.readUInt32LE(28) !== keyBits || ![0, 0x8004].includes(hashAlgorithm)) return null;
  // 2.3.3 EncryptionVerifier: SaltSize (16), Salt, EncryptedVerifier (16), VerifierHashSize (20), and the
  // AES-padded EncryptedVerifierHash (32).
  const at = 12 + headerSize;
  if (info.readUInt32LE(at) !== 16 || at + 4 + 16 + 16 + 4 + 32 > info.length) return null;
  const verifierHashSize = info.readUInt32LE(at + 36);
  if (verifierHashSize !== 20) return null;
  return {
    type: 'standard',
    keyBits,
    salt: info.subarray(at + 4, at + 20),
    verifier: info.subarray(at + 20, at + 36),
    verifierHash: info.subarray(at + 40, at + 72),
    verifierHashSize,
  };
}

/**
 * How an \EncryptionInfo stream encrypts its package, or null when this is not agile or standard encryption with
 * parameters Office writes. The version decides (2.3.4.5, 2.3.4.10): 4.4 with reserved 0x40 is agile, minor 2 with
 * major 2, 3 or 4 is standard; minor 3 (extensible) is unsupported. An agile descriptor's `integrity` is null
 * without a dataIntegrity element and `{ malformed: true }` for one that cannot be checked.
 */
export function ooxmlEncryption(info) {
  if (!Buffer.isBuffer(info) || info.length < 8) return null;
  const major = info.readUInt16LE(0);
  const minor = info.readUInt16LE(2);
  if (major === 4 && minor === 4) return info.readUInt32LE(4) === 0x40 ? agileDescriptor(info) : null;
  if ([2, 3, 4].includes(major) && minor === 2) return standardDescriptor(info);
  return null;
}

const KEY_WORKER = new URL('./ooxml-key-worker.mjs', import.meta.url);
// Password derivations that may run at once, each on its own thread; later ones wait for a free one.
const MAX_KEY_DERIVATIONS = 2;
let runningDerivations = 0;
const waitingDerivations = [];

/** Password derivations running on their threads and waiting for one (for diagnostics and tests). */
export const ooxmlKeyDerivations = () => ({ running: runningDerivations, waiting: waitingDerivations.length });

function derivationSlot(signal) {
  if (runningDerivations < MAX_KEY_DERIVATIONS) {
    runningDerivations++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const start = () => {
      signal?.removeEventListener('abort', onAbort);
      runningDerivations++;
      resolve();
    };
    const onAbort = () => {
      waitingDerivations.splice(waitingDerivations.indexOf(start), 1);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    waitingDerivations.push(start);
  });
}

function releaseDerivationSlot() {
  runningDerivations--;
  waitingDerivations.shift()?.();
}

// 2.3.4.7 / 2.3.4.11: H0 = H(salt + password), Hn = H(iterator + Hn-1), computed on a worker thread
// (ooxml-key-worker.mjs). An abort ends the thread and rejects with the signal's reason; the thread's slot is free
// again once it has exited, however it ends.
async function iteratedHash(algorithm, salt, password, spinCount, signal) {
  signal?.throwIfAborted();
  await derivationSlot(signal);
  let worker;
  try {
    signal?.throwIfAborted();
    worker = new Worker(KEY_WORKER, {
      execArgv: workerExecArgv(),
      workerData: { algorithm, salt, password: String(password), spinCount },
    });
  } catch (error) {
    releaseDerivationSlot();
    throw error;
  }
  worker.once('exit', releaseDerivationSlot);
  return await new Promise((resolve, reject) => {
    const settle = (callback, value) => {
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      void worker.terminate();
      settle(reject, signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (value) => settle(resolve, Buffer.from(value.buffer, value.byteOffset, value.byteLength)));
    worker.once('error', (error) => settle(reject, error));
    worker.once('exit', (code) =>
      settle(reject, new Error(`The password derivation ended early (exit code ${code}).`))
    );
  });
}

async function agileKey(descriptor, password, signal) {
  const { key } = descriptor;
  const spun = await iteratedHash(key.algorithm, key.salt, password, descriptor.spinCount, signal);
  const iv = fitted(key.salt, key.blockSize);
  const open = (block, data) =>
    decrypt('cbc', key.keyBits, fitted(hash(key.algorithm, spun, block), key.keyBits / 8), iv, data);
  // 2.3.4.13: the decrypted verifier input, hashed, must equal the decrypted verifier hash.
  const input = open(VERIFIER_INPUT_BLOCK, descriptor.verifierInput).subarray(0, key.saltSize);
  const expected = hash(key.algorithm, input);
  const actual = open(VERIFIER_HASH_BLOCK, descriptor.verifierHash).subarray(0, key.hashSize);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  // 2.3.4.13: the intermediate key that encrypts the package.
  return open(ENCRYPTED_KEY_BLOCK, descriptor.encryptedKey).subarray(0, descriptor.data.keyBits / 8);
}

// 2.3.4.7: the key derived from the iterated SHA-1 hash, and 2.3.4.9: the verifier check.
async function standardKey(descriptor, password, signal) {
  const spun = await iteratedHash('sha1', descriptor.salt, password, STANDARD_SPIN_COUNT, signal);
  const final = hash('sha1', spun, uint32(0));
  const derive = (fill) => {
    const buffer = Buffer.alloc(64, fill);
    for (let index = 0; index < final.length; index++) buffer[index] ^= final[index];
    return hash('sha1', buffer);
  };
  const key = Buffer.concat([derive(0x36), derive(0x5c)]).subarray(0, descriptor.keyBits / 8);
  const verifier = decrypt('ecb', descriptor.keyBits, key, null, descriptor.verifier);
  const expected = hash('sha1', verifier);
  const actual = decrypt('ecb', descriptor.keyBits, key, null, descriptor.verifierHash).subarray(
    0,
    descriptor.verifierHashSize
  );
  return timingSafeEqual(actual, expected) ? key : null;
}

/**
 * The key that decrypts the package when `password` is right, else null. The verifier alone decides; the package
 * is not touched. The password hashing runs off this thread, at most two at once, and an abort of `signal` ends it
 * and rejects with the signal's reason.
 */
export async function ooxmlPasswordKey(descriptor, password, { signal = null } = {}) {
  return descriptor.type === 'agile'
    ? await agileKey(descriptor, password, signal)
    : await standardKey(descriptor, password, signal);
}

/**
 * 2.3.4.14: whether \EncryptedPackage is the stream the descriptor's HMAC was computed over. The HMAC key (the
 * salt) and value are decrypted with the package key and IVs H(keyData salt + block key) (2.3.4.12), and the HMAC
 * covers the whole stream, its StreamSize field included. Standard encryption and an agile descriptor without
 * dataIntegrity carry nothing to check (the schema makes the element optional); a malformed one never passes.
 */
export function ooxmlPackageIntact(descriptor, key, encryptedPackage) {
  const { integrity } = descriptor;
  if (descriptor.type !== 'agile' || !integrity) return true;
  if (integrity.malformed) return false;
  const { data } = descriptor;
  const open = (block, value) =>
    decrypt('cbc', data.keyBits, key, fitted(hash(data.algorithm, data.salt, block), data.blockSize), value);
  // The HMAC key is the salt without its block padding (its length read in dataIntegrity), the HMAC the first
  // hashSize bytes.
  const hmacKey = open(INTEGRITY_KEY_BLOCK, integrity.hmacKey).subarray(0, integrity.saltLength);
  const expected = open(INTEGRITY_VALUE_BLOCK, integrity.hmacValue).subarray(0, data.hashSize);
  const actual = createHmac(data.algorithm, hmacKey).update(encryptedPackage).digest();
  return timingSafeEqual(actual, expected);
}

/**
 * 2.3.4.15 (agile) / 2.3.4.4 (standard): the plain package. \EncryptedPackage starts with the 8-byte StreamSize of
 * the plain package; agile ciphertext is 4096-byte segments, each with IV H(keyData salt + segment index), standard
 * ciphertext is one AES-ECB run.
 */
export function decryptOoxmlPackage(descriptor, key, encryptedPackage) {
  if (encryptedPackage.length < 8) throw new Error('The encrypted package is truncated.');
  const size = Number(encryptedPackage.readBigUInt64LE(0));
  const body = encryptedPackage.subarray(8);
  if (size > body.length) throw new Error('The encrypted package is truncated.');
  let plain;
  if (descriptor.type === 'agile') {
    const { data } = descriptor;
    const parts = [];
    for (let offset = 0, index = 0; offset < body.length; offset += SEGMENT_LENGTH, index++) {
      const segment = body.subarray(offset, offset + SEGMENT_LENGTH);
      const whole = segment.subarray(0, segment.length - (segment.length % data.blockSize));
      const iv = fitted(hash(data.algorithm, data.salt, uint32(index)), data.blockSize);
      parts.push(decrypt('cbc', data.keyBits, key, iv, whole));
    }
    plain = Buffer.concat(parts);
  } else {
    plain = decrypt('ecb', descriptor.keyBits, key, null, body.subarray(0, body.length - (body.length % 16)));
  }
  if (plain.length < size) throw new Error('The encrypted package is truncated.');
  return plain.subarray(0, size);
}
