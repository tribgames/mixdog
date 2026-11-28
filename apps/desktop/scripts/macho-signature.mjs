// A Mach-O program with and without its code signature: `codesign` writes the LC_CODE_SIGNATURE load command (adding it
// in the header padding, or rewriting the linker's ad-hoc one), the signature data from that command's offset to the end
// of the file with alignment zeros before it, and the __LINKEDIT sizes that cover it. Nothing else of the file changes.
import { open } from 'node:fs/promises';

const MH_MAGIC_64 = 0xfeedfacf;
const THIN_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);
const FAT_MAGICS = new Set([0xcafebabe, 0xcafebabf]);
const HEADER_64 = 32;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;

/** Whether `file` is a Mach-O program or library, thin or universal. */
export async function isMachO(file) {
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(8);
    const { bytesRead } = await handle.read(head, 0, 8, 0);
    if (bytesRead < 8) return false;
    const magic = head.readUInt32BE(0);
    if (THIN_MAGICS.has(magic)) return true;
    // A Java class file starts with the universal magic too; its version word, where the architecture count is, is at least 45.
    const architectures = head.readUInt32BE(4);
    return FAT_MAGICS.has(magic) && architectures > 0 && architectures < 45;
  } finally {
    await handle.close();
  }
}

/** The bytes of a thin 64-bit Mach-O that no code signature touches (see the top of this file). */
export function unsignedImage(bytes) {
  if (bytes.length < HEADER_64 || bytes.readUInt32LE(0) !== MH_MAGIC_64) throw new Error('not a thin 64-bit Mach-O');
  const image = Buffer.from(bytes);
  const ncmds = image.readUInt32LE(16);
  const sizeofcmds = image.readUInt32LE(20);
  const commandsEnd = HEADER_64 + sizeofcmds;
  if (commandsEnd > image.length) throw new Error('its load commands run past the end of the file');
  let end = image.length;
  let removed = 0;
  let removedSize = 0;
  for (let index = 0, at = HEADER_64; index < ncmds; index += 1) {
    const size = at + 8 <= commandsEnd ? image.readUInt32LE(at + 4) : 0;
    if (size < 8 || at + size > commandsEnd) throw new Error(`load command ${index} is malformed`);
    const command = image.readUInt32LE(at);
    if (command === LC_CODE_SIGNATURE) {
      end = image.readUInt32LE(at + 8);
      if (end > image.length) throw new Error('its code signature starts past the end of the file');
      image.fill(0, at, at + size);
      removed += 1;
      removedSize += size;
    } else if (
      command === LC_SEGMENT_64 &&
      image.toString('latin1', at + 8, at + 24).replace(/\0+$/, '') === '__LINKEDIT'
    ) {
      image.fill(0, at + 32, at + 40); // vmsize
      image.fill(0, at + 48, at + 56); // filesize
    }
    at += size;
  }
  image.writeUInt32LE(ncmds - removed, 16);
  image.writeUInt32LE(sizeofcmds - removedSize, 20);
  let last = end;
  while (last > commandsEnd && image[last - 1] === 0) last -= 1;
  return image.subarray(0, last);
}

/** Whether two thin 64-bit Mach-O files are the same program, each with or without a code signature. */
export function sameUnsignedCode(a, b) {
  return unsignedImage(a).equals(unsignedImage(b));
}
