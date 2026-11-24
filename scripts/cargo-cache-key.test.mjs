import assert from 'node:assert/strict';
import test from 'node:test';

import { cargoCacheKey } from './cargo-cache-key.mjs';

const manifest = (version, dep = '1.0.0') =>
  `[workspace.package]\nversion = "${version}" # root\nedition = "2024"\n\n[workspace.dependencies]\nserde = { version = "${dep}" }\n`;
const lock = (version, serde = '1.0.0', checksum = '00') =>
  `version = 4\n\n[[package]]\nname = "mixdog-a"\nversion = "${version}"\n\n[[package]]\nname = "serde"\nversion = "${serde}"\nsource = "registry+x"\nchecksum = "${checksum}"\n`;
const key = (m, l) =>
  cargoCacheKey([
    { name: 'Cargo.toml', text: m },
    { name: 'Cargo.lock', text: l },
  ]);

test('a release version change keeps the key', () => {
  assert.equal(key(manifest('1.4.5'), lock('1.4.5')), key(manifest('1.4.6'), lock('1.4.6')));
});

test('a dependency, a registry crate or a checksum change moves the key', () => {
  const base = key(manifest('1.4.5'), lock('1.4.5'));
  assert.notEqual(base, key(manifest('1.4.5', '2.0.0'), lock('1.4.5')));
  assert.notEqual(base, key(manifest('1.4.5'), lock('1.4.5', '1.0.1')));
  assert.notEqual(base, key(manifest('1.4.5'), lock('1.4.5', '1.0.0', '11')));
});
