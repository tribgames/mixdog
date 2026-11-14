import assert from 'node:assert/strict';
import test from 'node:test';

import { cargoLibraryFile, loadNativeModule, nativeModulePath } from './native-module.ts';

test('cargo names the library of a crate by the platform', () => {
  assert.equal(cargoLibraryFile('mixdog_main_native', 'win32'), 'mixdog_main_native.dll');
  assert.equal(cargoLibraryFile('mixdog_main_native', 'darwin'), 'libmixdog_main_native.dylib');
  assert.equal(cargoLibraryFile('mixdog_main_native', 'linux'), 'libmixdog_main_native.so');
});

test('a module that is not built is a fatal error naming the file, raised at the first call and not before', () => {
  const spec = {
    crate: 'mixdog-no-such-crate',
    packagedFile: 'mixdog_no_such.node',
    builtFile: (platform) => cargoLibraryFile('mixdog_no_such', platform),
    check() {},
  };
  assert.match(nativeModulePath(spec), /mixdog_no_such/);
  assert.throws(() => loadNativeModule(spec), /mixdog_no_such\.node could not be loaded from .*mixdog_no_such/);
});
