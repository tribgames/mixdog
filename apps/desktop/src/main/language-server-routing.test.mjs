import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { LanguageServerRouter } from './language-server-routing.ts';

function routerWith(sendRequest, { supported = true } = {}) {
  const spec = { name: 'fake-ls' };
  const session = { baseCapabilities: {}, registrations: new Map(), connection: { sendRequest } };
  const idle = [];
  const router = new LanguageServerRouter(
    { specFor: async () => spec, state: () => undefined },
    { ensure: async () => session, scheduleIdle: (target) => idle.push(target) },
    {
      capabilitiesWithDynamicRegistrations: (capabilities) => capabilities,
      methodSupported: () => supported,
      languageServerRequestParams: (uri, _method, params) => ({ ...params, uri }),
      withTimeout: (promise) => promise,
      lspDocumentLanguageId: (_relPath, languageId) => languageId,
    }
  );
  return { router, session, idle };
}

const request = (router) => router.request(tmpdir(), tmpdir(), 'file.ts', 'typescript', 'textDocument/hover', {});

test('a request re-arms idle shutdown after it succeeds, fails or is unsupported', async () => {
  const ok = routerWith(async () => ({ contents: 'hi' }));
  assert.equal((await request(ok.router)).status, 'ready');
  assert.deepEqual(ok.idle, [ok.session]);

  const failed = routerWith(async () => {
    throw new Error('server error');
  });
  assert.equal((await request(failed.router)).status, 'error');
  assert.deepEqual(failed.idle, [failed.session]);

  const unsupported = routerWith(async () => null, { supported: false });
  assert.equal((await request(unsupported.router)).status, 'ready');
  assert.deepEqual(unsupported.idle, [unsupported.session]);
});
