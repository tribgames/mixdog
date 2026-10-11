import assert from 'node:assert/strict';
import test from 'node:test';
import { githubCliLoginOpenBrowser, githubCliLoginStart, githubCliLoginTestHooks } from './github-cli.ts';

function fakePty() {
  const spawns = [];
  const writes = [];
  let onData = () => {};
  return {
    spawns,
    writes,
    emit: (text) => onData(text),
    module: {
      spawn: (file, args, options) => {
        spawns.push({ file, args, options });
        return {
          onData: (cb) => (onData = cb),
          onExit: () => {},
          write: (data) => writes.push(data),
          kill: () => {},
        };
      },
    },
  };
}

async function start(t, options) {
  const pty = fakePty();
  githubCliLoginTestHooks.pty = pty.module;
  githubCliLoginTestHooks.gh = { path: 'gh', version: '2' };
  const flow = await githubCliLoginStart(options);
  t.after(() => {
    delete githubCliLoginTestHooks.pty;
    delete githubCliLoginTestHooks.gh;
  });
  pty.emit('! First copy your one-time code: ABCD-1234\nPress Enter to open github.com in your browser...');
  return { pty, flow };
}

test('remote sign-in spawns gh with a no-op browser and still presses Enter', async (t) => {
  const { pty, flow } = await start(t, { openBrowser: false });
  const { env } = pty.spawns[0].options;
  assert.ok(env.BROWSER && env.GH_BROWSER);
  assert.match(env.BROWSER, process.platform === 'win32' ? /^cmd \/c exit 0$/ : /^true$/);
  assert.deepEqual(pty.writes, []);
  assert.equal(githubCliLoginOpenBrowser(flow.flowId, { openBrowser: false }), false);
  assert.deepEqual(pty.writes, ['\r']);
});

test('local sign-in keeps gh browser and reports that gh opened it', async (t) => {
  const { pty, flow } = await start(t);
  assert.notEqual(pty.spawns[0].options.env.GH_BROWSER, process.platform === 'win32' ? 'cmd /c exit 0' : 'true');
  assert.equal(githubCliLoginOpenBrowser(flow.flowId), true);
  assert.deepEqual(pty.writes, ['\r']);
});
