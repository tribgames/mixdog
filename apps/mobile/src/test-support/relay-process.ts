// The relay as a process for the phone's end-to-end tests: the Node relay (`node apps/relay/server.mjs`) or the Rust relay (the
// `mixdog-relay` binary built under native/core/target), each on port 0 with a scratch DATA_DIR, the port read from the listening line.
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RelayRuntime = 'node' | 'rust';

export interface RelayProcess {
  readonly runtime: RelayRuntime;
  readonly port: number;
  /** `http://127.0.0.1:<port>`: also the Origin a browser page served by this relay presents. */
  readonly origin: string;
  /** Ends the process and removes its scratch directory. */
  stop(): Promise<void>;
}

export interface StartRelayOptions {
  /** Written as `mobile-release.json` beside the program. Only the Rust relay is run from a scratch copy of its binary, so only it takes this. */
  readonly mobileRelease?: unknown;
}

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const nodeServer = join(root, 'apps', 'relay', 'server.mjs');
const START_LIMIT_MS = 30_000;
const STOP_LIMIT_MS = 10_000;
const CARGO_FIX = 'cargo build -p mixdog-relay --offline (run in native/core)';

/** Whether the Node relay is in this tree (its deletion task removes it). */
export function nodeRelayPresent(): boolean {
  return existsSync(nodeServer);
}

/** The newest built `mixdog-relay` under the cargo target directory, or the cargo command that builds it. */
export function rustRelayBinary(): string {
  const exe = process.platform === 'win32' ? 'mixdog-relay.exe' : 'mixdog-relay';
  const targets = [process.env.CARGO_TARGET_DIR, join(root, 'native', 'core', 'target')].filter((dir): dir is string => Boolean(dir));
  const found = targets
    .flatMap((target) => ['release', 'debug'].map((profile) => join(target, profile, exe)))
    .filter((file) => existsSync(file))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (found.length === 0) throw new Error(`the Rust relay is not built: run ${CARGO_FIX}`);
  return found[0]!;
}

const listeningPort = (line: string): number | null => {
  const match = /^\[relay\] (?:http|https) listening on :(\d+)/.exec(line);
  return match ? Number(match[1]) : null;
};

export async function startRelay(runtime: RelayRuntime, options: StartRelayOptions = {}): Promise<RelayProcess> {
  const scratch = mkdtempSync(join(tmpdir(), `mixdog-relay-${runtime}-`));
  const dataDir = join(scratch, 'data');
  mkdirSync(dataDir);
  let program: string;
  let args: string[];
  if (runtime === 'node') {
    if (!nodeRelayPresent()) throw new Error(`the Node relay is not in this tree: ${nodeServer} is missing`);
    if (options.mobileRelease !== undefined) throw new Error('the Node relay reads mobile-release.json beside its own files: it is not run with one');
    program = process.execPath;
    args = [nodeServer];
  } else {
    const binary = rustRelayBinary();
    if (options.mobileRelease !== undefined) {
      // The relay reads the file beside its executable: the scratch copy carries it.
      program = join(scratch, basename(binary));
      copyFileSync(binary, program);
      writeFileSync(join(scratch, 'mobile-release.json'), JSON.stringify(options.mobileRelease));
    } else {
      program = binary;
    }
    args = [];
  }
  const lines: string[] = [];
  const child: ChildProcess = spawn(program, args, {
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const seen: { port: number | null } = { port: null };
  let waiting: (() => void) | null = null;
  const collect = (stream: NodeJS.ReadableStream | null): void => {
    let pending = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      pending += chunk;
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        lines.push(line);
        seen.port ??= listeningPort(line);
        waiting?.();
      }
    });
  };
  collect(child.stdout);
  collect(child.stderr);
  const cleanup = (): void => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, STOP_LIMIT_MS).unref())]);
    cleanup();
  };
  const started = await new Promise<'listening' | 'exited' | 'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), START_LIMIT_MS);
    const settle = (outcome: 'listening' | 'exited'): void => {
      clearTimeout(timer);
      waiting = null;
      resolve(outcome);
    };
    waiting = () => {
      if (seen.port !== null) settle('listening');
    };
    void exited.then(() => settle('exited'));
    if (seen.port !== null) settle('listening');
  });
  if (started !== 'listening' || seen.port === null) {
    await stop();
    throw new Error(`the ${runtime} relay ${started === 'exited' ? 'exited' : 'printed no listening line'} before listening: ${lines.join(' | ')}`);
  }
  return { runtime, port: seen.port, origin: `http://127.0.0.1:${seen.port}`, stop };
}
