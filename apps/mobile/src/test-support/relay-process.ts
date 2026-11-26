// The relay as a process for the phone's end-to-end tests: the Node relay (`node apps/relay/server.mjs`) or the Rust relay (the
// `mixdog-relay` binary built from this tree), each on port 0 with a scratch DATA_DIR, the port read from the listening line.
import { spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
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

export interface RustRelayBinaryOptions {
  readonly repoRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly gatePoolRoot?: string;
}

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const nodeServer = join(root, 'apps', 'relay', 'server.mjs');
const START_LIMIT_MS = 30_000;
const STOP_LIMIT_MS = 10_000;
const GATE_POOL_ROOT = 'C:\\mixdog-build\\pool';
const GATE_SCRIPT = 'C:\\mixdog-build\\tools\\cargo-gate.ps1';
const RELAY_CRATES = ['mixdog-relay', 'mixdog-js', 'mixdog-fsio', 'mixdog-rt', 'mixdog-workspace-hack'] as const;
const IGNORED_DIRS = new Set(['tests', 'target', 'node_modules']);

function cargoFix(platform: NodeJS.Platform): string {
  if (platform === 'win32' && existsSync(GATE_SCRIPT)) {
    return `${GATE_SCRIPT} build -p mixdog-relay (run in native/core)`;
  }
  return 'cargo build -p mixdog-relay (run in native/core)';
}

/** Whether the Node relay is in this tree (its deletion task removes it). */
export function nodeRelayPresent(): boolean {
  return existsSync(nodeServer);
}

interface SourceTimestamp {
  readonly path: string;
  readonly mtimeMs: number;
}

function newestInTree(entry: string, newest: SourceTimestamp | null): SourceTimestamp | null {
  if (!existsSync(entry)) return newest;
  const info = statSync(entry);
  if (info.isFile()) {
    return !newest || info.mtimeMs > newest.mtimeMs ? { path: entry, mtimeMs: info.mtimeMs } : newest;
  }
  if (!info.isDirectory()) return newest;
  let current = newest;
  for (const child of readdirSync(entry, { withFileTypes: true })) {
    if (child.isDirectory() && IGNORED_DIRS.has(child.name)) continue;
    current = newestInTree(join(entry, child.name), current);
  }
  return current;
}

function newestRelaySource(repoRoot: string): SourceTimestamp | null {
  const inputs = [
    ...RELAY_CRATES.map((crate) => join(repoRoot, 'native', 'core', 'crates', crate)),
    join(repoRoot, 'native', 'core', 'vendor', 'regress'),
    join(repoRoot, 'native', 'core', 'vendor', 'icu_collator'),
    join(repoRoot, 'native', 'core', 'Cargo.toml'),
    join(repoRoot, 'native', 'core', 'Cargo.lock'),
    join(repoRoot, 'rust-toolchain.toml'),
  ];
  let newest: SourceTimestamp | null = null;
  for (const input of inputs) newest = newestInTree(input, newest);
  return newest;
}

function foreignCheckoutSource(binary: string, repoRoot: string, platform: NodeJS.Platform): string | null {
  const depInfo = `${binary.replace(/\.exe$/i, '')}.d`;
  if (!existsSync(depInfo)) return null;
  const text = readFileSync(depInfo, 'utf8');
  const colon = text.indexOf(': ');
  if (colon < 0) return null;
  const listed = text.slice(colon + 2).split(/\r?\n/, 1)[0]?.trim() ?? '';
  const sources = listed
    .split(/(?<!\\) /)
    .map((entry) => entry.replaceAll('\\ ', ' '))
    .filter(Boolean);
  const normalize = (value: string): string => {
    const slashed = value.replaceAll('\\', '/').replace(/\/+$/, '');
    return platform === 'win32' ? slashed.toLowerCase() : slashed;
  };
  const rootPrefix = `${normalize(repoRoot)}/`;
  for (const source of sources) {
    const normalized = normalize(source);
    if (normalized.includes('/native/core/crates/') && !normalized.startsWith(rootPrefix)) return source;
  }
  return null;
}

/**
 * The up-to-date `mixdog-relay` binary for this checkout (preferring a dev `debug` build over `release`, and checking the Windows
 * cargo-gate target pool alongside `CARGO_TARGET_DIR` and `native/core/target`). Refuses binaries older than the relay sources or
 * built from another checkout so tests never run against a stale binary.
 */
export function rustRelayBinary(options: RustRelayBinaryOptions = {}): string {
  const repoRoot = resolve(options.repoRoot ?? root);
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const gatePoolRoot = options.gatePoolRoot ?? GATE_POOL_ROOT;
  const exe = platform === 'win32' ? 'mixdog-relay.exe' : 'mixdog-relay';
  const targets = [
    ...new Set(
      [
        env.CARGO_TARGET_DIR,
        ...(platform === 'win32'
          ? [
              join(gatePoolRoot, `${basename(repoRoot)}-light-target`),
              join(gatePoolRoot, `${basename(repoRoot)}-target`),
            ]
          : []),
        join(repoRoot, 'native', 'core', 'target'),
      ].filter((dir): dir is string => Boolean(dir))
    ),
  ];
  const candidatesFor = (profile: 'debug' | 'release'): string[] =>
    targets
      .map((target) => join(target, profile, exe))
      .filter((file) => existsSync(file))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  const debugBins = candidatesFor('debug');
  const releaseBins = candidatesFor('release');
  const newestSource = newestRelaySource(repoRoot);
  const stale: Array<{ binary: string; mtimeMs: number }> = [];
  const foreign: Array<{ binary: string; source: string }> = [];

  for (const binary of [...debugBins, ...releaseBins]) {
    const foreignSource = foreignCheckoutSource(binary, repoRoot, platform);
    if (foreignSource) {
      foreign.push({ binary, source: foreignSource });
      continue;
    }
    const mtimeMs = statSync(binary).mtimeMs;
    if (newestSource && mtimeMs < newestSource.mtimeMs) {
      stale.push({ binary, mtimeMs });
      continue;
    }
    return binary;
  }

  const fix = cargoFix(platform);
  if (stale.length > 0 && newestSource) {
    const newestStale = stale.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]!;
    const sourceRel = relative(repoRoot, newestSource.path).replaceAll('\\', '/');
    throw new Error(
      `the Rust relay binary is older than the sources (${newestStale.binary} < ${sourceRel}): rebuild a dev build with ${fix}`
    );
  }
  if (foreign.length > 0) {
    throw new Error(
      `the Rust relay binary ${foreign[0]!.binary} was built from another checkout (${foreign[0]!.source}): rebuild a dev build with ${fix}`
    );
  }
  throw new Error(`the Rust relay is not built: run ${fix}`);
}

const listeningPort = (line: string): number | null => {
  const match = /^\[relay\] (?:http|https) listening on :(\d+)/.exec(line);
  return match ? Number(match[1]) : null;
};

function relayCommand(
  runtime: RelayRuntime,
  scratch: string,
  options: StartRelayOptions
): { program: string; args: string[] } {
  if (runtime === 'node') {
    if (!nodeRelayPresent()) throw new Error(`the Node relay is not in this tree: ${nodeServer} is missing`);
    if (options.mobileRelease !== undefined)
      throw new Error('the Node relay reads mobile-release.json beside its own files: it is not run with one');
    return { program: process.execPath, args: [nodeServer] };
  }
  const binary = rustRelayBinary();
  if (options.mobileRelease === undefined) return { program: binary, args: [] };
  // The relay reads the file beside its executable: the scratch copy carries it.
  const program = join(scratch, basename(binary));
  copyFileSync(binary, program);
  writeFileSync(join(scratch, 'mobile-release.json'), JSON.stringify(options.mobileRelease));
  return { program, args: [] };
}

export async function startRelay(runtime: RelayRuntime, options: StartRelayOptions = {}): Promise<RelayProcess> {
  const scratch = mkdtempSync(join(tmpdir(), `mixdog-relay-${runtime}-`));
  const dataDir = join(scratch, 'data');
  mkdirSync(dataDir);
  const { program, args } = relayCommand(runtime, scratch, options);
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
    throw new Error(
      `the ${runtime} relay ${started === 'exited' ? 'exited' : 'printed no listening line'} before listening: ${lines.join(' | ')}`
    );
  }
  return { runtime, port: seen.port, origin: `http://127.0.0.1:${seen.port}`, stop };
}
