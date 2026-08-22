import assert from 'node:assert/strict'
import test from 'node:test'

import {
  nativeBinaryArch,
  nativeBinaryArches,
  nativeBinaryRunsOn,
} from './native-binary-arch.mjs'

function machO({ cpu, littleEndian = true, wide = true }) {
  const buffer = Buffer.alloc(32)
  const magic = wide ? 0xfeedfacf : 0xfeedface
  if (littleEndian) {
    buffer.writeUInt32BE(wide ? 0xcffaedfe : 0xcefaedfe, 0)
    buffer.writeUInt32LE(cpu, 4)
  } else {
    buffer.writeUInt32BE(magic, 0)
    buffer.writeUInt32BE(cpu, 4)
  }
  return buffer
}

function machOFat(cpus) {
  const buffer = Buffer.alloc(8 + cpus.length * 20)
  buffer.writeUInt32BE(0xcafebabe, 0)
  buffer.writeUInt32BE(cpus.length, 4)
  cpus.forEach((cpu, index) => buffer.writeUInt32BE(cpu, 8 + index * 20))
  return buffer
}

function elf(machine, { eiClass = 2 } = {}) {
  const buffer = Buffer.alloc(eiClass === 1 ? 52 : 64)
  buffer.writeUInt32BE(0x7f454c46, 0)
  buffer[4] = eiClass
  buffer[5] = 1
  buffer.writeUInt16LE(machine, 18)
  return buffer
}

function pe(machine) {
  const buffer = Buffer.alloc(128)
  buffer.writeUInt16LE(0x5a4d, 0)
  buffer.writeUInt32LE(64, 60)
  buffer.writeUInt32LE(0x00004550, 64)
  buffer.writeUInt16LE(machine, 68)
  return buffer
}

test('Mach-O headers name their architecture in both endiannesses', () => {
  assert.equal(nativeBinaryArch(machO({ cpu: 0x01000007 })), 'x64')
  assert.equal(nativeBinaryArch(machO({ cpu: 0x0100000c })), 'arm64')
  assert.equal(nativeBinaryArch(machO({ cpu: 0x01000007, littleEndian: false })), 'x64')
  assert.equal(nativeBinaryArch(machO({ cpu: 7, wide: false })), 'ia32')
})

test('universal binaries report every slice they carry', () => {
  assert.deepEqual(nativeBinaryArches(machOFat([0x01000007, 0x0100000c])), ['x64', 'arm64'])
  assert.equal(nativeBinaryRunsOn(machOFat([0x01000007, 0x0100000c]), 'arm64'), true)
})

test('ELF and PE headers are read too', () => {
  assert.equal(nativeBinaryArch(elf(0x3e)), 'x64')
  assert.equal(nativeBinaryArch(elf(0xb7)), 'arm64')
  assert.equal(nativeBinaryArch(elf(0x03, { eiClass: 1 })), 'ia32')
  assert.equal(nativeBinaryArch(pe(0x8664)), 'x64')
  assert.equal(nativeBinaryArch(pe(0xaa64)), 'arm64')
})

test('ELF class must match the named machine', () => {
  assert.equal(nativeBinaryArch(elf(0x3e, { eiClass: 1 })), null)
  assert.equal(nativeBinaryRunsOn(elf(0x3e, { eiClass: 1 }), 'x64'), false)
  assert.equal(nativeBinaryArch(elf(0xb7, { eiClass: 1 })), null)
  assert.equal(nativeBinaryArch(elf(0x03)), null)
})

test('a foreign architecture is rejected for the target', () => {
  assert.equal(nativeBinaryRunsOn(machO({ cpu: 0x0100000c }), 'x64'), false)
  assert.equal(nativeBinaryRunsOn(elf(0x3e), 'arm64'), false)
})

test('unknown, truncated, or unsupported headers are not architecture-compatible', () => {
  assert.equal(nativeBinaryArches(Buffer.from('#!/bin/sh\nexec node "$0"\n')), null)
  assert.equal(nativeBinaryRunsOn(Buffer.alloc(4), 'x64'), false)
  assert.equal(nativeBinaryRunsOn(Buffer.from('#!/bin/sh\n'), 'arm64'), false)
  assert.equal(nativeBinaryRunsOn(elf(0xf3), 'x64'), false)

  const truncatedMachO = Buffer.alloc(8)
  truncatedMachO.writeUInt32BE(0xcffaedfe, 0)
  truncatedMachO.writeUInt32LE(0x01000007, 4)
  assert.equal(nativeBinaryRunsOn(truncatedMachO, 'x64'), false)

  const truncatedElf = Buffer.alloc(20)
  truncatedElf.writeUInt32BE(0x7f454c46, 0)
  truncatedElf[4] = 1
  truncatedElf[5] = 1
  truncatedElf.writeUInt16LE(0x3e, 18)
  assert.equal(nativeBinaryRunsOn(truncatedElf, 'x64'), false)

  const truncatedPe = Buffer.alloc(70)
  truncatedPe.writeUInt16LE(0x5a4d, 0)
  truncatedPe.writeUInt32LE(64, 60)
  truncatedPe.writeUInt32LE(0x00004550, 64)
  truncatedPe.writeUInt16LE(0x8664, 68)
  assert.equal(nativeBinaryRunsOn(truncatedPe, 'x64'), false)

  const truncatedFat = Buffer.alloc(12)
  truncatedFat.writeUInt32BE(0xcafebabe, 0)
  truncatedFat.writeUInt32BE(1, 4)
  truncatedFat.writeUInt32BE(0x01000007, 8)
  assert.equal(nativeBinaryRunsOn(truncatedFat, 'x64'), false)
})
