import assert from 'node:assert/strict';
import test from 'node:test';

import { registerDesktopNoticeSink } from '../../../shared/desktop-notice-host.mjs';
import { createAuthorizedFetch } from './oauth-request.mjs';
import { reauthenticationRequired } from './oauth-shared.mjs';

const URL_ = 'https://mcp.example.com/mcp';

/** One server whose stored token the server answers with `status()`, and
 *  whose renewal needs the user (a non-interactive login fails). */
function server(tokens, status) {
  const creds = { tokens, observed: 1 };
  const cache = {
    creds,
    ready: async () => {},
    observeStoredRevision: async () => {},
    update: async (change) => change(),
  };
  const fetchImpl = async () =>
    new Response('', { status: status(), headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' } });
  const login = () => Promise.reject(reauthenticationRequired());
  const { fetch } = createAuthorizedFetch({
    url: URL_,
    cache,
    login,
    fetchImpl,
    lifetimeSignal: new AbortController().signal,
  });
  return (name) =>
    fetch(
      URL_,
      {},
      () => false,
      undefined,
      () => true,
      name
    );
}

test('a stored connector sign-in the server refuses is told once until a request succeeds again', async (t) => {
  const notices = [];
  t.after(registerDesktopNoticeSink((notice) => notices.push(notice)));
  let status = 401;
  const request = server({ access_token: 'old' }, () => status);

  await assert.rejects(request('Gmail'), { code: 'reauthenticationRequired' });
  await assert.rejects(request('Gmail'), { code: 'reauthenticationRequired' });
  assert.deepEqual(notices, [
    { key: 'connector-sign-in:Gmail', code: 'connector-sign-in-expired', params: { name: 'Gmail' } },
  ]);

  status = 200;
  assert.equal((await request('Gmail')).status, 200);
  status = 401;
  await assert.rejects(request('Gmail'), { code: 'reauthenticationRequired' });
  assert.equal(notices.length, 2, 'told again after the sign-in had worked again');
});

test('a server error between two refusals is no working sign-in: the notice is not repeated', async (t) => {
  const notices = [];
  t.after(registerDesktopNoticeSink((notice) => notices.push(notice)));
  let status = 401;
  const request = server({ access_token: 'old' }, () => status);
  await assert.rejects(request('Drive'), { code: 'reauthenticationRequired' });
  status = 500;
  assert.equal((await request('Drive')).status, 500);
  status = 401;
  await assert.rejects(request('Drive'), { code: 'reauthenticationRequired' });
  assert.equal(notices.length, 1);
});

test('a server never signed in is no expired sign-in', async (t) => {
  const notices = [];
  t.after(registerDesktopNoticeSink((notice) => notices.push(notice)));
  const request = server(undefined, () => 401);
  await assert.rejects(request('Notion'), { code: 'reauthenticationRequired' });
  assert.deepEqual(notices, []);
});
