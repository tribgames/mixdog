import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemoteMethods } from './remote-methods.ts';

const CWD = process.cwd();

/** The methods over a host that records what each call asked of the desktop. */
function methodsWithLog() {
  const log = [];
  const methods = createRemoteMethods({
    host: {
      async invokeDesktopOperation(name, args) {
        log.push([name, args]);
        return null;
      },
      async projectDirectory(path) {
        return path;
      },
      async searchProjectFiles(...args) {
        log.push(['searchProjectFiles', args]);
        return [];
      },
    },
  });
  return { methods, log };
}

/** What a call did: the desktop operations it asked for, or the refusal it threw. */
async function outcome(method, params) {
  const { methods, log } = methodsWithLog();
  try {
    await methods[method](params);
    return { asked: log };
  } catch (error) {
    return { refused: error.message, asked: log };
  }
}

// remote-shim-api.ts passes every position of these calls (`[cwd, source]`), and the relay frame is JSON: an
// argument the app leaves out (ReviewPane's `gitReview(cwd)`, the file row's `onIgnore(path)`) arrives as null.
const OPTIONAL = [
  ['gitReview', [CWD], [CWD, null]],
  ['gitReviewDiff', [CWD, 'a.txt', false], [CWD, 'a.txt', false, null]],
  ['gitReviewDiffs', [CWD, [{ path: 'a.txt' }]], [CWD, [{ path: 'a.txt' }], null]],
  ['gitRevert', [CWD, 'a.txt', false], [CWD, 'a.txt', false, null]],
  ['gitIgnore', [CWD, 'a.txt'], [CWD, 'a.txt', null]],
  ['searchProjectFiles', [CWD, 'a'], [CWD, 'a', null, false, false]],
  ['replaceWorkspaceText', [CWD, { query: 'a' }, 'b'], [CWD, { query: 'a' }, 'b', null]],
];

for (const [method, left, nulled] of OPTIONAL) {
  test(`a remote ${method} with its optional argument as null acts as with the argument left out`, async () => {
    const without = await outcome(method, left);
    assert.equal(without.refused, undefined, `${method} without the argument`);
    assert.ok(without.asked.length > 0, `${method} reached the desktop`);
    assert.deepEqual(await outcome(method, nulled), without);
  });
}

test('a remote call still refuses a wrong value in those positions', async () => {
  assert.equal((await outcome('gitReview', [CWD, 'stash'])).refused, 'Git review source is invalid.');
  assert.equal((await outcome('gitRevert', [CWD, 'a.txt', false, 'some'])).refused, 'git discard mode is invalid.');
  assert.equal((await outcome('gitIgnore', [CWD, 'a.txt', 'folder'])).refused, 'Git ignore scope is invalid.');
  assert.equal((await outcome('searchProjectFiles', [CWD, 'a', 0])).refused, 'limit is invalid.');
  assert.equal((await outcome('replaceWorkspaceText', [CWD, { query: 'a' }, 'b', 'x'])).refused, 'git paths are invalid.');
});
