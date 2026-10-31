import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatLock,
  linuxCreatedBounds,
  linuxStartToken,
  lockHolderTokenVerdict,
  lockHolderVerdict,
  lstartCreatedBounds,
  lstartStartToken,
  parseLock,
} from './memory-process-lock.mjs';

const lockWrittenAt = Date.parse('Sun Oct 18 10:00:00 2026') + 400;
const stat = (ticks) => `4242 (node (x)) S ${'0 '.repeat(18)}${ticks} 0`;
// The lock as a writer leaves it, read back by its successor.
const recorded = (token) => parseLock(formatLock(4242, token)).token;

test('a pid reused in the same second as the lock write is refused by the recorded start token', () => {
  // The writer started at 09:59:58 and wrote the lock at 10:00:00.4; a new
  // process took its pid in that same second.
  const lstart = recorded(lstartStartToken('Sun Oct 18 09:59:58 2026\n'));
  assert.equal(lockHolderTokenVerdict(lstart, lstartStartToken('Sun Oct 18 10:00:00 2026')), 'other');
  assert.equal(
    lockHolderTokenVerdict(recorded(linuxStartToken(stat(4999000))), linuxStartToken(stat(4999060))),
    'other'
  );
});

test('a live writer on an lstart-only system is proven by its recorded token, even when it wrote the lock in the second it started', () => {
  const token = lstartStartToken('Sun Oct 18 10:00:00 2026');
  assert.equal(lockHolderTokenVerdict(recorded(token), lstartStartToken('Sun Oct 18 10:00:00 2026')), 'writer');
  assert.equal(
    lockHolderTokenVerdict(recorded(linuxStartToken(stat(4999000))), linuxStartToken(stat(4999000))),
    'writer'
  );
  // The legacy verdict could not tell this writer apart.
  assert.equal(lockHolderVerdict(lstartCreatedBounds('Sun Oct 18 10:00:00 2026'), lockWrittenAt), 'unproven');
});

test('an unreadable current start token fails closed: the holder is neither signalled nor evicted', () => {
  const token = recorded(lstartStartToken('Sun Oct 18 09:59:58 2026'));
  for (const text of ['', 'Mi Mär 18 10:00:00 2026', 'garbage', null]) {
    assert.equal(lstartStartToken(text), null, JSON.stringify(text));
    assert.equal(lockHolderTokenVerdict(token, lstartStartToken(text)), 'unproven', JSON.stringify(text));
  }
  for (const text of ['', '4242 node S 0', stat('x')]) {
    assert.equal(lockHolderTokenVerdict(recorded(linuxStartToken(stat(1))), linuxStartToken(text)), 'unproven');
  }
});

test('a pid-only lock from an older writer parses without a token and keeps the legacy verdict', () => {
  assert.deepEqual(parseLock('4242'), { pid: 4242, token: null });
  assert.deepEqual(parseLock(formatLock(4242, null)), { pid: 4242, token: null });
});

test('legacy verdict: a pid reused in the same second as the lock write is never taken for the writer', () => {
  // The writer died after writing; a new process took its pid 200 ms later.
  // ps lstart reports both in the same whole second.
  assert.equal(lockHolderVerdict(lstartCreatedBounds('Sun Oct 18 10:00:00 2026'), lockWrittenAt), 'unproven');
  // /proc's tick precision tells the two apart.
  const now = lockWrittenAt + 10_000;
  const procAt = (created) => linuxCreatedBounds(stat((created - (now - 50_000_000)) / 10), '50000.00 1.0', 100, now);
  assert.equal(lockHolderVerdict(procAt(lockWrittenAt + 200), lockWrittenAt), 'other');
  assert.equal(lockHolderVerdict(procAt(lockWrittenAt - 300), lockWrittenAt), 'writer');
});

test('legacy verdict: an unreadable creation time never proves the pid is not the writer', () => {
  for (const text of ['', 'Mi Mär 18 10:00:00 2026', 'garbage']) {
    assert.equal(lockHolderVerdict(lstartCreatedBounds(text), lockWrittenAt), 'unproven', JSON.stringify(text));
  }
  assert.equal(lockHolderVerdict(linuxCreatedBounds('', '50000.00 1.0', 100, Date.now()), lockWrittenAt), 'unproven');
  assert.equal(lockHolderVerdict(null, lockWrittenAt), 'unproven');
});
