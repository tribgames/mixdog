import { spawn, type ChildProcess } from 'node:child_process';

import { classifySshFailure, SshError, sshExecArgs, stderrTail, type SshTarget } from './ssh-command';
import { prepareSshSpawn } from './ssh-auth';
import { traceSpawn } from './ssh-diagnostics';
import { currentSshContext } from './ssh-context';

export type SshSpawn = (
  command: string,
  args: readonly string[],
  options: { windowsHide: boolean; stdio: ['pipe' | 'ignore', 'pipe', 'pipe'] }
) => ChildProcess;

/** Spawns the system OpenSSH tool. Under a connect attempt (ssh-context.ts) it also adds the
 *  attempt's identity file and, during the interactive retry, the askpass helper. */
export const defaultSshSpawn: SshSpawn = (command, args, options) => {
  const context = currentSshContext();
  const prepared = prepareSshSpawn(command, args, context);
  const child = spawn(prepared.command, prepared.args, { ...options, ...(prepared.env ? { env: prepared.env } : {}) });
  traceSpawn(command, prepared.args, child, context?.diagnosticsKey);
  return child;
};

export interface SshExecOptions {
  target: SshTarget;
  /** Remote command line, interpreted by the login shell on the server. */
  command: string;
  /** Bytes streamed to the remote command's stdin. */
  input?: Buffer;
  /** Hard deadline: the ssh child is killed when it passes. */
  timeoutMs: number;
  spawnImpl?: SshSpawn;
}

export interface SshExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

/** Kill an ssh child we started when this process exits for any reason; an
 *  orphaned ssh.exe on Windows would otherwise outlive the app. */
export function killWithProcess(child: ChildProcess): () => void {
  const kill = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };
  process.once('exit', kill);
  return () => process.removeListener('exit', kill);
}

/** Run one remote command over a fresh ssh connection. Resolves with the
 *  remote exit code; rejects with SshError when ssh itself failed (exit 255,
 *  spawn failure, deadline). */
export function sshExec({
  target,
  command,
  input,
  timeoutMs,
  spawnImpl = defaultSshSpawn,
}: SshExecOptions): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnImpl('ssh', sshExecArgs(target, command), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(
        new SshError(`Could not start ssh: ${error instanceof Error ? error.message : String(error)}`, 'terminal')
      );
      return;
    }
    const release = killWithProcess(child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    let timedOut = false;
    let settled = false;
    const capture = (sink: Buffer[]) => (chunk: Buffer) => {
      if (captured >= MAX_CAPTURE_BYTES) return;
      captured += chunk.length;
      sink.push(chunk);
    };
    child.stdout?.on('data', capture(stdout));
    child.stderr?.on('data', capture(stderr));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref?.();
    const finish = (outcome: SshError | SshExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      release();
      if (outcome instanceof SshError) reject(outcome);
      else resolve(outcome);
    };
    child.once('error', (error: NodeJS.ErrnoException) => {
      const missing = error.code === 'ENOENT';
      finish(
        new SshError(
          missing ? 'The OpenSSH client (ssh) was not found on PATH.' : `ssh failed to start: ${error.message}`,
          'terminal'
        )
      );
    });
    child.once('close', (code, signal) => {
      const err = Buffer.concat(stderr).toString('utf8');
      const tail = stderrTail(err);
      if (timedOut) {
        finish(
          new SshError(
            `ssh ${target.display} timed out after ${timeoutMs} ms.${tail ? `\n${tail}` : ''}`,
            'transient',
            tail
          )
        );
        return;
      }
      if (code === null || code === 255) {
        const kind = classifySshFailure(err);
        const reason = tail || (signal ? `ssh exited on ${signal}` : 'ssh exited with status 255');
        finish(new SshError(`ssh ${target.display} failed:\n${reason}`, kind, tail, code));
        return;
      }
      finish({ exitCode: code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: err });
    });
    child.stdin?.on('error', () => {
      /* the close handler reports why the remote side stopped reading */
    });
    child.stdin?.end(input ?? undefined);
  });
}
