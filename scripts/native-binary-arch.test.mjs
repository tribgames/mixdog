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

function elf(machine) {
  const buffer = Buffer.alloc(32)
  buffer.writeUInt32BE(0x7f454c46, 0)
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
  assert.equal(nativeBinaryArch(pe(0x8664)), 'x64')
  assert.equal(nativeBinaryArch(pe(0xaa64)), 'arm64')
})

test('a foreign architecture is rejected for the target', () => {
  assert.equal(nativeBinaryRunsOn(machO({ cpu: 0x0100000c }), 'x64'), false)
  assert.equal(nativeBinaryRunsOn(elf(0x3e), 'arm64'), false)
})

test('bytes without a recognizable object header do not fail a build', () => {
  assert.equal(nativeBinaryArches(Buffer.from('#!/bin/sh\nexec node "$0"\n')), null)
  assert.equal(nativeBinaryRunsOn(Buffer.alloc(4), 'x64'), true)
})
