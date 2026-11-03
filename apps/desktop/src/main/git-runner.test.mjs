import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';

import { gitCommand } from '../../../../src/runtime/shared/git-launch.mjs';
import { runProcessOffThread } from '../../../../src/runtime/shared/process-runner.mjs';
import {
  GIT_READ_TIMEOUT_MS,
  isGitTimeout,
  run,
  runRead,
  runWithInput,
  runWithStatus,
  setGitProcessRunner,
  streamNulRecords,
} from './git-runner.ts';
import { gitReview } from './git-history.ts';
import { GIT_STATUS_UNTRACKED_LIMIT, gitStatus } from './git-status.ts';

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-git-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, 'a.txt'), 'a\n');
  writeFileSync(join(root, 'b c.txt'), 'b\n');
  return root;
}

test('with the daemon runner set, every git child starts off-thread with the same results', async (t) => {
  const root = repo(t);
  const commands = [];
  setGitProcessRunner((command, args, options) => {
    commands.push({ command, args, env: options.env });
    return runProcessOffThread(command, args, options);
  });
  t.after(() => setGitProcessRunner(null));

  assert.equal((await run(root, ['rev-parse', '--is-inside-work-tree'])).trim(), 'true');
  const records = [];
  await streamNulRecords(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], (record) =>
    records.push(record)
  );
  assert.deepEqual(records.sort(), ['? a.txt', '? b c.txt']);
  // `config --get` answers 1 for "not set": the exit code is kept, not thrown.
  const unset = await runWithStatus(root, ['config', '--get', 'mixdog.test-unset']);
  assert.equal(unset.code, 1);
  assert.equal(unset.stdout, '');
  assert.equal((await runWithInput(root, ['hash-object', '--stdin'], 'a\n')).trim().length, 40);
  await assert.rejects(run(root, ['rev-parse', '--verify', 'no-such-ref']), /no-such-ref|Needed a single revision/);
  await assert.rejects(
    streamNulRecords(root, ['no-such-command'], () => {}),
    /no-such-command|not a git command/
  );
  assert.ok(commands.length >= 6 && commands.every((call) => call.command === gitCommand()));
  assert.equal(commands[0].env.GIT_TERMINAL_PROMPT, '0', 'the scrubbed git environment travels with each child');
});

test('status lists a bounded set of untracked files and counts the rest (off-thread)', async (t) => {
  const root = repo(t);
  const total = 200_000;
  const hash = '0'.repeat(40);
  const stdout =
    [
      '# branch.oid ' + hash,
      '# branch.head main',
      `1 .M N... 100644 100644 100644 ${hash} ${hash} tracked.txt`,
      ...Array.from({ length: total }, (_, index) => `? untracked/file-${index}.txt`),
    ].join('\0') + '\0';
  setGitProcessRunner((command, args, options) =>
    args.includes('status')
      ? Promise.resolve({ code: 0, stdout, stderr: '' })
      : runProcessOffThread(command, args, options)
  );
  t.after(() => setGitProcessRunner(null));
  const status = await gitStatus(root);
  const untracked = status.files.filter((file) => file.untracked);
  assert.equal(untracked.length, GIT_STATUS_UNTRACKED_LIMIT);
  assert.equal(untracked[0].path, 'untracked/file-0.txt');
  assert.equal(status.untrackedOmitted, total - GIT_STATUS_UNTRACKED_LIMIT);
  assert.equal(status.files.length, GIT_STATUS_UNTRACKED_LIMIT + 1, 'tracked changes are always listed');
});

test('review materialises at most its untracked limit and counts the rest', async (t) => {
  const root = repo(t);
  const total = 200_000;
  const hash = '0'.repeat(40);
  const stdout =
    [
      '# branch.oid ' + hash,
      '# branch.head main',
      ...Array.from({ length: total }, (_, index) => `? untracked/${'d'.repeat(180)}/file-${index}.txt`),
    ].join('\0') + '\0';
  setGitProcessRunner((command, args, options) =>
    args.includes('status')
      ? stdout.length > options.maxBytes
        ? Promise.reject(Object.assign(new Error('output too large'), { code: 'EMAXBUFFER' }))
        : Promise.resolve({ code: 0, stdout, stderr: '' })
      : runProcessOffThread(command, args, options)
  );
  t.after(() => setGitProcessRunner(null));
  const review = await gitReview(root, 'uncommitted');
  assert.equal(review.files.length, 256);
  assert.equal(review.untrackedOmitted, total - 256);
});

test('status lists a bounded set of untracked files and counts the rest (in-thread)', async (t) => {
  const root = repo(t);
  const extra = 40;
  for (let index = 0; index < GIT_STATUS_UNTRACKED_LIMIT + extra; index++) {
    writeFileSync(join(root, `n${index}.txt`), 'x\n');
  }
  const status = await gitStatus(root);
  assert.equal(status.files.length, GIT_STATUS_UNTRACKED_LIMIT);
  // The two files `repo` writes are untracked too.
  assert.equal(status.untrackedOmitted, GIT_STATUS_UNTRACKED_LIMIT + extra + 2 - GIT_STATUS_UNTRACKED_LIMIT);
});

test('a status listing past its byte bound fails instead of reading as "not a repository"', async (t) => {
  const root = repo(t);
  setGitProcessRunner((command, args, options) =>
    args.includes('status')
      ? Promise.reject(Object.assign(new Error('git status exceeded output bytes'), { code: 'EMAXBUFFER' }))
      : runProcessOffThread(command, args, options)
  );
  t.after(() => setGitProcessRunner(null));
  await assert.rejects(gitStatus(root), { code: 'EMAXBUFFER' });
});

// In-thread, git's stdout is read as raw bytes: the bound counts bytes (not
// UTF-16 units) and a character split between chunks decodes whole.
function emitScript(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-git-emit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'emit.mjs').replace(/\\/g, '/');
  writeFileSync(
    script,
    `const han = Buffer.from('한');
if (process.argv[2] === 'split') {
  process.stdout.write(Buffer.concat([Buffer.from('a\\0'), han.subarray(0, 2)]));
  setTimeout(() => process.stdout.write(Buffer.concat([han.subarray(2), Buffer.from('b\\0')])), 150);
} else {
  process.stdout.write(Buffer.from('한'.repeat(400) + '\\0'));
}
`
  );
  return ['-c', `alias.emit=!node "${script}"`, 'emit'];
}

test('a multibyte character split between chunks decodes whole', async (t) => {
  const records = [];
  await streamNulRecords(tmpdir(), [...emitScript(t), 'split'], (record) => {
    records.push(record);
  });
  assert.deepEqual(records, ['a', '한b']);
});

test('the output bound counts bytes of multibyte names, not characters', async (t) => {
  // 400 characters, 1200 bytes: under the bound by length, over it by bytes.
  await assert.rejects(
    streamNulRecords(tmpdir(), [...emitScript(t), 'wide'], () => {}, { maxBytes: 1000 }),
    { code: 'EMAXBUFFER' }
  );
});

// A Git for Windows install resolved for this PATH is then removed: the next
// child (in-thread and off-thread alike) runs the git PATH names now.
for (const offThread of [false, true]) {
  test(`a removed git install falls back to the git PATH names now (${offThread ? 'off-thread' : 'in-thread'})`, {
    skip: gitCommand() === 'git' ? 'needs Git for Windows behind its launcher' : false,
  }, async (t) => {
    if (offThread) {
      setGitProcessRunner(runProcessOffThread);
      t.after(() => setGitProcessRunner(null));
    }
    const real = dirname(dirname(dirname(gitCommand()))); // <root>\mingw64\bin\git.exe
    const stale = mkdtempSync(join(tmpdir(), 'mixdog-git-runner-stale-'));
    t.after(() => rmSync(stale, { recursive: true, force: true }));
    for (const dir of ['cmd', 'usr/bin', 'mingw64/bin']) mkdirSync(join(stale, dir), { recursive: true });
    for (const file of ['cmd/git.exe', 'git-bash.exe', 'mingw64/bin/git.exe']) writeFileSync(join(stale, file), '');
    const path = process.env.PATH;
    process.env.PATH = `${join(stale, 'cmd')}${delimiter}${join(real, 'cmd')}`;
    t.after(() => {
      process.env.PATH = path;
    });
    // Resolves the stale install; its empty git.exe cannot start.
    await runWithStatus(tmpdir(), ['--version']).catch(() => {});
    rmSync(stale, { recursive: true, force: true });
    assert.match(await run(tmpdir(), ['--version']), /^git version /);
  });
}

test('reads carry the read deadline; writes stay unbounded', async (t) => {
  const timeouts = [];
  setGitProcessRunner(async (_command, _args, options) => {
    timeouts.push(options.timeoutMs);
    return { code: 0, stdout: '', stderr: '' };
  });
  t.after(() => setGitProcessRunner(null));
  await runRead(tmpdir(), ['status']);
  await run(tmpdir(), ['commit']);
  assert.deepEqual(timeouts, [GIT_READ_TIMEOUT_MS, 0]);
});

// A git child that never answers (here an alias that sleeps) must not hold
// its caller: in-thread and off-thread alike it is cut off at the deadline.
for (const offThread of [false, true]) {
  test(`a hung git read is cut off at its deadline (${offThread ? 'off-thread' : 'in-thread'})`, async (t) => {
    if (offThread) {
      setGitProcessRunner(runProcessOffThread);
      t.after(() => setGitProcessRunner(null));
    }
    const started = Date.now();
    await assert.rejects(
      streamNulRecords(tmpdir(), ['-c', 'alias.hang=!sleep 10', 'hang'], () => {}, { timeoutMs: 300 }),
      /timed out/
    );
    assert.ok(Date.now() - started < 10_000, 'the read settled at its deadline, not when the child ended');
  });
}

test('a timed-out read fails status and review instead of answering "no changes"', async (t) => {
  const root = repo(t);
  const children = [];
  setGitProcessRunner((command, args, options) => {
    if (args.includes('status')) {
      return Promise.reject(Object.assign(new Error('git status timed out after 60000ms'), { code: 'ETIMEDOUT' }));
    }
    const child = runProcessOffThread(command, args, options);
    children.push(child);
    return child;
  });
  t.after(() => setGitProcessRunner(null));
  await assert.rejects(gitStatus(root), /timed out/);
  await assert.rejects(gitReview(root, 'uncommitted'), /timed out/);
  // The reads started beside the scan still run in the repository; let them
  // finish before it is removed.
  await Promise.allSettled(children);
});

test('a git deadline carries EGITTIMEOUT, never the ETIMEDOUT the session transport reads as a dead daemon', async (t) => {
  setGitProcessRunner(() =>
    Promise.reject(
      Object.assign(new Error('git rev-parse --verify HEAD timed out after 60000ms'), { code: 'ETIMEDOUT' })
    )
  );
  t.after(() => setGitProcessRunner(null));
  const root = tmpdir();
  await assert.rejects(runRead(root, ['rev-parse', '--verify', 'HEAD']), { code: 'EGITTIMEOUT' });
  await assert.rejects(
    streamNulRecords(root, ['ls-files', '-z'], () => {}, { timeoutMs: 1 }),
    { code: 'EGITTIMEOUT' }
  );
  assert.equal(isGitTimeout(Object.assign(new Error('x'), { code: 'EGITTIMEOUT' })), true);
  assert.equal(isGitTimeout(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), false);
});
