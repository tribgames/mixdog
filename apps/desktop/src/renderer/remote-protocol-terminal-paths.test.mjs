// How the phone resolves a folder path for a watch: with the rules of the host the files are on (which the host reports), never from how the
// path is spelled. The expected values are Node's own `path.win32` / `path.posix` run here, for each class of input; and the adapter's
// calls, for one spelling on a Windows host and on a POSIX host.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { adapter } from './remote-protocol-terminal.ts';
import { isAbsoluteOn, needsHostDevice, resolveOn } from '../shared/remote-arguments.ts';

const CLASSES = [
  'relative/dir', 'C:foo', 'C:', '/dir', '\\dir', '/dir/../x/', '//server', '//server/share', '\\\\server\\share\\a\\..\\b\\', 'C:\\a\\b\\..\\c\\',
  'c:/A/B/', '\\\\?\\C:\\x\\y', '\\\\.\\C:\\x', '\\\\?\\UNC\\srv\\sh\\a', 'C:\\a\\', 'C:\\', 'C:\\..', '//?/C:/x', '/', '\\', '//', '//tmp/Mixed/',
  '/a/./b//c', 'D:\\x\\.\\y',
];

const golden = JSON.parse(readFileSync(new URL('../../../mobile/fixtures/absolute-local-path/golden.json', import.meta.url), 'utf8'));

test('a Windows host answers every recorded input as Node\'s absoluteLocalPath did, whichever drive the working directory is on', async () => {
  for (const [drive, answers] of Object.entries(golden.drives)) {
    for (const [index, input] of golden.inputs.entries()) {
      const answer = answers[index];
      const { host: phone, calls } = host('windows', `${drive}:\\`);
      const error = await adapter.calls.folderWatch([input.absent ? undefined : input.value, true], phone).then(() => null, (thrown) => thrown);
      assert.equal(error?.message, answer.error?.message, `${input.name} on ${drive}: Node answered ${JSON.stringify(answer)}`);
      if (!error) assert.equal(calls.find(([method]) => method === 'fs/watch')[1].path, answer.result, `${input.name} on ${drive}`);
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

/** A phone host whose core reports `platformOs` and answers the calls the adapter makes; `calls` lists them. */
function host(platformOs, device = 'D:\\') {
  const calls = [];
  const client = {
    server: { platformOs },
    call: async (method, params) => {
      calls.push([method, params]);
      return method === 'projectFs/statLocal' ? [{ absolutePath: device }] : {};
    },
  };
  return { host: { ctx: {}, client: () => client }, calls };
}
const released = (calls) => calls.filter(([method]) => method === 'fs/unwatch').length;

test('one spelling is a rooted path on a Windows host and an ordinary one on a POSIX host', async () => {
  const win = host('windows');
  await adapter.calls.folderWatch(['/tmp/Mixed/', true], win.host);
  const watched = win.calls.find(([method]) => method === 'fs/watch');
  assert.equal(watched[1].path, path.win32.resolve('D:\\', '/tmp/Mixed/'), 'resolved onto the working directory\'s drive');
  await adapter.calls.folderUnwatch(['d:\\TMP\\mixed\\.', true], win.host);
  assert.equal(released(win.calls), 1, 'the Windows registry folds case and resolves the path');

  const posix = host('linux');
  await adapter.calls.folderWatch(['/tmp/Mixed/', true], posix.host);
  assert.equal(posix.calls.find(([method]) => method === 'fs/watch')[1].path, path.posix.resolve('/tmp/Mixed/'));
  assert.equal(posix.calls.some(([method]) => method === 'projectFs/statLocal'), false, 'a POSIX path needs no device');
  await adapter.calls.folderUnwatch(['/tmp/mixed', true], posix.host);
  assert.equal(released(posix.calls), 0, 'a POSIX registry is case-sensitive');
  await adapter.calls.folderUnwatch(['//tmp/./Mixed/', true], posix.host);
  assert.equal(released(posix.calls), 1);
});