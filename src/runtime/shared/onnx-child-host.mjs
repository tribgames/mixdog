// Child-process host for the ONNX runtimes (effort judge, memory embedder).
// onnxruntime-node runs on native threads: an uncaught native exception or an
// out-of-memory abort there ends the whole process (exit 0xE06D7363), which in
// a worker_threads Worker meant the daemon. `ChildWorker` is a drop-in for the
// `Worker` surface the clients use (postMessage / on message|error|exit /
// terminate / unref), backed by a forked child, so a native crash ends only the
// child and surfaces as an ordinary 'exit' event.
//
// The host entry files import `parentPort` and `workerData` from here: inside a
// Worker thread (tests) they are the worker_threads ones, inside a child they
// are an IPC adapter with the same shape.
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { isMainThread, parentPort as threadPort, workerData as threadData, Worker } from 'node:worker_threads';
import { workerExecArgv } from './worker-exec-argv.mjs';

const DATA_ENV = 'MIXDOG_ONNX_HOST_DATA';

export class ChildWorker extends EventEmitter {
  #child;
  #exited;
  #gone = false;

  constructor(path, { workerData, env = process.env, execArgv = workerExecArgv() } = {}) {
    super();
    // 'advanced' serialization keeps typed numbers (NaN, -0) exactly as a
    // worker's structured clone did, so vectors stay bit-identical.
    const child = fork(path, [], {
      execArgv,
      env: { ...env, [DATA_ENV]: JSON.stringify(workerData ?? null) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
      windowsHide: true,
    });
    this.#child = child;
    this.#exited = new Promise((resolve) => child.once('close', resolve));
    child.stderr.on('data', (chunk) => {
      try {
        process.stderr.write(chunk);
      } catch {
        /* diagnostic only */
      }
    });
    child.on('message', (msg) => this.emit('message', msg));
    child.on('error', (error) => this.emit('error', error));
    child.on('exit', (code) => this.#ended(code ?? 1));
  }

  // 'exit' is emitted once, by whichever notices first: the process handle's
  // event or a look at the process.
  #ended(code) {
    if (this.#gone) return;
    this.#gone = true;
    this.emit('exit', code);
  }

  /**
   * Whether the host process has ended, heard of or not. On a busy Windows
   * machine the 'exit' event of a hard-killed host arrived 0.7–21 s after the
   * process was gone, and a client that queues behind its host stayed blocked
   * that long. Asking the process handle answers at once; a host found dead is
   * reported through 'exit' here.
   */
  exited() {
    if (this.#gone) return true;
    if (this.#child.exitCode === null && this.#child.signalCode === null && this.#child.kill(0)) return false;
    this.#ended(this.#child.exitCode ?? 1);
    return true;
  }

  postMessage(msg) {
    // Posting into a dead host is dropped like a terminated Worker's.
    if (this.exited() || !this.#child.connected) return;
    this.#child.send(msg, () => {});
  }

  unref() {
    this.#child.unref();
    this.#child.channel?.unref?.();
    this.#child.stderr?.unref?.();
  }

  async terminate() {
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill('SIGKILL');
    // An unref'd child does not hold the event loop: a caller that awaits this
    // at shutdown would otherwise see the process end with the await pending.
    this.#child.ref();
    this.#ended(1);
    await this.#exited;
    return 1;
  }

  get pid() {
    return this.#child.pid;
  }
}

// A host whose main thread is inside a native call never runs its 'disconnect'
// handler. A thread of its own looks at the daemon and ends the process.
const PARENT_WATCH_MS = 2000;
function watchParent() {
  const watcher = new Worker(
    `const { workerData: { parent, self } } = require('node:worker_threads');
     setInterval(() => { try { process.kill(parent, 0); } catch { process.kill(self, 'SIGKILL'); } }, ${PARENT_WATCH_MS});`,
    { eval: true, workerData: { parent: process.ppid, self: process.pid } },
  );
  watcher.unref();
}

function childPort() {
  const port = new EventEmitter();
  port.postMessage = (msg) => process.send(msg);
  process.on('message', (msg) => port.emit('message', msg));
  // The daemon owns the child: when its IPC channel closes (daemon exit, crash
  // or kill) the host ends instead of lingering as an orphan. Ended with a kill, not
  // process.exit: exit runs the native runtime's teardown, which waits for a load or
  // an inference still running on its threads.
  process.on('disconnect', () => process.kill(process.pid, 'SIGKILL'));
  watchParent();
  return port;
}

function childData() {
  const raw = process.env[DATA_ENV];
  delete process.env[DATA_ENV];
  return raw ? JSON.parse(raw) : undefined;
}

const inChild = isMainThread && typeof process.send === 'function';
export const parentPort = inChild ? childPort() : threadPort;
export const workerData = inChild ? childData() : threadData;
