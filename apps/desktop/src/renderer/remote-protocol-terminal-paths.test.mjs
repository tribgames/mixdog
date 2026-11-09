// How the phone resolves a folder path for a watch: with the rules of the host the files are on (which the host reports), never from how the
// path is spelled. The expected values are Node's own `path.win32` / `path.posix` run here, for each class of input; and the adapter's
// calls, for one spelling on a Windows host and on a POSIX host.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { adapter } from './remote-protocol-terminal.ts';
import { hostPlatformOf, isAbsoluteOn, needsHostDevice, resolveOn } from '../shared/remote-arguments.ts';

const CLASSES = [
  'relative/dir', 'C:foo', 'C:', '/dir', '\\dir', '/dir/../x/', '//server', '//server/share', '\\\\server\\share\\a\\..\\b\\', 'C:\\a\\b\\..\\c\\',
  'c:/A/B/', '\\\\?\\C:\\x\\y', '\\\\.\\C:\\x', '\\\\?\\UNC\\srv\\sh\\a', 'C:\\a\\', 'C:\\', 'C:\\..', '//?/C:/x', '/', '\\', '//', '//tmp/Mixed/',
  '/a/./b//c', 'D:\\x\\.\\y',
];

test('a Windows host resolves each class of path as path.win32 does, the working directory being on the host', () => {
  for (const [base, device] of [['D:\\base', 'D:'], ['\\\\srv\\sh\\base', '\\\\srv\\sh']]) {
    for (const text of CLASSES) {
      assert.equal(isAbsoluteOn('windows', text), path.win32.isAbsolute(text), `isAbsolute ${text}`);
      if (!path.win32.isAbsolute(text)) continue;
      assert.equal(resolveOn('windows', text, device), path.win32.resolve(base, text), `resolve ${text} from ${base}`);
    }
  }
});

test('a POSIX host resolves each class of path as path.posix does', () => {
  for (const text of CLASSES) {
    assert.equal(isAbsoluteOn('posix', text), path.posix.isAbsolute(text), `isAbsolute ${text}`);
    if (!path.posix.isAbsolute(text)) continue;
    assert.equal(resolveOn('posix', text, ''), path.posix.resolve('/base', text), `resolve ${text}`);
    assert.equal(needsHostDevice('posix', text), false);
  }
});

test('only a rooted Windows path takes its device from the working directory', () => {
  // Node says which: the answer depends on the working directory's device exactly when two working directories give two answers.
  for (const text of CLASSES.filter((one) => path.win32.isAbsolute(one))) {
    const dependsOnCwd = path.win32.resolve('D:\\base', text) !== path.win32.resolve('E:\\base', text);
    assert.equal(needsHostDevice('windows', text), dependsOnCwd, text);
  }
});

test('the platform comes from what the host reports', () => {
  assert.equal(hostPlatformOf('windows'), 'windows');
  for (const other of ['linux', 'macos', undefined, '']) assert.equal(hostPlatformOf(other), 'posix');
});

/** A phone host whose core reports `platformOs` and answers the calls the adapter makes; `calls` lists them. */
function host(platformOs) {
  const calls = [];
  const client = {
    server: { platformOs },
    call: async (method, params) => {
      calls.push([method, params]);
      return method === 'projectFs/statLocal' ? [{ absolutePath: 'D:\\' }] : {};
    },
  };
  return { host: { ctx: {}, client: () => client }, calls };
}
const released = (calls) => calls.filter(([method]) => method === 'fs/unwatch').length;

test('one spelling is a rooted path on a Windows host and an ordinary one on a POSIX host', async () => {
  const win = host('windows');
  await adapter.calls.folderWatch(['/tmp/Mixed/', true], win.host);
  const watched = win.calls.find(([method]) => method === 'fs/watch');
  assert.equal(watched[1].path, 'D:\\tmp\\Mixed', 'resolved onto the working directory\'s drive');
  await adapter.calls.folderUnwatch(['d:\\TMP\\mixed\\.', true], win.host);
  assert.equal(released(win.calls), 1, 'the Windows registry folds case and resolves the path');

  const posix = host('linux');
  await adapter.calls.folderWatch(['/tmp/Mixed/', true], posix.host);
  assert.equal(posix.calls.find(([method]) => method === 'fs/watch')[1].path, '/tmp/Mixed');
  assert.equal(posix.calls.some(([method]) => method === 'projectFs/statLocal'), false, 'a POSIX path needs no device');
  await adapter.calls.folderUnwatch(['/tmp/mixed', true], posix.host);
  assert.equal(released(posix.calls), 0, 'a POSIX registry is case-sensitive');
  await adapter.calls.folderUnwatch(['//tmp/./Mixed/', true], posix.host);
  assert.equal(released(posix.calls), 1);
});