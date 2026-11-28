// Mach-O files for tests, laid out the way the linker writes a program and codesign signs one.
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;
// After the header and the padding of its load commands, where codesign adds the signature's command.
const TEXT_OFFSET = 256;
const align = (value, to) => Math.ceil(value / to) * to;

/** A thin arm64 executable: __TEXT ends with `code`, __LINKEDIT holds `linkedit` and, with `signature`, that signature's
 *  data at the 16-byte alignment after the link-edit data. */
export function machO({ code = 'code', linkedit = 'symbols', signature = null } = {}) {
  const codeBytes = Buffer.from(code);
  const linkeditBytes = Buffer.from(linkedit);
  const signatureBytes = signature === null ? null : Buffer.from(signature);
  const linkeditOffset = TEXT_OFFSET + codeBytes.length;
  const signatureOffset = align(linkeditOffset + linkeditBytes.length, 16);
  const end = signatureBytes ? signatureOffset + signatureBytes.length : linkeditOffset + linkeditBytes.length;
  const file = Buffer.alloc(end);
  file.writeUInt32LE(0xfeedfacf, 0);
  file.writeUInt32LE(0x0100000c, 4);
  file.writeUInt32LE(2, 12);
  file.writeUInt32LE(signatureBytes ? 3 : 2, 16);
  file.writeUInt32LE(72 * 2 + (signatureBytes ? 16 : 0), 20);
  const segment = (at, name, fileoff, filesize) => {
    file.writeUInt32LE(LC_SEGMENT_64, at);
    file.writeUInt32LE(72, at + 4);
    file.write(name, at + 8, 'latin1');
    file.writeBigUInt64LE(BigInt(0x100000000 + fileoff), at + 24);
    file.writeBigUInt64LE(BigInt(align(filesize, 0x4000)), at + 32);
    file.writeBigUInt64LE(BigInt(fileoff), at + 40);
    file.writeBigUInt64LE(BigInt(filesize), at + 48);
  };
  segment(32, '__TEXT', 0, linkeditOffset);
  segment(104, '__LINKEDIT', linkeditOffset, end - linkeditOffset);
  if (signatureBytes) {
    file.writeUInt32LE(LC_CODE_SIGNATURE, 176);
    file.writeUInt32LE(16, 180);
    file.writeUInt32LE(signatureOffset, 184);
    file.writeUInt32LE(signatureBytes.length, 188);
    signatureBytes.copy(file, signatureOffset);
  }
  codeBytes.copy(file, TEXT_OFFSET);
  linkeditBytes.copy(file, linkeditOffset);
  return file;
}
