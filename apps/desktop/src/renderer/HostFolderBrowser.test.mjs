import assert from 'node:assert/strict';
import test from 'node:test';
import { joinHostPath, parentHostPath } from './HostFolderBrowser.tsx';

test('parentHostPath walks up POSIX and Windows paths and stops at roots', () => {
  assert.equal(parentHostPath('/home/me/app'), '/home/me');
  assert.equal(parentHostPath('/home'), '/');
  assert.equal(parentHostPath('/'), null);
  assert.equal(parentHostPath('C:\\Users\\me\\app'), 'C:\\Users\\me');
  assert.equal(parentHostPath('C:\\Users'), 'C:\\');
  assert.equal(parentHostPath('C:\\'), null);
});

test('joinHostPath keeps the base separator style', () => {
  assert.equal(joinHostPath('/home/me', 'app'), '/home/me/app');
  assert.equal(joinHostPath('/', 'etc'), '/etc');
  assert.equal(joinHostPath('C:\\Users', 'me'), 'C:\\Users\\me');
  assert.equal(joinHostPath('C:\\', 'Users'), 'C:\\Users');
});
