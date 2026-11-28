import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';
import { isMachO, sameUnsignedCode } from './macho-signature.mjs';
import { machO } from './test-macho.mjs';

test("a signature added to an unsigned program, or put in place of the linker's, leaves the same program", () => {
  const unsigned = machO();
  const linkerSigned = machO({ signature: 'ad-hoc' });
  const developerId = machO({ signature: Buffer.alloc(900, 0xab) });
  assert.ok(sameUnsignedCode(unsigned, developerId));
  assert.ok(sameUnsignedCode(linkerSigned, developerId));
  assert.ok(sameUnsignedCode(developerId, unsigned));
});

test('a program with other code or other link-edit data is another program, signed or not', () => {
  const signed = machO({ signature: 'developer id' });
  assert.equal(sameUnsignedCode(machO({ code: 'cod3' }), signed), false);
  assert.equal(sameUnsignedCode(machO({ linkedit: 'symbolz' }), signed), false);
  assert.equal(sameUnsignedCode(machO({ code: 'cod3', signature: 'developer id' }), signed), false);
});

test('only thin 64-bit Mach-O programs are compared', () => {
  assert.throws(() => sameUnsignedCode(Buffer.from('binary for aarch64-apple-darwin'), machO()), /not a thin 64-bit/);
});

test('Mach-O programs and libraries are told from other files, a Java class included', async () => {
  const dir = makeTempDirSync('macho-detect');
  const file = (name, bytes) => {
    writeFileSync(join(dir, name), bytes);
    return join(dir, name);
  };
  assert.equal(await isMachO(file('thin', machO())), true);
  assert.equal(await isMachO(file('big-endian', Buffer.from('feedfacf00000000', 'hex'))), true);
  assert.equal(await isMachO(file('universal', Buffer.from('cafebabe00000002', 'hex'))), true);
  assert.equal(await isMachO(file('Main.class', Buffer.from('cafebabe00000034', 'hex'))), false);
  assert.equal(await isMachO(file('index.js', 'export default 1;\n')), false);
  assert.equal(await isMachO(file('short', Buffer.from('cffaed', 'hex'))), false);
});
