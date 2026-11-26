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
          url:
            'data:text/javascript,' +
            encodeURIComponent(`
              export const protocol = {
                handle: (scheme, fn) => {
                  globalThis.__mediaHandler = fn;
                },
                registerSchemesAsPrivileged() {},
              };
              export const session = {
                defaultSession: {
                  protocol,
                  webRequest: {
                    onBeforeSendHeaders: (filter, fn) => {
                      globalThis.__mediaBeforeSend = { filter, fn };
                    },
                  },
                },
              };
            `),
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});

const { registerMediaProtocol } = await import('./media-protocol.ts');
const { registerFilePreview } = await import('./file-preview.ts');

const dir = mkdtempSync(join(tmpdir(), 'mixdog-media-protocol-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function serve(path, options) {
  const calls = [];
  globalThis.__mediaBeforeSend = null;
  registerMediaProtocol(
    {
      invokeCapability: async (capability, args) => {
        calls.push([capability, args]);
        return { value: path ? { path, mime: 'image/png' } : null };
      },
    },
    options
  );
  const beforeSend = (url, details = {}) => {
    const hook = globalThis.__mediaBeforeSend;
    let headers = { ...(details.headers ?? {}) };
    if (hook && hook.filter?.urls?.some((pattern) => url.startsWith(pattern.replace(/\*$/, '')))) {
      hook.fn(
        {
          url,
          method: 'GET',
          resourceType: details.resourceType ?? 'image',
          referrer: details.referrer ?? '',
          webContentsId: details.webContentsId,
          frame: details.frame ?? null,
          requestHeaders: headers,
        },
        (result) => {
          if (result?.requestHeaders) headers = result.requestHeaders;
        }
      );
    }
    return headers;
  };
  return {
    calls,
    beforeSend,
    fetch: (url, init = {}) =>
      globalThis.__mediaHandler({
        url,
        method: 'GET',
        referrer: init.referrer ?? '',
        headers: new Headers(init.headers),
      }),
    request: (url, details = {}) => {
      const headers = beforeSend(url, details);
      return globalThis.__mediaHandler({
        url,
        method: 'GET',
        referrer: details.referrer ?? '',
        headers: new Headers(headers),
      });
    },
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

test('encrypted browser page thumbnails are decrypted only for trusted desktop shell requests with a valid capability token', async () => {
  const { createDiskPageThumbnailStorage } = await import('./browser/page-thumbnail-disk.ts');
  const thumbDir = join(dir, 'page-thumbs');
  const storage = createDiskPageThumbnailStorage(thumbDir, {
    encrypt: async (text) => Buffer.from(`sealed:${text}`),
    decrypt: async (data) => {
      const text = data.toString();
      return text.startsWith('sealed:') ? text.slice(7) : null;
    },
  });
  const previousRendererUrl = process.env.ELECTRON_RENDERER_URL;
  const topFrame = (url) => ({ url, parent: null, isDestroyed: () => false });
  const subFrame = (url, parent) => ({ url, parent, isDestroyed: () => false });
  try {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03, 0x04]);
    const url = storage.put('https://example.test/page', `data:image/png;base64,${pngBytes.toString('base64')}`);
    assert.ok(url);
    const parsed = new URL(url);
    assert.ok(parsed.searchParams.get('t'), 'thumbnail URL carries a per-instance capability token');

    const shellWebContentsId = 101;
    const petWebContentsId = 202;
    const { beforeSend, fetch, request } = serve(null, {
      isShellWebContents: (id) => id === shellWebContentsId,
    });
    const packagedShell = topFrame('file:///C:/Program%20Files/Mixdog/resources/app.asar/out/renderer/index.html');
    const desktopPet = topFrame('file:///C:/Program%20Files/Mixdog/resources/app.asar/out/renderer/desktop-pet.html');

    // Genuine packaged Electron shell image load (no Origin/Referer on file:// -> custom scheme) succeeds.
    const packagedResponse = await request(url, {
      webContentsId: shellWebContentsId,
      frame: packagedShell,
      resourceType: 'image',
    });
    assert.equal(packagedResponse.status, 200);
    assert.equal(packagedResponse.headers.get('content-type'), 'image/png');
    assert.equal(packagedResponse.headers.get('access-control-allow-origin'), null, 'no wildcard ACAO on page-thumb');
    assert.equal(
      packagedResponse.headers.get('cross-origin-resource-policy'),
      null,
      'no cross-origin CORP on page-thumb'
    );
    assert.deepEqual(Buffer.from(await packagedResponse.arrayBuffer()), pngBytes);

    // Non-shell top-level file: windows (e.g. desktop-pet.html) and requests without a shell webContentsId are denied.
    const desktopPetResponse = await request(url, {
      webContentsId: petWebContentsId,
      frame: desktopPet,
      resourceType: 'image',
    });
    assert.equal(desktopPetResponse.status, 403, 'non-shell top-level file: window (desktop-pet.html) is rejected');

    const missingWebContentsResponse = await request(url, {
      frame: packagedShell,
      resourceType: 'image',
    });
    assert.equal(missingWebContentsResponse.status, 403, 'request without webContentsId is rejected');

    // Genuine dev-server Electron shell image load succeeds when ELECTRON_RENDERER_URL matches.
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173';
    const devShell = topFrame('http://localhost:5173/index.html');
    const devResponse = await request(url, {
      webContentsId: shellWebContentsId,
      frame: devShell,
      resourceType: 'image',
      referrer: 'http://localhost:5173/',
    });
    assert.equal(devResponse.status, 200);
    assert.deepEqual(Buffer.from(await devResponse.arrayBuffer()), pngBytes);

    // Non-shell window in dev mode (e.g. desktop-pet.html served from dev origin) is still denied.
    const devPetResponse = await request(url, {
      webContentsId: petWebContentsId,
      frame: topFrame('http://localhost:5173/desktop-pet.html'),
      resourceType: 'image',
      referrer: 'http://localhost:5173/',
    });
    assert.equal(devPetResponse.status, 403, 'non-shell dev-origin window is rejected');

    // Requests lacking trusted requester proof (e.g. no Origin and no Referer) are rejected with 403.
    const bareNoProof = await fetch(url, { headers: { 'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors' } });
    assert.equal(bareNoProof.status, 403, 'no-origin/no-referer request without trusted shell proof is rejected');

    const forgedProof = await fetch(url, {
      headers: { 'x-mixdog-page-thumb-proof': '0'.repeat(32), 'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors' },
    });
    assert.equal(forgedProof.status, 403, 'forged proof header is rejected');

    // Untrusted Visualize iframe with no-referrer/no-origin is rejected even inside the shell webContents.
    const visualizeNoReferrerImg = await request(url, {
      webContentsId: shellWebContentsId,
      frame: subFrame('http://127.0.0.1:4100/lease-abc/index.html', packagedShell),
      resourceType: 'image',
      referrer: '',
    });
    assert.equal(visualizeNoReferrerImg.status, 403, 'Visualize no-referrer img load is rejected');

    // Subframes inside the packaged shell (including srcdoc/file subframes) are rejected.
    const srcdocImg = await request(url, {
      webContentsId: shellWebContentsId,
      frame: subFrame('about:srcdoc', packagedShell),
      resourceType: 'image',
    });
    assert.equal(srcdocImg.status, 403, 'srcdoc iframe img load is rejected');

    const previewOriginImg = await request(url, {
      webContentsId: shellWebContentsId,
      frame: topFrame('mixdog-media://preview/00000000-0000-0000-0000-000000000000/report.html'),
      resourceType: 'image',
    });
    assert.equal(previewOriginImg.status, 403, 'preview document origin is not trusted for page-thumb');

    // onBeforeSendHeaders strips caller-supplied proof headers regardless of casing on untrusted requests,
    // even if a caller supplies the live proof value.
    const liveProof = beforeSend(url, {
      webContentsId: shellWebContentsId,
      frame: packagedShell,
      resourceType: 'image',
    })['x-mixdog-page-thumb-proof'];
    assert.ok(liveProof, 'trusted shell image load receives proof header');

    const strippedMixedCase = beforeSend(url, {
      webContentsId: shellWebContentsId,
      frame: subFrame('http://127.0.0.1:4100/lease-abc/index.html', packagedShell),
      resourceType: 'xhr',
      headers: {
        Accept: 'image/png',
        origin: 'http://127.0.0.1:4100',
        referer: 'http://127.0.0.1:4100/lease-abc/index.html',
        'X-Mixdog-Page-Thumb-Proof': liveProof,
        'x-mixdog-page-thumb-proof': liveProof,
        'X-MIXDOG-PAGE-THUMB-PROOF': liveProof,
      },
    });
    assert.deepEqual(
      Object.keys(strippedMixedCase).filter((k) => k.toLowerCase() === 'x-mixdog-page-thumb-proof'),
      [],
      'onBeforeSendHeaders strips all proof header casing variants on untrusted requests'
    );
    assert.equal(strippedMixedCase.Accept, 'image/png', 'unrelated request headers are preserved');

    const visualizeFetch = await request(url, {
      webContentsId: shellWebContentsId,
      frame: subFrame('http://127.0.0.1:4100/lease-abc/index.html', packagedShell),
      resourceType: 'xhr',
      headers: {
        origin: 'http://127.0.0.1:4100',
        referer: 'http://127.0.0.1:4100/lease-abc/index.html',
        'X-Mixdog-Page-Thumb-Proof': liveProof,
      },
    });
    assert.equal(visualizeFetch.status, 403, 'Visualize origin cannot fetch browser page thumbnails');

    const sandboxedFetch = await fetch(url, { headers: { origin: 'null' } });
    assert.equal(sandboxedFetch.status, 403, 'opaque/sandboxed Origin: null is rejected');

    // Non-image requests (navigation, xhr) are rejected even from the top-level shell frame.
    const navAttempt = await request(url, {
      webContentsId: shellWebContentsId,
      frame: packagedShell,
      resourceType: 'mainFrame',
      headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    });
    assert.equal(navAttempt.status, 403, 'navigation/document requests to page-thumb are rejected');

    const xhrAttempt = await request(url, {
      webContentsId: shellWebContentsId,
      frame: packagedShell,
      resourceType: 'xhr',
    });
    assert.equal(xhrAttempt.status, 403, 'non-image XHR/fetch requests to page-thumb are rejected');

    // Capability token is still required even for a trusted desktop shell image load.
    const withoutToken = new URL(url);
    withoutToken.searchParams.delete('t');
    assert.equal(
      (
        await request(withoutToken.href, {
          webContentsId: shellWebContentsId,
          frame: packagedShell,
          resourceType: 'image',
        })
      ).status,
      403,
      'missing capability token is rejected'
    );

    const wrongToken = new URL(url);
    wrongToken.searchParams.set('t', '0'.repeat(32));
    assert.equal(
      (
        await request(wrongToken.href, {
          webContentsId: shellWebContentsId,
          frame: packagedShell,
          resourceType: 'image',
        })
      ).status,
      404,
      'wrong capability token is rejected'
    );

    // Registering without isShellWebContents fails closed for page-thumb requests.
    const failClosed = serve(null);
    assert.equal(
      (
        await failClosed.request(url, {
          webContentsId: shellWebContentsId,
          frame: packagedShell,
          resourceType: 'image',
        })
      ).status,
      403,
      'omitted isShellWebContents defaults fail-closed'
    );
  } finally {
    if (previousRendererUrl === undefined) delete process.env.ELECTRON_RENDERER_URL;
    else process.env.ELECTRON_RENDERER_URL = previousRendererUrl;
    storage.dispose();
  }
});
