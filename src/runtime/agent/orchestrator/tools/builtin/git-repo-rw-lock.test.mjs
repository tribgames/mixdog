import assert from 'node:assert/strict';
import test from 'node:test';
import { withGitRepoReadLock, withGitRepoWriteLock } from './git-repo-rw-lock.mjs';

function gate() {
    let release;
    return { promise: new Promise((resolve) => { release = resolve; }), release };
}

test('git repo lock shares reads, excludes writes, and does not starve a queued writer', async () => {
    const repo = `repo-${Date.now()}-${Math.random()}`;
    const firstReads = gate();
    const writerGate = gate();
    const events = [];
    const read = (name, wait) => withGitRepoReadLock(repo, async () => {
        events.push(`${name}:start`);
        await wait.promise;
        events.push(`${name}:end`);
    });
    const r1 = read('r1', firstReads);
    const r2 = read('r2', firstReads);
    await Promise.resolve();
    assert.deepEqual(events, ['r1:start', 'r2:start']);

    const writer = withGitRepoWriteLock(repo, async () => {
        events.push('w:start');
        await writerGate.promise;
        events.push('w:end');
    });
    const lateRead = withGitRepoReadLock(repo, async () => {
        events.push('r3:start');
        events.push('r3:end');
    });
    await Promise.resolve();
    assert.deepEqual(events, ['r1:start', 'r2:start']);

    firstReads.release();
    await Promise.all([r1, r2]);
    await Promise.resolve();
    assert.equal(events.at(-1), 'w:start');
    assert.ok(!events.includes('r3:start'));

    writerGate.release();
    await writer;
    await lateRead;
    assert.deepEqual(events.slice(-3), ['w:end', 'r3:start', 'r3:end']);
});

test('git repo writers on different repositories run in parallel', async () => {
    const hold = gate();
    const events = [];
    const first = withGitRepoWriteLock('repo-a', async () => {
        events.push('a');
        await hold.promise;
    });
    const second = withGitRepoWriteLock('repo-b', async () => {
        events.push('b');
        await hold.promise;
    });
    await Promise.resolve();
    assert.deepEqual(events.sort(), ['a', 'b']);
    hold.release();
    await Promise.all([first, second]);
});
