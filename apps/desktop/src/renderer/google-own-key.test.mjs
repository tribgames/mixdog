// "내 Google 키 사용": the client_secret_*.json is validated (fail closed) and
// the apply / revert calls reach Calendar and Drive only.
import assert from 'node:assert/strict';
import test from 'node:test';

const { parseGoogleClientJson, applyGoogleOwnKey, revertGoogleOwnKey } = await import('./google-own-key.ts');

const ID = '123-abc.apps.googleusercontent.com';

test('a Desktop client file yields its id and secret; anything else is rejected', () => {
  const file = (body) => JSON.stringify(body);
  assert.deepEqual(parseGoogleClientJson(file({ installed: { client_id: ID, client_secret: ' GOCSPX-x ' } })), {
    clientId: ID,
    clientSecret: 'GOCSPX-x',
  });
  assert.throws(() => parseGoogleClientJson('nope'), /not a JSON/);
  assert.throws(() => parseGoogleClientJson(file({ other: {} })), /Desktop app/);
  assert.throws(
    () =>
      parseGoogleClientJson(
        file({ web: { client_id: ID, client_secret: 's', redirect_uris: ['http://localhost:8080/cb'] } })
      ),
    /Desktop app/
  );
  assert.throws(
    () => parseGoogleClientJson(file({ installed: { client_id: 'plain', client_secret: 's' } })),
    /client_id/
  );
  assert.throws(() => parseGoogleClientJson(file({ installed: { client_id: ID } })), /client_secret/);
  assert.throws(() => parseGoogleClientJson('[]'), /Desktop app/);
});

function host(servers) {
  const calls = [];
  const invoke = async (capability, args = []) => {
    calls.push([capability, args]);
    return capability === 'mcpStatus' ? { servers } : undefined;
  };
  return { calls, invoke };
}

test('apply sets the key on Calendar and Drive only; revert clears it and drops unconnected servers', async () => {
  const { calls, invoke } = host([
    { name: 'gmail', connector: 'gmail' },
    { name: 'google-drive', connector: 'google-drive' },
  ]);
  await applyGoogleOwnKey(invoke, { clientId: ID, clientSecret: 'sec' });
  const writes = calls.filter(([c]) => c !== 'mcpStatus');
  assert.deepEqual(
    writes.map(([c, a]) => [c, a[0].connector ?? a[0].name ?? a[0]]),
    [
      ['addMcpServer', 'google-calendar'],
      ['signOutMcpServer', 'google-drive'],
      ['saveMcpServer', 'google-drive'],
    ]
  );
  for (const [c, a] of writes.filter(([c]) => c === 'saveMcpServer' || c === 'addMcpServer')) {
    assert.equal(a[0].oauthClientId, ID, c);
    assert.equal(a[0].oauthClientSecret, 'sec', c);
  }

  const back = host([
    { name: 'gmail', connector: 'gmail', connected: true },
    { name: 'google-calendar', connector: 'google-calendar', connected: false },
    { name: 'google-drive', connector: 'google-drive', connected: true },
  ]);
  await revertGoogleOwnKey(back.invoke);
  const saves = back.calls.filter(([c]) => c === 'saveMcpServer');
  assert.deepEqual(
    saves.map(([, a]) => a[0].name),
    ['google-drive']
  );
  for (const [, a] of saves) assert.equal(a[0].oauthClientId, '');
  assert.deepEqual(
    back.calls.filter(([c]) => c === 'removeMcpServer').map(([, a]) => a[0]),
    ['google-calendar']
  );
  assert.equal(back.calls.filter(([c]) => c === 'signOutMcpServer').length, 1);
});
