import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { CallbackPortInUseError, MAX_CARRIED_CONNECTIONS, openCallbackForward } from './callback-forward.ts';
import { parseSshTarget } from './ssh-command.ts';
import { currentSshContext, runWithSshContext } from './ssh-context.ts';

const target = parseSshTarget('dev@build-box');

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/** An ssh child that answers each line it is sent with `server:<line>`. */
function fakeSsh() {
  const children = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    Object.assign(child, { command, args, exitCode: null, signalCode: null, context: currentSshContext() });
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin.on('data', (chunk) => child.stdout.write(`server:${chunk}`));
    child.kill = () => {
      child.signalCode = 'SIGTERM';
      setImmediate(() => child.emit('exit', null, 'SIGTERM'));
      return true;
    };
    children.push(child);
    return child;
  };
  return { children, spawnImpl };
}

const exchange = (port, line) =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('error', reject);
    socket.once('data', (data) => {
      resolve(String(data));
      socket.end();
    });
    socket.write(line);
  });

test("each browser connection reaches the server's port through its own ssh -W, under the server's settings", async () => {
  const ssh = fakeSsh();
  const port = await freePort();
  const forward = await runWithSshContext({ settings: { identityFile: '~/.ssh/id_box' } }, () =>
    openCallbackForward({ target, port, spawnImpl: ssh.spawnImpl })
  );
  // Outside the context now, as a browser's redirect arrives.
  assert.equal(await exchange(port, 'GET /auth/callback'), 'server:GET /auth/callback');
  assert.equal(await exchange(port, 'again'), 'server:again');
  assert.equal(ssh.children.length, 2);
  const { command, args, context } = ssh.children[0];
  assert.equal(command, 'ssh');
  assert.deepEqual(args.slice(-4), ['-W', `127.0.0.1:${port}`, '--', 'dev@build-box']);
  assert.ok(args.includes('BatchMode=yes'));
  assert.equal(context.settings.identityFile, '~/.ssh/id_box');
  await forward.close();
  // Closed: the port is free again and nothing is carried any more.
  const again = createServer();
  await new Promise((resolve, reject) => {
    again.once('error', reject);
    again.listen(port, '127.0.0.1', resolve);
  });
  again.close();
});

test('a callback port something on this PC holds is refused by the bind itself', async (t) => {
  const holder = createServer((socket) => socket.end('INTRUDER'));
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  t.after(() => holder.close());
  const ssh = fakeSsh();
  await assert.rejects(
    openCallbackForward({ target, port: holder.address().port, spawnImpl: ssh.spawnImpl }),
    (error) => error instanceof CallbackPortInUseError && /is in use on this PC/.test(error.message)
  );
  assert.equal(ssh.children.length, 0);
});

/** An ssh child that answers the first chunk with `response`, then exits
 *  with `code` at once, before anyone has read its stdout. */
function answeringSsh(response, code) {
  const children = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    Object.assign(child, { exitCode: null, signalCode: null });
    child.stdin = new PassThrough();
    child.stdout = new PassThrough({ highWaterMark: 1024 });
    child.stderr = new PassThrough();
    child.stdin.once('data', () => {
      child.stdout.end(response);
      child.exitCode = code;
      child.emit('exit', code, null);
    });
    child.kill = () => true;
    children.push(child);
    return child;
  };
  return { children, spawnImpl };
}

test('a clean ssh exit before its stdout drains still delivers the whole answer to a slow reader', async () => {
  const response = `HTTP/1.1 200 OK\r\n\r\n${'x'.repeat(4 * 1024 * 1024)}END`;
  const ssh = answeringSsh(response, 0);
  const port = await freePort();
  const forward = await openCallbackForward({ target, port, spawnImpl: ssh.spawnImpl });
  const received = await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('error', reject);
    let bytes = 0;
    let tail = '';
    socket.on('readable', function readSlowly() {
      socket.off('readable', readSlowly);
      const drain = () => {
        const chunk = socket.read(16 * 1024);
        if (chunk) {
          bytes += chunk.length;
          tail = (tail + chunk.toString('latin1')).slice(-3);
        }
        setTimeout(drain, chunk ? 1 : 5);
      };
      drain();
    });
    socket.once('end', () => resolve({ bytes, tail }));
    socket.write('GET /auth/callback HTTP/1.1\r\n\r\n');
  });
  assert.equal(received.bytes, Buffer.byteLength(response));
  assert.equal(received.tail, 'END');
  await forward.close();
});

test('a failed ssh drops the browser connection at once', async () => {
  const ssh = answeringSsh('partial', 255);
  const port = await freePort();
  const forward = await openCallbackForward({ target, port, spawnImpl: ssh.spawnImpl });
  const outcome = await new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.on('data', () => undefined);
    socket.once('error', (error) => resolve(error.code));
    socket.once('close', () => resolve('closed'));
    socket.write('GET /\r\n');
  });
  assert.ok(['closed', 'ECONNRESET'].includes(outcome));
  await forward.close();
});

test('the connections carried at once are capped', async () => {
  const ssh = fakeSsh();
  const port = await freePort();
  const forward = await openCallbackForward({ target, port, spawnImpl: ssh.spawnImpl });
  const sockets = [];
  for (let index = 0; index < MAX_CARRIED_CONNECTIONS + 2; index += 1) {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.on('error', () => undefined);
    sockets.push(socket);
    await new Promise((resolve) => socket.once('connect', resolve));
  }
  for (let index = 0; index < 100 && ssh.children.length < MAX_CARRIED_CONNECTIONS; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ssh.children.length, MAX_CARRIED_CONNECTIONS);
  for (const socket of sockets) socket.destroy();
  await forward.close();
});

test('closing the forward stops the ssh of a connection still open', async () => {
  const ssh = fakeSsh();
  const port = await freePort();
  const forward = await openCallbackForward({ target, port, spawnImpl: ssh.spawnImpl });
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.on('error', () => undefined);
  const closed = new Promise((resolve) => socket.once('close', resolve));
  await new Promise((resolve) => socket.once('connect', resolve));
  for (let index = 0; index < 100 && ssh.children.length === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(ssh.children.length, 1);
  await forward.close();
  await closed;
  assert.equal(ssh.children[0].signalCode, 'SIGTERM');
});
