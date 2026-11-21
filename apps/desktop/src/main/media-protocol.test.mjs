import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url: 'data:text/javascript,export const protocol={handle:(scheme,fn)=>{globalThis.__mediaHandler=fn;},registerSchemesAsPrivileged(){}};',
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});

const { registerMediaProtocol } = await import('./media-protocol.ts');
const { registerFilePreview } = await import('./file-preview.ts');

const dir = mkdtempSync(join(tmpdir(), 'mixdog-media-protocol-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function serve(path) {
  const calls = [];
  registerMediaProtocol({
    invokeCapability: async (capability, args) => {
      calls.push([capability, args]);
      return { value: path ? { path, mime: 'image/png' } : null };
    },
  });
  return {
    calls,
    fetch: (url, init = {}) => globalThis.__mediaHandler({ url, method: 'GET', headers: new Headers(init.headers) }),
  };
}

test('an asset URL streams the resolved file, with byte ranges', async () => {
  const file = join(dir, 'a.png');
  writeFileSync(file, '0123456789');
  const { calls, fetch } = serve(file);
  const id = 'abcdef12-3456';
  const full = await fetch(`mixdog-media://asset/${id}?variant=thumb`);
  assert.equal(full.status, 200);
  assert.equal(await full.text(), '0123456789');
  assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(calls[0], ['resolveMediaFile', [id, { variant: 'thumb', generate: false }]]);
  const ranged = await fetch(`mixdog-media://asset/${id}?variant=thumb`, { headers: { range: 'bytes=2-4' } });
  assert.equal(ranged.status, 206);
  assert.equal(await ranged.text(), '234');
});

test('unknown hosts, malformed ids, unresolved assets and unknown preview tokens answer 404', async () => {
  const { fetch } = serve(null);
  for (const url of [
    'mixdog-media://other/abcdef12-3456',
    'mixdog-media://asset/zz',
    'mixdog-media://asset/abcdef12-3456',
    'mixdog-media://preview/00000000-0000-0000-0000-000000000000/x.png',
  ]) {
    assert.equal((await fetch(url)).status, 404, url);
  }
});

test('a registered file preview is served by its token', async () => {
  const file = join(dir, 'p.png');
  writeFileSync(file, 'PNGDATA');
  const preview = registerFilePreview(file);
  const { calls, fetch } = serve(null);
  const response = await fetch(preview.url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'PNGDATA');
  assert.equal(calls.length, 0);
});
