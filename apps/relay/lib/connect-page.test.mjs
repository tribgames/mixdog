import assert from 'node:assert/strict';
import test from 'node:test';

import { sendAppPage } from './app-page.mjs';
import { LOGO_SRC, sendConnectPage } from './connect-page.mjs';

const capture = (send) => {
  const result = { headers: {}, body: '' };
  send(
    { method: 'GET', url: '/' },
    {
      writeHead: (_status, headers) => {
        result.headers = headers;
        return { end: (html) => (result.body = html) };
      },
    }
  );
  return result;
};

for (const [name, send] of [
  ['/connect', sendConnectPage],
  ['/app', sendAppPage],
]) {
  test(`${name} carries its logo inline, not from a relay-root asset`, () => {
    const { headers, body } = capture(send);
    assert.ok(LOGO_SRC.startsWith('data:image/svg+xml,%3Csvg'));
    assert.ok(body.includes(`<img class="mxp-logo" src="${LOGO_SRC}"`));
    assert.doesNotMatch(body, /src="\/mixdog-logo-titanium\.svg"/);
    assert.match(headers['Content-Security-Policy'], /img-src data:;/);
    assert.equal(decodeURIComponent(LOGO_SRC.split(',')[1]).includes('<svg'), true);
  });
}
