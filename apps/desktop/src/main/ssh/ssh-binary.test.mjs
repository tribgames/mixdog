import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSshMissingMessage, resolveSshTool } from './ssh-binary.ts';

const withFiles = (files, platform, env) => ({ platform, env, isFile: (path) => files.includes(path) });

test('Windows looks on PATH first, then in System32\\OpenSSH', () => {
  const env = { Path: 'C:\\Tools;"C:\\Program Files\\OpenSSH"', SystemRoot: 'C:\\Windows' };
  assert.equal(
    resolveSshTool(
      'ssh',
      withFiles(['C:\\Program Files\\OpenSSH\\ssh.exe', 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'], 'win32', env)
    ),
    'C:\\Program Files\\OpenSSH\\ssh.exe'
  );
  for (const tool of ['ssh', 'ssh-keygen', 'ssh-keyscan', 'ssh-add']) {
    assert.equal(
      resolveSshTool(
        tool,
        withFiles([`C:\\Windows\\System32\\OpenSSH\\${tool}.exe`], 'win32', {
          Path: 'C:\\Tools',
          SystemRoot: 'C:\\Windows',
        })
      ),
      `C:\\Windows\\System32\\OpenSSH\\${tool}.exe`
    );
  }
  assert.equal(resolveSshTool('ssh', withFiles([], 'win32', { Path: 'C:\\Tools', SystemRoot: 'C:\\Windows' })), null);
});

test('a profile or install folder with spaces or non-ASCII characters is returned as one path', () => {
  const path = 'D:\\도구 모음\\Open SSH\\ssh-keygen.exe';
  assert.equal(resolveSshTool('ssh-keygen', withFiles([path], 'win32', { Path: 'D:\\도구 모음\\Open SSH' })), path);
});

test('macOS and Linux use PATH only', () => {
  assert.equal(resolveSshTool('ssh', withFiles(['/usr/bin/ssh'], 'linux', { PATH: '/bin:/usr/bin' })), '/usr/bin/ssh');
  assert.equal(resolveSshTool('ssh', withFiles(['/opt/x/ssh'], 'darwin', { PATH: '/usr/bin' })), null);
});

test('the missing-client message is recognised and has the capability command', () => {
  assert.equal(isSshMissingMessage('The OpenSSH client (ssh-keyscan) was not found on PATH.'), true);
  assert.equal(isSshMissingMessage('Permission denied'), false);
});
