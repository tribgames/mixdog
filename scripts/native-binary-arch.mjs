#!/usr/bin/env node

/**
 * Architecture of a compiled artifact, read from its own header.
 *
 * The desktop runtime is prepared for a TARGET that need not match the build
 * host, and the expensive failure is silent: an arm64 addon inside an x64 app
 * packages, uploads, and publishes without complaint, then refuses to load on
 * the user's machine. Reading the header turns that into a build error at the
 * moment the archive is assembled.
 *
 * Only the fields that name the architecture are parsed; nothing here loads or
 * executes the file.
 */

// Mach-O cpu_type_t. The 0x01000000 bit marks the 64-bit variants.
const MACHO_CPU = new Map([[0x01000007, 'x64'], [0x0100000c, 'arm64'], [7, 'ia32']])
// ELF e_machine.
const ELF_MACHINE = new Map([[0x3e, 'x64'], [0xb7, 'arm64'], [0x03, 'ia32']])
// PE IMAGE_FILE_HEADER.Machine.
const PE_MACHINE = new Map([[0x8664, 'x64'], [0xaa64, 'arm64'], [0x14c, 'ia32']])

function machOArch(buffer) {
  if (buffer.length < 8) return null
  const magic = buffer.readUInt32BE(0)
  // Thin Mach-O: 0xfeedfacf (64-bit) / 0xfeedface (32-bit), either endianness.
  if (magic === 0xfeedfacf || magic === 0xfeedface) return MACHO_CPU.get(buffer.readUInt32BE(4)) || null
  if (magic === 0xcffaedfe || magic === 0xcefaedfe) return MACHO_CPU.get(buffer.readUInt32LE(4)) || null
  return null
}

/** Universal binaries name every slice they carry, so they are read as a set. */
function machOFatArches(buffer) {
  if (buffer.length < 8) return null
  const magic = buffer.readUInt32BE(0)
  // 0xcafebabe is also a Java class file; those never reach an addon path, and
  // the slice count sanity check below rejects the overlap in practice.
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) return null
  const wide = magic === 0xcafebabf
  const count = buffer.readUInt32BE(4)
  if (!count || count > 16) return null
  const entrySize = wide ? 32 : 20
  const arches = []
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * entrySize
    if (offset + 4 > buffer.length) return null
    const arch = MACHO_CPU.get(buffer.readUInt32BE(offset))
    if (arch) arches.push(arch)
  }
  return arches.length ? arches : null
}

function elfArch(buffer) {
  if (buffer.length < 20) return null
  if (buffer.readUInt32BE(0) !== 0x7f454c46) return null
  const littleEndian = buffer[5] === 1
  const machine = littleEndian ? buffer.readUInt16LE(18) : buffer.readUInt16BE(18)
  return ELF_MACHINE.get(machine) || null
}

function peArch(buffer) {
  if (buffer.length < 64 || buffer.readUInt16LE(0) !== 0x5a4d) return null
  const headerOffset = buffer.readUInt32LE(60)
  if (headerOffset + 6 > buffer.length) return null
  if (buffer.readUInt32LE(headerOffset) !== 0x00004550) return null
  return PE_MACHINE.get(buffer.readUInt16LE(headerOffset + 4)) || null
}

/**
 * Every architecture the artifact can run on, or null when the bytes carry no
 * recognizable object header (a text stub, a placeholder, a data file).
 */
export function nativeBinaryArches(buffer) {
  const fat = machOFatArches(buffer)
  if (fat) return fat
  const single = machOArch(buffer) || elfArch(buffer) || peArch(buffer)
  return single ? [single] : null
}

/** Convenience for the single-slice case; a fat binary reports its first slice. */
export function nativeBinaryArch(buffer) {
  return nativeBinaryArches(buffer)?.[0] ?? null
}

/**
 * True when the artifact can run on `arch`. An unrecognized header answers
 * true: the caller is verifying compiled objects, and refusing every file it
 * cannot parse would fail builds over unrelated payloads.
 */
export function nativeBinaryRunsOn(buffer, arch) {
  const arches = nativeBinaryArches(buffer)
  return arches === null || arches.includes(arch)
}
