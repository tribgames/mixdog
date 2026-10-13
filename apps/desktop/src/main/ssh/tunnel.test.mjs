import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { parseSshTarget, SshError, TunnelBackoff } from './ssh-command.ts';
import { SshTunnel } from './tunnel.ts';

function fakeSsh() {
  const children = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    child.command = command;
    child.args = args;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.exit = (code, stderr = '') => {
      if (stderr) child.stderr.write(stderr);
      setImmediate(() => {
        child.exitCode = code;
        child.emit('exit', code, null);
      });
    };
    child.kill = () => {
      child.killed = true;
      child.exit(255);
      return true;
    };
    children.push(child);
    return child;
  };
  return { children, spawnImpl };
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate) {
  for (let index = 0; index < 400 && !predicate(); index += 1) await tick();
  assert.ok(predicate(), 'condition not reached');
}

function tunnelWith(ssh, { accepts }) {
  return new SshTunnel(parseSshTarget('devbox'), {
    spawnImpl: ssh.spawnImpl,
    portAccepts: async () => accepts(),
    freePort: async () => 50123,
    backoff: new TunnelBackoff([10, 20, 40]),
  });
}

test('the tunnel restarts on the same local port after a transient exit', async () => {
  const ssh = fakeSsh();
  let up = true;
  const tunnel = tunnelWith(ssh, { accepts: () => up && ssh.children.at(-1)?.exitCode === null });
  assert.equal(await tunnel.ensure(41001, 2_000), 50123);
  assert.equal(ssh.children.length, 1);
  assert.equal(ssh.children[0].args.at(-1), 'devbox');
  assert.ok(ssh.children[0].args.includes('127.0.0.1:50123:127.0.0.1:41001'));

  up = false;
  ssh.children[0].exit(255, 'client_loop: send disconnect: Connection reset\n');
  await until(() => ssh.children.length === 2);
  up = true;
  assert.equal(await tunnel.ensure(41001, 2_000), 50123);
  assert.ok(ssh.children[1].args.includes('127.0.0.1:50123:127.0.0.1:41001'));
  await tunnel.close();
  assert.ok(ssh.children[1].killed);
});

test("a changed host key stops supervision with ssh's own words", async () => {
  const ssh = fakeSsh();
  const tunnel = tunnelWith(ssh, { accepts: () => false });
  const pending = tunnel.ensure(41001, 2_000);
  await until(() => ssh.children.length === 1);
  ssh.children[0].exit(
    255,
    '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\n'
  );
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof SshError);
    assert.equal(error.kind, 'terminal');
    assert.match(error.message, /REMOTE HOST IDENTIFICATION HAS CHANGED/);
    assert.match(error.message, /Host key verification failed\./);
    return true;
  });
  await tick(100);
  assert.equal(ssh.children.length, 1, 'no restart after a terminal failure');
  await assert.rejects(tunnel.ensure(41001, 100), /Host key verification failed/);
  await tunnel.close();
});

test('a daemon on a new remote port gets a fresh forward', async () => {
  const ssh = fakeSsh();
  const tunnel = tunnelWith(ssh, { accepts: () => ssh.children.at(-1)?.exitCode === null });
  await tunnel.ensure(41001, 2_000);
  await tunnel.ensure(41005, 2_000);
  assert.equal(ssh.children.length, 2);
  assert.ok(ssh.children[0].killed);
  assert.ok(ssh.children[1].args.includes('127.0.0.1:50123:127.0.0.1:41005'));
  await tunnel.close();
});
