// The callback forward of a server login: this PC listens on the provider's
// loopback callback port and carries each connection to the same port on the
// server through its own `ssh -W`. The listener is this PC's own bind, so a
// port something else holds is found by the bind itself, never by a check
// that a later bind could contradict (on Windows ssh's own `-L` bind can share
// a port another program already listens on, and that program keeps the
// traffic).
import type { ChildProcess } from 'node:child_process';
import { createServer, type Socket } from 'node:net';

import { sshStdioForwardArgs, stderrTail, type SshTarget } from './ssh-command';
import { currentSshContext, runWithSshContext } from './ssh-context';
import { defaultSshSpawn, killWithProcess, type SshSpawn } from './ssh-exec';

export interface CallbackForwardOptions {
  target: SshTarget;
  /** The callback port, the same on both ends. */
  port: number;
  spawnImpl?: SshSpawn;
  log?: (line: string) => void;
}

/** A login's redirect needs one or two connections (a retry, a favicon). */
export const MAX_CARRIED_CONNECTIONS = 8;

export class CallbackPortInUseError extends Error {
  override readonly name = 'CallbackPortInUseError';
}

/** Listens on 127.0.0.1:`port` here; rejects with CallbackPortInUseError when
 *  the port is taken on this PC. Every ssh it starts runs under the caller's
 *  ssh context (the server's key file, batch mode). */
export async function openCallbackForward({
  target,
  port,
  spawnImpl = defaultSshSpawn,
  log = () => undefined,
}: CallbackForwardOptions): Promise<{ close(): Promise<void> }> {
  const context = currentSshContext() ?? {};
  const carried = new Set<{ socket: Socket; child: ChildProcess }>();

  const carry = (socket: Socket): void => {
    // One ssh per connection, so a burst of connections is bounded here.
    if (carried.size >= MAX_CARRIED_CONNECTIONS) {
      log(`callback forward refused a connection: ${MAX_CARRIED_CONNECTIONS} already open`);
      socket.destroy();
      return;
    }
    const child = runWithSshContext(context, () =>
      spawnImpl('ssh', sshStdioForwardArgs(target, port), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    );
    const entry = { socket, child };
    carried.add(entry);
    const release = killWithProcess(child);
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4_096);
    });
    child.stdin?.on('error', () => undefined);
    child.once('error', (error) => {
      log(`callback forward could not start ssh: ${error.message}`);
      socket.destroy();
    });
    child.once('exit', (code, signal) => {
      release();
      // A clean exit can come before its stdout is read out: the pipe below
      // ends the socket once stdout reaches EOF and the socket's writes drain.
      if (code === 0) {
        if (!child.stdout) socket.end();
        return;
      }
      if (code) log(`callback forward ssh exited with status ${code}: ${stderrTail(stderr, 4).replace(/\n/g, ' | ')}`);
      else log(`callback forward ssh stopped by ${signal ?? 'a signal'}`);
      socket.destroy();
    });
    socket.on('error', () => undefined);
    // Carried until the browser's socket closes, so closing the forward also
    // ends a socket still draining an answer.
    socket.once('close', () => {
      carried.delete(entry);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    if (child.stdin) socket.pipe(child.stdin);
    child.stdout?.pipe(socket);
  };

  const server = createServer(carry);
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE' || error.code === 'EACCES'
          ? new CallbackPortInUseError(`Port ${port} is in use on this PC.`)
          : error
      );
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve());
  });
  log(`callback forward listening on 127.0.0.1:${port} -> ${target.display}:127.0.0.1:${port}`);

  let closing: Promise<void> | null = null;
  return {
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const { socket, child } of carried) {
          socket.destroy();
          if (child.exitCode === null && child.signalCode === null) child.kill();
        }
      });
      return closing;
    },
  };
}
