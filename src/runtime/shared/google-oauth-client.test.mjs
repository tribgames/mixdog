import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { GOOGLE_AUTH_PARAMS, GOOGLE_OAUTH_CLIENT_FILE, googleOAuthClient } from './google-oauth-client.mjs';

async function clientFile(t, content) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-google-client-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'google-oauth-client.generated.json');
  if (content !== undefined) await writeFile(file, content);
  return file;
}

const EMBEDDED = JSON.stringify({ clientId: 'embedded.apps.googleusercontent.com', clientSecret: 'GOCSPX-embedded' });

test('the generated file supplies the client when the environment has none', async (t) => {
  const file = await clientFile(t, EMBEDDED);
  assert.deepEqual(googleOAuthClient({ env: {}, file }), {
    clientId: 'embedded.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-embedded',
  });
  assert.equal(
    googleOAuthClient({ env: { MIXDOG_GOOGLE_OAUTH_CLIENT_ID: '  ' }, file }).clientId,
    'embedded.apps.googleusercontent.com',
    'a blank environment id falls through to the generated file'
  );
});

test('the environment wins over the generated file and is never mixed with it', async (t) => {
  const file = await clientFile(t, EMBEDDED);
  const env = {
    MIXDOG_GOOGLE_OAUTH_CLIENT_ID: ' env.apps.googleusercontent.com ',
    MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET: ' GOCSPX-env ',
  };
  assert.deepEqual(googleOAuthClient({ env, file }), {
    clientId: 'env.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-env',
  });
  const idOnly = { MIXDOG_GOOGLE_OAUTH_CLIENT_ID: 'env.apps.googleusercontent.com' };
  assert.deepEqual(googleOAuthClient({ env: idOnly, file }), {
    clientId: 'env.apps.googleusercontent.com',
    clientSecret: '',
  });
});

test('a build with neither environment nor generated file has no client', async (t) => {
  assert.equal(googleOAuthClient({ env: {}, file: await clientFile(t) }), null);
  assert.equal(googleOAuthClient({ env: {}, file: await clientFile(t, JSON.stringify({ clientSecret: 'x' })) }), null);
  assert.equal(googleOAuthClient({ env: {}, file: await clientFile(t, JSON.stringify({ clientId: ' ' })) }), null);
});

test('an unreadable generated file is an error, not a silent fallback', async (t) => {
  const file = await clientFile(t, '{');
  assert.throws(() => googleOAuthClient({ env: {}, file }), SyntaxError);
});

test('the default generated file sits beside the module and the default environment is the process one', () => {
  assert.equal(basename(GOOGLE_OAUTH_CLIENT_FILE), 'google-oauth-client.generated.json');
  const saved = process.env.MIXDOG_GOOGLE_OAUTH_CLIENT_ID;
  process.env.MIXDOG_GOOGLE_OAUTH_CLIENT_ID = 'process.apps.googleusercontent.com';
  try {
    assert.equal(googleOAuthClient().clientId, 'process.apps.googleusercontent.com');
  } finally {
    if (saved === undefined) delete process.env.MIXDOG_GOOGLE_OAUTH_CLIENT_ID;
    else process.env.MIXDOG_GOOGLE_OAUTH_CLIENT_ID = saved;
  }
});

test('Google sign-in asks for offline access so a refresh token is issued', () => {
  assert.deepEqual(GOOGLE_AUTH_PARAMS, { access_type: 'offline' });
});
