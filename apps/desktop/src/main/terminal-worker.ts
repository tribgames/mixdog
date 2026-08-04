// Terminal utility-process entry: hosts every dock PTY outside the Electron
// main process. PTY floods (onData fan-out, replay buffering) now consume
// this worker's event loop instead of blocking window management and IPC in
// main — the same isolation VS Code gets from its separate ptyHost process.
import { TerminalManager } from './terminal-manager';
import {
  terminalMessageData,
  type TerminalWorkerInbound,
  type TerminalWorkerOutbound,
} from './terminal-worker-protocol';

interface UtilityParentPort {
  postMessage(message: TerminalWorkerOutbound): void;
  on(event: 'message', listener: (event: { data?: unknown } | unknown) => void): unknown;
  start?(): void;
}

const parentPort = (process as NodeJS.Process & { parentPort?: UtilityParentPort }).parentPort;
if (!parentPort) throw new Error('Mixdog terminal worker requires an Electron utility-process parent port.');

const manager = new TerminalManager();

function post(message: TerminalWorkerOutbound): void {
  try {
    parentPort!.postMessage(message);
  } catch { /* the parent owns transport failures via its exit handler */ }
}

manager.subscribe((event) => post({ kind: 'data', id: event.id, data: event.data }));

async function handleEnsure(message: Extract<TerminalWorkerInbound, { kind: 'ensure' }>): Promise<void> {
  try {
    const value = await manager.ensure(message.id, message.cwd, message.profile ?? null);
    post({ kind: 'ensure-result', requestId: message.requestId, ok: true, value });
  } catch (error) {
    post({
      kind: 'ensure-result',
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

parentPort.on('message', (event) => {
  const value = terminalMessageData(event);
  if (!value || typeof value !== 'object') return;
  const message = value as TerminalWorkerInbound;
  switch (message.kind) {
    case 'ensure':
      if (Number.isSafeInteger(message.requestId)) void handleEnsure(message);
      return;
    case 'write':
      manager.write(String(message.id || ''), String(message.data ?? ''));
      return;
    case 'resize':
      manager.resize(String(message.id || ''), Number(message.cols), Number(message.rows));
      return;
    case 'pause':
      manager.pauseOutput(String(message.id || ''));
      return;
    case 'resume':
      manager.resumeOutput(String(message.id || ''));
      return;
    case 'dispose':
      manager.dispose(String(message.id || ''));
      return;
    case 'dispose-all':
      manager.disposeAll();
      process.exit(0);
  }
});
parentPort.start?.();

// PTY children must never outlive the worker: kill them on every exit path
// (SIGTERM from utilityProcess.kill, dispose-all above, crashes).
process.once('SIGTERM', () => {
  manager.disposeAll();
  process.exit(0);
});
process.once('exit', () => {
  try { manager.disposeAll(); } catch { /* best-effort teardown */ }
});
