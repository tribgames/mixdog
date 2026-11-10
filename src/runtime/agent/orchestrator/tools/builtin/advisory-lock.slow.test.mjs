import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const lockModule = new URL('./advisory-lock.mjs', import.meta.url).href;
const holderSource = `
  import { withAdvisoryLocks } from ${JSON.stringify(lockModule)};
  const released = new Promise(resolve => process.once('message', resolve));
  process.on('disconnect', () => process.exit(0));
  await withAdvisoryLocks([process.argv[1]], async () => {
    process.send('held');
    await released;
  });
  process.disconnect();
`;
const probeSource = `
  import { withAdvisoryLocks } from ${JSON.stringify(lockModule)};
  let entered = false;
  try {
    await withAdvisoryLocks([process.argv[1]], async () => { entered = true; });
    console.log(JSON.stringify({ entered }));
  } catch (error) {
    console.log(JSON.stringify({ entered, code: error.code, message: error.message }));
  }
`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-profile-lock-'));
  const user = join(root, 'user');
  const work = join(root, 'work');
  mkdirSync(user);
  mkdirSync(work);
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) });
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });

  function profile(name) {
    const home = join(root, name);
    const temp = join(home, 'temp');
    mkdirSync(temp, { recursive: true });
    return {
      ...process.env,
      HOME: user,
      USERPROFILE: user,
      LOCALAPPDATA: join(user, 'AppData', 'Local'),
      MIXDOG_HOME: home,
      MIXDOG_DATA_DIR: join(home, 'data'),
      MIXDOG_RUNTIME_ROOT: join(home, 'runtime'),
      TMPDIR: temp,
      TEMP: temp,
      TMP: temp,
    };
  }

  async function hold(target, env) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', holderSource, target], {
      env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const signal = AbortSignal.timeout(10_000);
    const [message] = await Promise.race([
      once(child, 'message', { signal }),
      once(child, 'exit', { signal }).then(([code, exitSignal]) => {
        throw new Error(`holder exited before acquiring: ${code}/${exitSignal}\n${stderr}`);
      }),
    ]);
    assert.equal(message, 'held', stderr);
    return child;
  }

  async function stop(child, crash = false) {
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) });
    if (crash) child.kill('SIGKILL');
    else child.send('release');
    const [code] = await exited;
    if (!crash) assert.equal(code, 0);
  }

  function probe(target, env) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probeSource, target], {
      env,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
  }

  function lockFiles() {
    return readdirSync(root, { recursive: true })
      .filter((name) => name.endsWith('.mixdog-lock'))
      .map((name) => join(root, name));
  }

  return { work, profile, hold, stop, probe, lockFiles };
}

test('different profiles exclude the same file but allow independent files and acquisition after release', async (t) => {
  const f = fixture(t);
  const target = join(f.work, 'shared.md');
  writeFileSync(target, 'shared');
  const a = f.profile('profile-a');
  const b = f.profile('profile-b');
  const holder = await f.hold(target, a);
  const [lockFile] = f.lockFiles();
  assert.equal(f.lockFiles().length, 1);
  const token = readFileSync(lockFile, 'utf8');
  assert.match(token, new RegExp(`^${holder.pid}\\.`));

  assert.deepEqual(f.probe(join(f.work, 'independent.md'), b), { entered: true });
  const blocked = f.probe(target, b);
  assert.equal(blocked.entered, false, "another profile entered a live holder's critical section");
  assert.equal(blocked.code, 'EAGAIN', blocked.message);
  assert.equal(readFileSync(lockFile, 'utf8'), token);

  await f.stop(holder);
  assert.equal(existsSync(lockFile), false);
  assert.deepEqual(f.probe(target, b), { entered: true });
  assert.deepEqual(f.lockFiles(), []);
});

test('another profile reclaims the same lockfile after its holder exits', async (t) => {
  const f = fixture(t);
  const target = join(f.work, 'shared.md');
  writeFileSync(target, 'shared');
  const holder = await f.hold(target, f.profile('profile-a'));
  const [lockFile] = f.lockFiles();
  assert.equal(f.lockFiles().length, 1);

  await f.stop(holder, true);
  assert.equal(existsSync(lockFile), true, 'crashing must leave a stale lock for the next profile');
  assert.deepEqual(f.probe(target, f.profile('profile-b')), { entered: true });
  assert.equal(existsSync(lockFile), false, 'the next profile must reclaim the existing lock');
  assert.deepEqual(f.lockFiles(), []);
});
