import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cancelGithubCliLogin,
  githubCliLoginOpenBrowser,
  githubCliLoginStart,
  githubCliLoginStatus,
  githubCliLoginTestHooks,
} from './github-cli.ts';

function fakePty() {
  const spawns = [];
  const writes = [];
  let onData = () => {};
  let onExit = () => {};
  return {
    spawns,
    writes,
    emit: (text) => onData(text),
    exit: (exitCode) => onExit({ exitCode }),
    module: {
      spawn: (file, args, options) => {
        spawns.push({ file, args, options });
        return {
          onData: (cb) => (onData = cb),
          onExit: (cb) => (onExit = cb),
          write: (data) => writes.push(data),
          kill: () => {},
        };
      },
    },
  };
}

async function start(t) {
  const pty = fakePty();
  githubCliLoginTestHooks.pty = pty.module;
  githubCliLoginTestHooks.gh = { path: 'gh', version: '2' };
  const flow = await githubCliLoginStart();
  t.after(() => {
    cancelGithubCliLogin(flow.flowId);
    delete githubCliLoginTestHooks.pty;
    delete githubCliLoginTestHooks.gh;
    delete githubCliLoginTestHooks.run;
  });
  return { pty, flow };
}

test('login never triggers the git-credential prompt and never opens a browser itself', async (t) => {
  const { pty, flow } = await start(t);
  const { args, options } = pty.spawns[0];
  assert.deepEqual(args, ['auth', 'login', '--hostname', 'github.com', '--web']);
  assert.equal(options.env.GH_PROMPT_DISABLED, '1');
  assert.match(options.env.BROWSER, process.platform === 'win32' ? /^cmd \/c exit 0$/ : /^true$/);
  assert.equal(options.env.GH_BROWSER, options.env.BROWSER);
  pty.emit(
    '! First copy your one-time code: ABCD-1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n'
  );
  assert.equal(githubCliLoginStatus(flow.flowId).code, 'ABCD-1234');
  assert.equal(githubCliLoginOpenBrowser(flow.flowId), false);
  assert.deepEqual(pty.writes, []);
});

test('setup-git runs after gh exits successfully', async (t) => {
  const { pty, flow } = await start(t);
  const calls = [];
  githubCliLoginTestHooks.run = async (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === 'auth' && args[1] === 'status')
      return { code: 0, stdout: '✓ Logged in to github.com account tester (keyring)', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  pty.exit(0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls.at(-1), ['gh', 'auth', 'setup-git', '--hostname', 'github.com']);
  assert.equal(githubCliLoginStatus(flow.flowId).state, 'success');
});

test('a failed setup-git after sign-in is reported, not shown as success', async (t) => {
  const { pty, flow } = await start(t);
  githubCliLoginTestHooks.run = async (_file, args) => {
    if (args[0] === 'auth' && args[1] === 'status')
      return { code: 0, stdout: '✓ Logged in to github.com account tester (keyring)', stderr: '' };
    if (args[1] === 'setup-git') return { code: 1, stdout: '', stderr: 'could not write git config' };
    return { code: 0, stdout: '', stderr: '' };
  };
  pty.exit(0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const status = githubCliLoginStatus(flow.flowId);
  assert.equal(status.state, 'error');
  assert.match(status.message, /could not write git config/);
});

test('no one-time code in time ends in an error pointing to the terminal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { flow } = await start(t);
  assert.equal(githubCliLoginStatus(flow.flowId).state, 'pending');
  t.mock.timers.tick(60_000);
  const status = githubCliLoginStatus(flow.flowId);
  assert.equal(status.state, 'error');
  assert.match(status.message, /gh auth login/);
});
