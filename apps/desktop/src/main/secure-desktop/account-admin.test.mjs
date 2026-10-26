import assert from 'node:assert/strict';
import test from 'node:test';

import { createAccountAdminCheck, groupsListAdministrators } from './account-admin.ts';

// `whoami /groups /fo csv /nh`: name, type, SID, attributes (which hold commas).
const row = (name, sid, attributes) => `"${name}","Alias","${sid}","${attributes}"`;
const EVERYONE = row('Everyone', 'S-1-1-0', 'Mandatory group, Enabled by default, Enabled group');
const USERS = row('BUILTIN\\Users', 'S-1-5-32-545', 'Mandatory group, Enabled by default, Enabled group');
const ADMINS_ENABLED = row(
  'BUILTIN\\Administrators',
  'S-1-5-32-544',
  'Mandatory group, Enabled by default, Enabled group, Group owner'
);
// A UAC-filtered token of an administrator still lists the group, for deny only.
const ADMINS_FILTERED = row('BUILTIN\\Administrators', 'S-1-5-32-544', 'Group used for deny only');

const crlf = (...rows) => `${rows.join('\r\n')}\r\n`;

test('an Administrators group in the token (enabled or for deny only) is an administrator account; a standard account is not', () => {
  // English administrator, elevated: the group is enabled.
  assert.equal(groupsListAdministrators(crlf(EVERYONE, USERS, ADMINS_ENABLED)), true);
  // The same administrator under UAC (filtered token): "for deny only" still counts.
  assert.equal(groupsListAdministrators(crlf(EVERYONE, ADMINS_FILTERED, USERS)), true);
  // A standard account.
  assert.equal(groupsListAdministrators(crlf(EVERYONE, USERS)), false);
});

test('the group is found by its SID, whatever Windows calls it', () => {
  // German and Korean Windows rename the group (and its attribute text).
  const german = crlf(
    row('Jeder', 'S-1-1-0', 'Obligatorische Gruppe, Standardmäßig aktiviert, Aktivierte Gruppe'),
    row('VORDEFINIERT\\Administratoren', 'S-1-5-32-544', 'Gruppe wird nur für Deny verwendet')
  );
  const korean = crlf(
    row('Everyone', 'S-1-1-0', '필수 그룹, 기본적으로 활성화됨, 활성화된 그룹'),
    row('BUILTIN\\관리자', 'S-1-5-32-544', '거부 전용 그룹')
  );
  assert.equal(groupsListAdministrators(german), true);
  assert.equal(groupsListAdministrators(korean), true);
  // A name that says Administrators is nothing without the SID; a longer SID is another group.
  assert.equal(groupsListAdministrators(crlf(EVERYONE, row('BUILTIN\\Administrators', 'S-1-5-32-545', 'x'))), false);
  assert.equal(groupsListAdministrators(crlf(EVERYONE, row('X', 'S-1-5-32-5440', 'x'))), false);
  assert.equal(groupsListAdministrators(crlf(EVERYONE, row('BUILTIN\\Administratoren', 's-1-5-32-544', 'x'))), true);
});

test('output that is not a group list is not known, never "not an administrator"', () => {
  for (const garbage of [
    '',
    '\r\n',
    'ERROR: Access is denied.',
    'INFO: could not find any matches',
    '<html>"S-1-5-32-544"</html>',
  ]) {
    assert.equal(groupsListAdministrators(garbage), null, JSON.stringify(garbage));
  }
});

test('the check is read once per run; a failed read is not kept and answers unknown', async () => {
  let reads = 0;
  const check = createAccountAdminCheck(async () => {
    reads += 1;
    return `${EVERYONE}\r\n${ADMINS_FILTERED}\r\n`;
  });
  assert.deepEqual([await check(), await check()], [true, true]);
  assert.equal(reads, 1);

  let fail = true;
  const flaky = createAccountAdminCheck(async () => {
    if (fail) throw new Error('whoami missing');
    return `${EVERYONE}\r\n${USERS}\r\n`;
  });
  assert.equal(await flaky(), null);
  fail = false;
  assert.equal(await flaky(), false, 'asked again');

  // Unparseable output is unknown too (not false), and not kept.
  let output = 'ERROR: nope';
  const garbled = createAccountAdminCheck(async () => output);
  assert.equal(await garbled(), null);
  output = `${EVERYONE}\r\n${ADMINS_FILTERED}\r\n`;
  assert.equal(await garbled(), true);
});
