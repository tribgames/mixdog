import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoreFileGrants } from './core-file-grants.ts';
import { isLocalAccessDenied, LocalAccessDeniedError } from './local-access-denied.ts';

function fake(reply) {
  const calls = [];
  const invoke = async (name, args) => {
    calls.push({ name, args });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { calls, grants: createCoreFileGrants(invoke) };
}

test('describe sends the paths and mint, defaulting to a grant', async () => {
  const rows = [{ absolutePath: 'C:/a', name: 'a', dir: false, size: 1 }];
  const { calls, grants } = fake(rows);
  assert.deepEqual(await grants.describe(['C:/a']), rows);
  await grants.describe(['C:/a'], false);
  assert.deepEqual(calls, [
    { name: 'grantDescribe', args: [['C:/a'], true] },
    { name: 'grantDescribe', args: [['C:/a'], false] },
  ]);
});

test('describe refuses a bad paths list before calling the core', async () => {
  const { calls, grants } = fake([]);
  for (const bad of [undefined, 'x', [], Array.from({ length: 101 }, () => 'p')]) {
    await assert.rejects(grants.describe(bad), { name: 'TypeError', message: 'paths are invalid.' });
  }
  assert.equal(calls.length, 0);
});

test('requireGrant validates and sends token, project and relative path', async () => {
  const reply = { root: 'C:/d', rel: 'f', absolute: 'C:/d/f' };
  const { calls, grants } = fake(reply);
  assert.deepEqual(await grants.requireGrant('tok', 'C:/d', 'f'), reply);
  assert.deepEqual(calls, [{ name: 'grantRedeem', args: ['tok', 'C:/d', 'f'] }]);
  await assert.rejects(grants.requireGrant('x'.repeat(129), 'C:/d', 'f'), TypeError);
  await assert.rejects(grants.requireGrant('tok', '', 'f'), TypeError);
  assert.equal(calls.length, 1);
});

test('a refusal carrying a denial code becomes a LocalAccessDeniedError with that code', async () => {
  for (const code of ['SELECTED_FILE_GRANT_UNAVAILABLE', 'MIXDOG_LOCAL_ACCESS_DENIED', 'PROJECT_UNAVAILABLE']) {
    const { grants } = fake(Object.assign(new Error('refused'), { code }));
    await assert.rejects(grants.requireGrant('t', 'p', 'r'), (error) => {
      assert.ok(error instanceof LocalAccessDeniedError);
      assert.equal(error.code, code);
      assert.equal(error.message, 'refused');
      assert.equal(isLocalAccessDenied(error), true);
      return true;
    });
  }
});

test('an error that is not a denial passes through unchanged', async () => {
  for (const original of [new Error('boom'), Object.assign(new Error('io'), { code: 'EACCES' })]) {
    const { grants } = fake(original);
    await assert.rejects(grants.describe(['p']), (error) => error === original);
  }
});
