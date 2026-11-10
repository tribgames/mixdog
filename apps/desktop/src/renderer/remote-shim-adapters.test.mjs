// The phone's adapter list as the bundle builds it: remote-shim-adapters.ts loaded through Vite, whose transform expands its
// `import.meta.glob` exactly as the phone bundle's build does, so every module the glob finds is loaded and must be an adapter.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';
import { adaptersOf } from './remote-shim-adapters.ts';

test('every module the bundle\'s glob finds is a phone adapter, in file-name order', async () => {
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('.', import.meta.url)),
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { bundledPhoneAdapters } = await server.ssrLoadModule('/remote-shim-adapters.ts');
    const adapters = bundledPhoneAdapters();
    assert.deepEqual(adapters.map((adapter) => adapter.group), ['chat', 'files']);
    for (const adapter of adapters) assert.ok(Object.keys(adapter.calls).length > 0, `${adapter.group}: answers calls`);
  } finally {
    await server.close();
  }
});

test('a module the glob finds without an adapter fails by its path, not at the router\'s first call', () => {
  const files = { group: 'files', calls: { listFiles() {} } };
  assert.throws(() => adaptersOf({ './remote-protocol-files.ts': { adapter: files }, './remote-protocol-helper.ts': {} }), /\.\/remote-protocol-helper\.ts exports no phone adapter/);
  assert.deepEqual(adaptersOf({ './remote-protocol-files.ts': { adapter: files } }), [files]);
});
