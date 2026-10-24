// Password protection, read from the Compound File Binary container itself.
//
// An encrypted Office document is a CFB container ([MS-CFB]) whose root storage holds well-known streams. The CFB
// signature alone proves nothing (an unencrypted legacy .doc renamed .docx has it too), so the root-level stream
// names are listed the way [MS-CFB] lays them out: the header (2.2), the FAT (2.3) and DIFAT (2.5) to follow the
// directory sector chain, the directory entries (2.6.1, 2.6.2) and the sibling tree under the root (2.6.4). Only the
// header, the directory sectors and at most one 64-byte slice of one stream are read, never the whole file. Any
// malformed or truncated container is "not protected", and the renderer then decides exactly as it would have.
//
// The file is untrusted: every count and size it declares is checked against its real length before it is used,
// every sector chain is walked with a record of the sectors it visited (a sector seen twice is a cycle, and the
// container malformed), and no walk ever goes past a fixed number of sectors, whatever the file declares.
import { open } from 'node:fs/promises';

const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const HEADER_SIZE = 512;
const HEADER_DIFAT_ENTRIES = 109;
const DIRECTORY_ENTRY_SIZE = 128;
const MINI_SECTOR_SIZE = 64;
// [MS-CFB] 2.2: the mini stream cutoff MUST be 4096 bytes.
const MINI_STREAM_CUTOFF = 4096;
const MAX_REGULAR_SECTOR = 0xfffffffa;
const END_OF_CHAIN = 0xfffffffe;
const NO_STREAM = 0xffffffff;
const ENTRY_STREAM = 2;
const ENTRY_ROOT_STORAGE = 5;
const MAX_DIRECTORY_BYTES = 1024 * 1024;
// Beyond this an encrypted package is not unlocked for a preview (it is decrypted in memory).
const MAX_ENCRYPTION_INFO_BYTES = 64 * 1024;
const MAX_ENCRYPTED_PACKAGE_BYTES = 256 * 1024 * 1024;
// The most sectors any one chain walk visits: the 512-byte sectors of the largest stream ever read.
const MAX_CHAIN_SECTORS = MAX_ENCRYPTED_PACKAGE_BYTES / 512;

async function readExactly(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error('truncated compound file');
  return buffer;
}

// Stream names are compared case-insensitively by uppercase mapping ([MS-CFB] 2.6.4), so they are keyed uppercase.
const streamKey = (name) => name.toUpperCase();

async function openCompoundFile(handle) {
  const header = await readExactly(handle, 0, HEADER_SIZE);
  const majorVersion = header.readUInt16LE(26);
  const sectorShift = header.readUInt16LE(30);
  if (
    !header.subarray(0, SIGNATURE.length).equals(SIGNATURE) ||
    header.readUInt16LE(28) !== 0xfffe ||
    sectorShift !== { 3: 9, 4: 12 }[majorVersion] ||
    header.readUInt16LE(32) !== 6 ||
    header.readUInt32LE(56) !== MINI_STREAM_CUTOFF
  ) {
    throw new Error('not a compound file');
  }
  const sectorSize = 1 << sectorShift;
  const entriesPerSector = sectorSize / 4;
  // Sector n starts at byte (n + 1) * sectorSize, after the header sector; a last partial sector still counts.
  const sectorsInFile = Math.max(0, Math.ceil((await handle.stat()).size / sectorSize) - 1);
  const fatSectorCount = header.readUInt32LE(44);
  const miniFatSectorCount = header.readUInt32LE(64);
  const difatSectorCount = header.readUInt32LE(72);
  // A count of sectors larger than the file has sectors is false.
  if (Math.max(fatSectorCount, miniFatSectorCount, difatSectorCount) > sectorsInFile) {
    throw new Error('sector counts beyond the file');
  }

  const readSector = (sector, offset, length) => {
    if (sector > MAX_REGULAR_SECTOR || sector >= sectorsInFile) throw new Error('sector number out of range');
    return readExactly(handle, (sector + 1) * sectorSize + offset, length);
  };

  // The DIFAT sector chain (2.5), followed lazily through the last entry of each of its sectors.
  const difatSectors = [];
  const difatSeen = new Set();
  async function difatSector(hop) {
    if (hop >= Math.min(difatSectorCount, MAX_CHAIN_SECTORS)) throw new Error('sector beyond the DIFAT');
    while (difatSectors.length <= hop) {
      const sector = difatSectors.length
        ? (await readSector(difatSectors.at(-1), (entriesPerSector - 1) * 4, 4)).readUInt32LE(0)
        : header.readUInt32LE(68);
      if (difatSeen.has(sector)) throw new Error('cyclic DIFAT chain');
      difatSeen.add(sector);
      difatSectors.push(sector);
    }
    return difatSectors[hop];
  }

  // Location of the index-th FAT sector: the first 109 are in the header, the rest in the DIFAT sector chain (2.5).
  async function fatSectorLocation(index) {
    if (index >= fatSectorCount) throw new Error('sector beyond the FAT');
    if (index < HEADER_DIFAT_ENTRIES) return header.readUInt32LE(76 + index * 4);
    const perDifatSector = entriesPerSector - 1;
    const past = index - HEADER_DIFAT_ENTRIES;
    const sector = await difatSector(Math.floor(past / perDifatSector));
    return (await readSector(sector, (past % perDifatSector) * 4, 4)).readUInt32LE(0);
  }

  // A whole stream walks one FAT entry per sector, so each FAT sector is read once and kept.
  const fatSectors = new Map();
  async function nextSector(sector) {
    const index = Math.floor(sector / entriesPerSector);
    let fat = fatSectors.get(index);
    if (!fat) {
      fat = await readSector(await fatSectorLocation(index), 0, sectorSize);
      fatSectors.set(index, fat);
    }
    return fat.readUInt32LE((sector % entriesPerSector) * 4);
  }

  // A sector chain from `first`, followed lazily and remembered: `chain(n)` is its n-th sector, or null past its
  // end. A chain longer than `limit` sectors (or MAX_CHAIN_SECTORS), one that leaves the file, or one that comes
  // back to a sector it already visited is malformed.
  function sectorChain(first, limit) {
    const sectors = [];
    const seen = new Set();
    let ended = false;
    return async (index) => {
      while (sectors.length <= index) {
        if (ended) return null;
        const sector = sectors.length ? await nextSector(sectors.at(-1)) : first;
        if (sector === END_OF_CHAIN) {
          ended = true;
          return null;
        }
        if (sector > MAX_REGULAR_SECTOR || sector >= sectorsInFile) throw new Error('sector outside the file');
        if (seen.has(sector)) throw new Error('cyclic sector chain');
        if (sectors.length >= Math.min(limit, MAX_CHAIN_SECTORS)) throw new Error('sector chain too long');
        seen.add(sector);
        sectors.push(sector);
      }
      return sectors[index];
    };
  }

  const directoryParts = [];
  const directorySectors = sectorChain(header.readUInt32LE(48), MAX_DIRECTORY_BYTES / sectorSize);
  for (
    let sector = await directorySectors(0);
    sector !== null;
    sector = await directorySectors(directoryParts.length)
  ) {
    directoryParts.push(await readSector(sector, 0, sectorSize));
  }
  const directory = Buffer.concat(directoryParts);

  function entryAt(id) {
    const at = id * DIRECTORY_ENTRY_SIZE;
    if (at + DIRECTORY_ENTRY_SIZE > directory.length) throw new Error('directory entry out of range');
    const nameBytes = directory.readUInt16LE(at + 64);
    if (nameBytes > 64) throw new Error('directory entry name too long');
    return {
      name: streamKey(directory.toString('utf16le', at, at + Math.max(nameBytes - 2, 0))),
      type: directory[at + 66],
      left: directory.readUInt32LE(at + 68),
      right: directory.readUInt32LE(at + 72),
      child: directory.readUInt32LE(at + 76),
      start: directory.readUInt32LE(at + 116),
      // Version 3 files may leave the high half of the size uninitialized; it is ignored there.
      size: majorVersion === 3 ? directory.readUInt32LE(at + 120) : Number(directory.readBigUInt64LE(at + 120)),
    };
  }

  const root = entryAt(0);
  if (root.type !== ENTRY_ROOT_STORAGE) throw new Error('missing root storage');
  // Only the siblings directly under the root: a storage's own children are never followed.
  const streams = new Map();
  const visited = new Set();
  const pending = [root.child];
  while (pending.length) {
    const id = pending.pop();
    if (id === NO_STREAM) continue;
    if (visited.has(id)) throw new Error('cyclic directory tree');
    visited.add(id);
    const entry = entryAt(id);
    if (entry.type === ENTRY_STREAM) streams.set(entry.name, entry);
    pending.push(entry.left, entry.right);
  }

  // The mini stream ([MS-CFB] 2.6.2) is the root entry's own stream: root.size bytes, which cannot be more than the
  // file holds, in a regular sector chain followed lazily and shared by every read.
  let miniStreamSectors = null;
  async function readMiniStream(offset, length) {
    // Nothing past the root entry's size is stream data. A read never crosses a sector: mini sectors are 64-byte
    // aligned and a read is at most one of them.
    if (offset + length > root.size) throw new Error('mini stream too short');
    if (root.size > sectorsInFile * sectorSize) throw new Error('mini stream larger than the file');
    miniStreamSectors ??= sectorChain(root.start, Math.ceil(root.size / sectorSize));
    const sector = await miniStreamSectors(Math.floor(offset / sectorSize));
    if (sector === null) throw new Error('mini stream sector missing');
    return readSector(sector, offset % sectorSize, length);
  }

  // The mini FAT (header offset 60, at most miniFatSectorCount sectors) maps each mini sector to the next one.
  let miniFatSectors = null;
  async function nextMiniSector(mini) {
    miniFatSectors ??= sectorChain(header.readUInt32LE(60), miniFatSectorCount);
    const sector = await miniFatSectors(Math.floor(mini / entriesPerSector));
    if (sector === null) throw new Error('mini FAT too short');
    return (await readSector(sector, (mini % entriesPerSector) * 4, 4)).readUInt32LE(0);
  }

  return {
    hasStream: (name) => streams.has(streamKey(name)),
    // The first `length` (at most 64) bytes of a root-level stream. A stream under the mini-stream cutoff lives in
    // the root entry's mini stream ([MS-CFB] 2.6.2), whose mini sector `start` sits at a 64-byte multiple.
    async readStreamHead(name, length) {
      const entry = streams.get(streamKey(name));
      if (!entry || entry.size < length) throw new Error('stream missing or too short');
      if (entry.size >= MINI_STREAM_CUTOFF) return readSector(entry.start, 0, length);
      return readMiniStream(entry.start * MINI_SECTOR_SIZE, length);
    },
    // A whole root-level stream of at most `maxBytes`. Regular sectors are read in contiguous runs; a stream under
    // the cutoff follows its mini FAT chain through the root entry's mini stream ([MS-CFB] 2.3), each mini sector
    // once.
    async readStream(name, maxBytes) {
      const entry = streams.get(streamKey(name));
      if (!entry || entry.size > maxBytes) throw new Error('stream missing or too large');
      if (entry.size >= MINI_STREAM_CUTOFF) {
        const sectorCount = Math.ceil(entry.size / sectorSize);
        const chain = sectorChain(entry.start, sectorCount);
        const parts = [];
        let run = null;
        for (let index = 0; index < sectorCount; index++) {
          const sector = await chain(index);
          if (sector === null) throw new Error('stream shorter than its size');
          if (run && sector === run.first + run.count) run.count++;
          else {
            run = { first: sector, count: 1 };
            parts.push(run);
          }
        }
        const data = Buffer.concat(
          await Promise.all(parts.map((part) => readSector(part.first, 0, part.count * sectorSize)))
        );
        return data.subarray(0, entry.size);
      }
      const miniCount = Math.ceil(entry.size / MINI_SECTOR_SIZE);
      const parts = [];
      const seen = new Set();
      let mini = entry.start;
      for (let index = 0; index < miniCount; index++) {
        if (index) mini = await nextMiniSector(mini);
        if (seen.has(mini)) throw new Error('cyclic mini sector chain');
        seen.add(mini);
        parts.push(await readMiniStream(mini * MINI_SECTOR_SIZE, MINI_SECTOR_SIZE));
      }
      return Buffer.concat(parts).subarray(0, entry.size);
    },
  };
}

async function inspectCompoundFile(path, decide, fallback = false) {
  let handle;
  try {
    handle = await open(path, 'r');
    return await decide(await openCompoundFile(handle));
  } catch {
    return fallback;
  } finally {
    await handle?.close();
  }
}

/**
 * The \EncryptionInfo and \EncryptedPackage streams of an encrypted OOXML document ([MS-OFFCRYPTO] 2.3.4.4,
 * 2.3.4.5), or null when the container cannot be read or the package is too large to unlock.
 */
export const readEncryptedOoxml = (path) =>
  inspectCompoundFile(
    path,
    async (file) => ({
      encryptionInfo: await file.readStream('EncryptionInfo', MAX_ENCRYPTION_INFO_BYTES),
      encryptedPackage: await file.readStream('EncryptedPackage', MAX_ENCRYPTED_PACKAGE_BYTES),
    }),
    null
  );

/** Only the \EncryptionInfo stream, enough to tell whether the encryption is one a preview can unlock. */
export const readOoxmlEncryptionInfo = (path) =>
  inspectCompoundFile(path, (file) => file.readStream('EncryptionInfo', MAX_ENCRYPTION_INFO_BYTES), null);

/**
 * [MS-DOC] 2.5.1 FibBase, at the start of the "WordDocument" stream: wIdent 0xA5EC, and fEncrypted (bit 0x0100 of
 * the flags word at offset 10) set when the document is encrypted or XOR-obfuscated, both opened by a password.
 */
export const isEncryptedWordDocument = (path) =>
  inspectCompoundFile(path, async (file) => {
    const fib = await file.readStreamHead('WordDocument', 12);
    return fib.readUInt16LE(0) === 0xa5ec && (fib.readUInt16LE(10) & 0x0100) !== 0;
  });

/**
 * [MS-OFFCRYPTO] 2.3.4 (ECMA-376 Document Encryption): an encrypted OOXML document is a CFB container holding the
 * root-level streams \EncryptionInfo (2.3.4.5) and \EncryptedPackage (2.3.4.4).
 */
export const isEncryptedOoxml = (path) =>
  inspectCompoundFile(path, (file) => file.hasStream('EncryptionInfo') && file.hasStream('EncryptedPackage'));

/**
 * [MS-PPT] binary presentation: an "EncryptedSummary" stream (2.1.6) exists only in an encrypted document, and an
 * encrypted file's "Current User" stream (2.1.1), which is never encrypted, holds a CurrentUserAtom (2.3.2:
 * RecordHeader with recType 0x0FF6, size, headerToken) whose headerToken 0xF3D1C4DF means the file MUST be encrypted.
 */
export const isEncryptedBinaryPresentation = (path) =>
  inspectCompoundFile(path, async (file) => {
    if (file.hasStream('EncryptedSummary')) return true;
    const atom = await file.readStreamHead('Current User', 16);
    return atom.readUInt16LE(2) === 0x0ff6 && atom.readUInt32LE(12) === 0xf3d1c4df;
  });
