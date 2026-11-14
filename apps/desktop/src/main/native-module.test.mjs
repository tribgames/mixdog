import assert from 'node:assert/strict';
import test from 'node:test';

import { cargoLibraryFile, loadNativeModule, loadWindowModule, nativeModulePath } from './native-module.ts';

test('mixdog_window.node is opened once per file and shared; a file that fails to open is tried again at the next call', (t) => {
  const opened = [];
  const dlopen = process.dlopen;
  t.after(() => {
    process.dlopen = dlopen;
  });
  process.dlopen = (module, library) => {
    opened.push(library);
    if (library.includes('missing')) throw new Error(`cannot open ${library}`);
    module.exports = { library };
  };
  const first = loadWindowModule('C:/shared/mixdog_window.node');
  assert.equal(loadWindowModule('C:/shared/mixdog_window.node'), first);
  assert.deepEqual(first, { library: 'C:/shared/mixdog_window.node' });
  assert.notEqual(loadWindowModule('C:/other/mixdog_window.node'), first);
  assert.throws(() => loadWindowModule('C:/missing/mixdog_window.node'), /cannot open/);
  assert.throws(() => loadWindowModule('C:/missing/mixdog_window.node'), /cannot open/);
  assert.deepEqual(opened, [
    'C:/shared/mixdog_window.node',
    'C:/other/mixdog_window.node',
    'C:/missing/mixdog_window.node',
    'C:/missing/mixdog_window.node',
  ]);
});

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
