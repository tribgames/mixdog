/** Pipe adapter; Rust owns UAC/authentication/deadlines/cleanup, the pool owns jobs/ledgers. */
import type { spawn } from 'node:child_process';
import { computerNativeBinary, computerNativeEnvironment } from './native-host';
import type { PowerShellResponse } from '../shared/types';
import type { ProcessIdentity } from './inactive-ledger-registry';
import { MAX_COMPUTER_INTERNAL_REQUEST_BYTES } from '../../../shared/core-src/runtime/computer-bridge/limits.mjs';

export async function runElevatedRequest(options: {
  request: Record<string, unknown>;
  id: number;
  directory: string;
  inputMarker: string;
  inactiveLedger: string;
  spawnProcess: typeof spawn;
  onWorkerIdentity?: (identity: ProcessIdentity) => void;
  begin: (cancel: () => void) => { finish(stopped: boolean): void };
}): Promise<PowerShellResponse> {
  const line = `${JSON.stringify({
    request: { ...options.request, id: options.id },
    inputMarker: options.inputMarker,
    inactiveLedger: options.inactiveLedger,
  })}\n`;
  if (Buffer.byteLength(line) > MAX_COMPUTER_INTERNAL_REQUEST_BYTES)
    throw new Error('computer_capacity_exhausted: worker request budget exceeded; input was not dispatched');
  let stopped = false;
  let child: ReturnType<typeof spawn> | undefined;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    if (child?.stdin?.writable) child.stdin.write('{"cancel":true}\n');
  };
  const job = options.begin(cancel);
  try {
    return await new Promise<PowerShellResponse>((resolve, reject) => {
      try {
        child = options.spawnProcess(computerNativeBinary(), ['--elevated-launch'], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: computerNativeEnvironment(options.inputMarker),
        });
      } catch (error) {
        stopped = true;
        reject(error);
        return;
      }
      let pending = '';
      let stderr = '';
      let receipt: { stopped?: boolean; error?: string; response?: PowerShellResponse } | undefined;
      let protocolError: Error | undefined;
      // Last-resort transport watchdog: killing a launcher never confirms its worker stopped.
      const timer = setTimeout(() => {
        cancel();
        child?.kill();
        reject(new Error('privileged_worker_cleanup_unconfirmed: elevated input did not acknowledge cancellation'));
      }, 127_000);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (protocolError) return;
        pending += chunk;
        if (Buffer.byteLength(pending) > MAX_COMPUTER_INTERNAL_REQUEST_BYTES) {
          protocolError = new Error('privileged_worker_failed: structured response is too large');
          pending = '';
          cancel();
          return;
        }
        let at: number;
        while ((at = pending.indexOf('\n')) >= 0) {
          const row = pending.slice(0, at);
          pending = pending.slice(at + 1);
          try {
            const value = JSON.parse(row);
            if (
              value.kind === 'identity' &&
              Number.isSafeInteger(value.pid) &&
              value.pid > 0 &&
              typeof value.startTicks === 'string' &&
              /^[1-9]\d*$/.test(value.startTicks)
            ) {
              options.onWorkerIdentity?.({ pid: value.pid, startTicks: value.startTicks });
            } else if (value.kind === 'result' && !receipt && typeof value.stopped === 'boolean') {
              receipt = value;
              child?.stdin?.end(); // Native joins its control reader after the final receipt.
            } else throw new Error('invalid receipt');
          } catch {
            protocolError = new Error('privileged_worker_rejected: invalid native receipt');
            cancel();
          }
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4096);
      });
      child.stdin?.on('error', (error) => {
        protocolError = error;
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        if (!child?.pid) stopped = true;
        reject(error);
      });
      // close, not exit: stdout may still hold the final receipt at process exit.
      child.once('close', (code) => {
        clearTimeout(timer);
        if (protocolError) {
          reject(protocolError);
          return;
        }
        if (!receipt) {
          // Preserve the original launcher failure classes without confusing
          // its exit with proof that an elevated input worker stopped.
          if (code === 1223) {
            stopped = true;
            reject(new Error('privileged_worker_cancelled: UAC consent was declined'));
          } else if (code === 0) {
            reject(new Error('privileged_worker_unavailable: elevated worker returned no response'));
          } else {
            const detail = `${stderr}\n${pending}`.trim().replace(/\s+/g, ' ').slice(0, 1000);
            reject(
              new Error(
                `privileged_worker_launcher_failed: elevated worker exited with code ${code ?? 1}${detail ? ` (${detail})` : ''}`
              )
            );
          }
          return;
        }
        stopped = receipt.stopped === true;
        if (receipt.error) {
          reject(new Error(receipt.error));
          return;
        }
        if (!stopped) {
          reject(new Error('privileged_worker_cleanup_unconfirmed: elevated worker did not confirm termination'));
          return;
        }
        if (receipt.response?.id !== options.id) {
          reject(new Error('privileged_worker_rejected: response id mismatch'));
          return;
        }
        resolve(receipt.response);
      });
      child.stdin?.write(line);
      if (cancelled) cancel();
    });
  } finally {
    job.finish(stopped);
  }
}
