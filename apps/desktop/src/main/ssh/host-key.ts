/**
 * Host-key pre-check. The ssh options used for the real connection check host
 * keys strictly (StrictHostKeyChecking=yes), so a new key can only get into
 * known_hosts through this file: before the first connection the server's key
 * (and the key of every ProxyJump hop on the way) is read, compared with the
 * user's and the system-wide known_hosts, and shown. The connection only
 * follows once the user has confirmed a new key, and that exact key is written
 * to known_hosts first, so ssh then checks the server against what was shown.
 */
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

import type { DesktopSshConfigSummary, DesktopSshHopKey, DesktopSshHostKeyCheck } from '../../shared/contract-ssh';
import { entriesFor, hostFieldMatches, keyFingerprint, parseKnownHostsText, type KnownHostEntry } from './known-hosts';
import { mixdogKnownHostsFile, registerUserKnownHosts } from './mixdog-ssh-config';
import { isSshMissingMessage, sshToolCommand, WINDOWS_SSH_CLIENT_COMMAND } from './ssh-binary';
import { parseSshTarget, sshTargetLabel, type SshTarget } from './ssh-command';
import { createPrivateDir } from './ssh-private-dir';

export { keyFingerprint } from './known-hosts';

export interface ToolResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
/** Runs one OpenSSH tool (`ssh`, `ssh-keyscan`, `ssh-keygen`, `ssh-add`, `sc.exe`) to completion. */
export type RunTool = (command: string, args: readonly string[], timeoutMs: number) => Promise<ToolResult>;

export const runTool: RunTool = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(sshToolCommand(command), [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new Error(
          error.code === 'ENOENT'
            ? `The OpenSSH client (${command}) was not found on PATH.`
            : `${command} failed to start: ${error.message}`
        )
      );
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

export interface HostKeyLine {
  /** known_hosts host field (plain, hashed or a comma list). */
  hosts: string;
  type: string;
  key: string;
}

/** `host type base64` lines; comments and @cert-authority / @revoked markers are skipped. */
export function parseKeyLines(text: string): HostKeyLine[] {
  return parseKnownHostsText(text)
    .filter((entry) => !entry.marker)
    .map(({ hosts, type, key }) => ({ hosts, type, key }));
}

const KEY_LABELS: Array<[RegExp, string]> = [
  [/^ssh-ed25519$/, 'ED25519'],
  [/^ecdsa-/, 'ECDSA'],
  [/^ssh-rsa$/, 'RSA'],
  [/^sk-ssh-ed25519/, 'ED25519-SK'],
  [/^sk-ecdsa-/, 'ECDSA-SK'],
  [/^ssh-dss$/, 'DSA'],
];
function keyTypeLabel(type: string): string {
  return KEY_LABELS.find(([pattern]) => pattern.test(type))?.[1] ?? type;
}

const DEFAULT_ALGORITHM_ORDER = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
];

/** HostKeyAlgorithms as key types: certificate and rsa-sha2 variants fold into their key type, order kept. */
function normalizeAlgorithms(list: readonly string[]): string[] {
  const types: string[] = [];
  for (const algorithm of list) {
    const type = algorithm.replace(/-cert-v01@openssh\.com$/, '').replace(/^rsa-sha2-(?:256|512)$/, 'ssh-rsa');
    if (!types.includes(type)) types.push(type);
  }
  return types;
}

export interface ResolvedHost {
  hostname: string;
  port: number;
  user: string | null;
  knownHostsFiles: string[];
  globalKnownHostsFiles: string[];
  /** Key types in the order ssh will try them. */
  hostKeyAlgorithms: string[];
  proxyJump: string | null;
  proxyCommand: boolean;
  proxied: boolean;
  /** LocalForward / RemoteForward / DynamicForward lines of the resolved config. */
  forwards: string[];
}

interface ConfigContext {
  home: string;
  env: NodeJS.ProcessEnv;
}

const expandHome = (path: string, home: string): string =>
  path === '~' || /^~[\\/]/.test(path) ? join(home, path.slice(1)) : path;

/** Splits an `ssh -G` list of file paths. ssh prints them space-separated and, on
 *  some builds, without quotes even when a path has spaces (a profile folder named
 *  "John Doe"): a word that does not look like the start of a path belongs to the
 *  path before it. */
function splitPaths(value: string): string[] {
  const paths: string[] = [];
  for (const match of value.matchAll(/"([^"]*)"|(\S+)/g)) {
    const word = match[1] ?? match[2];
    const startsPath =
      match[1] !== undefined || /^(~|\/|[A-Za-z]:[\\/]|%|\.{1,2}[\\/]|none$|__PROGRAMDATA__)/.test(word);
    if (startsPath || paths.length === 0) paths.push(word);
    else paths[paths.length - 1] += ` ${word}`;
  }
  return paths;
}

/** What `ssh -G` says about the destination: the real host name and port
 *  (after ~/.ssh/config), the known_hosts files, the key types it will try and any proxy. */
export function parseSshConfigDump(stdout: string, context: Partial<ConfigContext> = {}): ResolvedHost | null {
  const home = context.home ?? homedir();
  const env = context.env ?? process.env;
  const values = new Map<string, string>();
  const forwards: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\S+)\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (/^(?:local|remote|dynamic)forward$/.test(key))
      forwards.push(`${key.replace('forward', '')} ${match[2].trim()}`);
    if (!values.has(key)) values.set(key, match[2].trim());
  }
  const hostname = values.get('hostname');
  const port = Number(values.get('port') ?? 22);
  if (!hostname || !Number.isInteger(port)) return null;
  const files = (list: string): string[] => splitPaths(list).filter((file) => file !== 'none');
  const declaredJump = values.get('proxyjump');
  const proxyJump = declaredJump && declaredJump !== 'none' ? declaredJump : null;
  const hasJump = proxyJump !== null;
  const hasCommand = Boolean(values.get('proxycommand')) && values.get('proxycommand') !== 'none';
  const global = files(values.get('globalknownhostsfile') ?? '').map((file) =>
    file.replace(/^__PROGRAMDATA__/, () => env.ProgramData ?? env.ALLUSERSPROFILE ?? 'C:\\ProgramData')
  );
  return {
    hostname,
    port,
    user: values.get('user') ?? null,
    knownHostsFiles: files(values.get('userknownhostsfile') ?? '~/.ssh/known_hosts').map((file) =>
      expandHome(file, home)
    ),
    globalKnownHostsFiles: global,
    hostKeyAlgorithms: normalizeAlgorithms((values.get('hostkeyalgorithms') ?? '').split(',').filter(Boolean)),
    proxyJump,
    proxyCommand: hasCommand,
    proxied: hasJump || hasCommand,
    forwards: forwards.slice(0, 8),
  };
}

const summarizeHost = (host: ResolvedHost): DesktopSshConfigSummary => ({
  hostName: host.hostname,
  user: host.user,
  port: host.port,
  proxyJump: host.proxyJump,
  proxyCommand: host.proxyCommand,
});

/** How known_hosts writes the host: bare on port 22, `[host]:port` otherwise. */
const knownHostsSpec = (hostname: string, port: number): string => (port === 22 ? hostname : `[${hostname}]:${port}`);

export interface HostKeyInspection {
  check: DesktopSshHostKeyCheck;
  /** known_hosts line(s) to save once the user confirms an unknown key. */
  pin?: { line: string; file: string };
  /** Changed key: what replacing it removes and then pins (after the user typed the host name). */
  replace?: { spec: string; file: string; line: string; host: string };
  summary?: DesktopSshConfigSummary;
}

export interface InspectDeps {
  run?: RunTool;
  /** File text, or null when it does not exist. */
  readText?: (file: string) => Promise<string | null>;
  /** Reads the key of the server (and each hop) through its proxy configuration. */
  scanViaProxy?: (target: SshTarget, scope?: ScanScope) => Promise<{ entries: KnownHostEntry[]; error: string }>;
  /** Mixdog's own known_hosts (new pins go there); null: none, pins go to the user's file. Defaults to the configured one. */
  mixdogKnownHosts?: string | null;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

const SCAN_TIMEOUT_MS = 12_000;
const PROXY_SCAN_TIMEOUT_MS = 30_000;
const TOOL_TIMEOUT_MS = 8_000;

const readTextFile = (file: string): Promise<string | null> => readFile(file, 'utf8').catch(() => null);

const quoted = (path: string): string => `"${path.replace(/\\/g, '/')}"`;

export interface ScanPlace {
  platform?: NodeJS.Platform;
  /** Where temporary files go; defaults to the OS temp folder. */
  tmp?: string;
  env?: NodeJS.ProcessEnv;
  /** The Windows account that gets the private folder; defaults to the signed-in account. */
  user?: string;
}

/**
 * A folder only this user can use, for the throwaway ssh config. ssh starts the
 * jump host's own ssh with `-F <that config>` as one unquoted word, so on Windows a
 * temp folder under a profile like "John Doe" breaks it: such a PC gets a random
 * folder under a per-user ProgramData folder, both locked to the user (Windows
 * OpenSSH refuses a config that other accounts can write).
 */
export async function privateScanDir(
  run: RunTool,
  { platform = process.platform, tmp = tmpdir(), env = process.env, user = userInfo().username }: ScanPlace = {}
): Promise<string> {
  if (platform !== 'win32' || !/\s/.test(tmp)) return mkdtemp(join(tmp, 'mxk-'));
  const root = join(env.ProgramData ?? 'C:\\ProgramData', `mixdog-ssh-scan-${user.replace(/[^A-Za-z0-9._-]/g, '_')}`);
  return createPrivateDir(run, root, 'mxk-', { platform, user });
}

/** What a through-the-proxy read of one server may do. */
export interface ScanScope {
  /** The jump hosts to dial through instead of the configured route: the hops before the one being read (already trusted). Absent: the configured route. */
  via?: string[];
  /** The host name ssh resolves the server to; its login is switched off and its key accepted unseen. `*`: the whole route (a ProxyCommand). */
  open: string;
  /** known_hosts lines of the hops already trusted, so a changed key on the way stops the read. */
  trusted?: string;
}

const SAFE_HOST_PATTERN = /^[A-Za-z0-9._:%[\]-]+$/;

/**
 * Reads the key of one server behind ProxyJump / ProxyCommand: ssh dials through
 * the route with a throwaway known_hosts. The server being read gets no login at
 * all (PreferredAuthentications=none, no keys, no passwords) and its key is accepted
 * unseen so it can be recorded; every hop on the way is checked strictly against the
 * keys already trusted. The remote command is a plain `true`, and nothing is
 * trusted until the user confirms.
 */
export function scanThroughSsh(
  run: RunTool,
  home: string,
  place: ScanPlace = {}
): (target: SshTarget, scope?: ScanScope) => Promise<{ entries: KnownHostEntry[]; error: string }> {
  return async (target, scope = { open: '*' }) => {
    if (scope.open !== '*' && !SAFE_HOST_PATTERN.test(scope.open))
      throw new Error('The host name cannot be read through a proxy.');
    const dir = await privateScanDir(run, place);
    try {
      const known = join(dir, 'known_hosts');
      const config = join(dir, 'config');
      await writeFile(known, scope.trusted ? `${scope.trusted}\n` : '');
      const noLogin = [
        '  PreferredAuthentications none',
        '  PubkeyAuthentication no',
        '  PasswordAuthentication no',
        '  KbdInteractiveAuthentication no',
        '  StrictHostKeyChecking no',
      ];
      await writeFile(
        config,
        [
          scope.open === '*' ? 'Host *' : `Match host "${scope.open}"`,
          ...noLogin,
          'Host *',
          `  UserKnownHostsFile ${quoted(known)}`,
          '  GlobalKnownHostsFile none',
          '  StrictHostKeyChecking yes',
          '  HashKnownHosts no',
          '  BatchMode yes',
          '  ForwardAgent no',
          '  ClearAllForwardings yes',
          '  LogLevel ERROR',
          '',
          `Include ${quoted(join(home, '.ssh', 'config'))}`,
          '',
        ].join('\n')
      );
      const route =
        scope.via === undefined ? [] : ['-o', `ProxyJump=${scope.via.length > 0 ? scope.via.join(',') : 'none'}`];
      const result = await run(
        'ssh',
        [
          '-F',
          config,
          '-o',
          'ConnectTimeout=10',
          ...route,
          '-T',
          ...(target.port ? ['-p', String(target.port)] : []),
          '--',
          target.destination,
          'true',
        ],
        PROXY_SCAN_TIMEOUT_MS
      );
      return { entries: parseKnownHostsText((await readTextFile(known)) ?? ''), error: result.stderr.trim() };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
interface Endpoint {
  /** What ssh is told to dial (a ProxyJump entry as written, or the target). */
  dest: SshTarget;
  part: string;
  name: string;
  role: 'jump' | 'target';
  host: ResolvedHost;
  spec: string;
}

type Verdict =
  | { status: 'trusted'; authority?: string }
  | { status: 'unreadable' }
  | { status: 'pending' }
  | { status: 'revoked'; fingerprint: string; keyType: string }
  | { status: 'unknown'; best: HostKeyLine }
  | { status: 'changed'; old: KnownEntry; current: HostKeyLine };

type KnownEntry = KnownHostEntry & { file: string };

function judge(endpoint: Endpoint, scanned: HostKeyLine[], known: KnownEntry[]): Verdict {
  const rank = (type: string): number => {
    const order = endpoint.host.hostKeyAlgorithms.length ? endpoint.host.hostKeyAlgorithms : DEFAULT_ALGORITHM_ORDER;
    const index = order.indexOf(type);
    return index < 0 ? order.length : index;
  };
  const byRank = [...scanned].sort((a, b) => rank(a.type) - rank(b.type));
  const matching = entriesFor(known, endpoint.spec);
  const plain = matching.filter((entry) => !entry.marker);
  if (byRank.length === 0) return plain.length > 0 ? { status: 'trusted' } : { status: 'unreadable' };
  // ssh refuses a revoked key whatever else it knows about the server.
  const revoked = byRank.find((line) => matching.some((entry) => entry.marker === 'revoked' && entry.key === line.key));
  if (revoked)
    return { status: 'revoked', fingerprint: keyFingerprint(revoked.key), keyType: keyTypeLabel(revoked.type) };
  if (byRank.some((line) => plain.some((entry) => entry.type === line.type && entry.key === line.key)))
    return { status: 'trusted' };
  for (const line of byRank) {
    const old = plain.find((entry) => entry.type === line.type);
    if (old) return { status: 'changed', old, current: line };
  }
  const authority = matching.find((entry) => entry.marker === 'cert-authority');
  if (authority && plain.length === 0) return { status: 'trusted', authority: keyFingerprint(authority.key) };
  return { status: 'unknown', best: byRank[0] };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const unreachableInspection = (
  text: string,
  platform: NodeJS.Platform,
  summary?: DesktopSshConfigSummary
): HostKeyInspection => ({
  check: {
    status: 'unreachable',
    message: text,
    ...(isSshMissingMessage(text)
      ? { sshMissing: { command: platform === 'win32' ? WINDOWS_SSH_CLIENT_COMMAND : null } }
      : {}),
  },
  summary,
});

interface Scanner {
  /** The keys a plain ssh-keyscan of the server returns. */
  keyscan(endpoint: Endpoint): Promise<HostKeyLine[]>;
  /** Reads one server through the route, keeping only the entries for it. */
  readThrough(endpoint: Endpoint, scope: ScanScope): Promise<HostKeyLine[]>;
  /** What the last read reported on stderr, or why it failed. */
  error(): string;
}

function createScanner(run: RunTool, viaProxy: NonNullable<InspectDeps['scanViaProxy']>): Scanner {
  let scanError = '';
  return {
    async keyscan(endpoint) {
      try {
        const scan = await run(
          'ssh-keyscan',
          [
            '-T',
            '8',
            '-p',
            String(endpoint.host.port),
            '-t',
            keyscanTypes(endpoint.host.hostKeyAlgorithms),
            '--',
            endpoint.host.hostname,
          ],
          SCAN_TIMEOUT_MS
        );
        scanError = scan.stderr.trim();
        return parseKeyLines(scan.stdout);
      } catch (error) {
        scanError = message(error);
        return [];
      }
    },
    async readThrough(endpoint, scope) {
      try {
        const { entries, error } = await viaProxy(endpoint.dest, scope);
        scanError = error;
        return entries
          .filter((entry) => !entry.marker && hostFieldMatches(entry.hosts, endpoint.spec))
          .map(({ type, key }) => ({ hosts: endpoint.spec, type, key }));
      } catch (error) {
        scanError = message(error);
        return [];
      }
    },
    error: () => scanError,
  };
}

/** The keys each server presents, by known_hosts spec; `unread` holds the endpoints left for the next check. */
async function scanEndpoints(
  endpoints: Endpoint[],
  host: ResolvedHost,
  known: KnownEntry[],
  scanner: Scanner
): Promise<{ scannedBySpec: Map<string, HostKeyLine[]>; unread: Set<number> }> {
  const scannedBySpec = new Map<string, HostKeyLine[]>();
  const unread = new Set<number>();
  if (!host.proxied) {
    scannedBySpec.set(endpoints[0].spec, await scanner.keyscan(endpoints[0]));
  } else if (!host.proxyJump) {
    // ProxyCommand: the whole route is the target's, and nothing logs in to it.
    scannedBySpec.set(endpoints[0].spec, await scanner.readThrough(endpoints[0], { open: '*' }));
  } else {
    // ProxyJump, hop by hop: a server is read through the hops before it only
    // once they are trusted (their keys are checked strictly on the way, and no
    // login is made to the server being read). The first hop that needs the
    // user's confirmation ends the reading; the ones behind it wait for the next check.
    for (let index = 0; index < endpoints.length; index += 1) {
      const endpoint = endpoints[index];
      const trusted = endpoints
        .slice(0, index)
        .flatMap((earlier) => entriesFor(known, earlier.spec))
        .map((entry) => `${entry.marker ? `@${entry.marker} ` : ''}${entry.hosts} ${entry.type} ${entry.key}`)
        .join('\n');
      const lines =
        index === 0 && !endpoint.host.proxied
          ? await scanner.keyscan(endpoint)
          : await scanner.readThrough(endpoint, {
              open: endpoint.host.hostname,
              ...(index > 0 ? { via: endpoints.slice(0, index).map((earlier) => earlier.part) } : {}),
              trusted,
            });
      scannedBySpec.set(endpoint.spec, lines);
      if (judge(endpoint, lines, known).status !== 'trusted') {
        for (let later = index + 1; later < endpoints.length; later += 1) unread.add(later);
        break;
      }
    }
  }
  return { scannedBySpec, unread };
}

/** What each server on the way shows the user. */
const hopKeys = (endpoints: Endpoint[], verdicts: Verdict[]): DesktopSshHopKey[] =>
  endpoints.map((endpoint, index) => {
    const verdict = verdicts[index];
    const base = { name: endpoint.name, role: endpoint.role };
    switch (verdict.status) {
      case 'unknown':
        return {
          ...base,
          status: 'unknown',
          fingerprint: keyFingerprint(verdict.best.key),
          keyType: keyTypeLabel(verdict.best.type),
        };
      case 'changed':
        return {
          ...base,
          status: 'changed',
          fingerprint: keyFingerprint(verdict.current.key),
          keyType: keyTypeLabel(verdict.current.type),
        };
      case 'revoked':
        return { ...base, status: 'revoked', fingerprint: verdict.fingerprint, keyType: verdict.keyType };
      case 'unreadable':
        return { ...base, status: 'unreadable' };
      case 'pending':
        return { ...base, status: 'pending' };
      default:
        return { ...base, status: 'trusted' };
    }
  });

/** The inspection of a server whose key differs from the one known; replaceable only when the old key is in Mixdog's own known_hosts. */
function changedInspection(
  verdict: Extract<Verdict, { status: 'changed' }>,
  { spec, host }: Endpoint,
  { ownFile, home, chain }: { ownFile: string | null; home: string; chain: { hops?: DesktopSshHopKey[] } }
): Pick<HostKeyInspection, 'check' | 'replace'> {
  const defaultFile = join(home, '.ssh', 'known_hosts');
  const removeCommand = `ssh-keygen -R "${spec}"${verdict.old.file === defaultFile ? '' : ` -f "${verdict.old.file}"`}`;
  // Only Mixdog's own known_hosts is edited from here; a key in the user's file is theirs to remove.
  const editable = Boolean(ownFile) && verdict.old.file === ownFile;
  return {
    check: {
      status: 'changed',
      previous: keyFingerprint(verdict.old.key),
      current: keyFingerprint(verdict.current.key),
      keyType: keyTypeLabel(verdict.current.type),
      host: host.hostname,
      removeCommand,
      replaceable: editable,
      ...chain,
    },
    ...(editable
      ? {
          replace: {
            spec,
            file: verdict.old.file,
            line: `${spec} ${verdict.current.type} ${verdict.current.key}`,
            host: host.hostname,
          },
        }
      : {}),
  };
}

/** Every server on the way (each ProxyJump hop, then the target), resolved; or why one could not be read. */
async function routeEndpoints(
  target: SshTarget,
  host: ResolvedHost,
  resolve: (destination: SshTarget) => Promise<ResolvedHost>
): Promise<{ endpoints: Endpoint[] } | { error: string }> {
  const endpoints: Endpoint[] = [];
  if (host.proxyJump) {
    for (const part of host.proxyJump.split(',')) {
      try {
        const hopTarget = parseSshTarget(part.replace(/^ssh:\/\//, ''));
        const hop = await resolve(hopTarget);
        endpoints.push({
          dest: hopTarget,
          part: part.trim().replace(/^ssh:\/\//, ''),
          name: part.trim(),
          role: 'jump',
          host: hop,
          spec: knownHostsSpec(hop.hostname, hop.port),
        });
      } catch (error) {
        return { error: `The jump host ${part.trim()} could not be read: ${message(error)}` };
      }
    }
  }
  endpoints.push({
    dest: target,
    part: target.display,
    name: sshTargetLabel(target),
    role: 'target',
    host,
    spec: knownHostsSpec(host.hostname, host.port),
  });
  return { endpoints };
}

const keyscanTypes = (algorithms: readonly string[]): string => {
  const wanted = new Set<string>();
  for (const type of algorithms) {
    if (type === 'ssh-ed25519') wanted.add('ed25519');
    else if (type.startsWith('ecdsa-')) wanted.add('ecdsa');
    else if (type === 'ssh-rsa') wanted.add('rsa');
  }
  return wanted.size ? [...wanted].join(',') : 'ed25519,ecdsa,rsa';
};

export async function inspectHostKey(target: SshTarget, deps: InspectDeps = {}): Promise<HostKeyInspection> {
  const run = deps.run ?? runTool;
  const readText = deps.readText ?? readTextFile;
  const home = deps.home ?? homedir();
  const env = deps.env ?? process.env;
  const resolve = async (destination: SshTarget): Promise<ResolvedHost> => {
    const dump = await run(
      'ssh',
      ['-G', ...(destination.port ? ['-p', String(destination.port)] : []), '--', destination.destination],
      TOOL_TIMEOUT_MS
    );
    const host = dump.code === 0 ? parseSshConfigDump(dump.stdout, { home, env }) : null;
    if (!host) throw new Error(dump.stderr.trim() || 'ssh could not read its configuration for this address.');
    return host;
  };
  const unreachable = (text: string, summary?: DesktopSshConfigSummary): HostKeyInspection =>
    unreachableInspection(text, deps.platform ?? process.platform, summary);

  let host: ResolvedHost;
  try {
    host = await resolve(target);
  } catch (error) {
    return unreachable(message(error));
  }
  const summary = summarizeHost(host);

  const route = await routeEndpoints(target, host, resolve);
  if ('error' in route) return unreachable(route.error, summary);
  const { endpoints } = route;

  const ownFile = deps.mixdogKnownHosts === undefined ? mixdogKnownHostsFile() : deps.mixdogKnownHosts;
  const userFiles = endpoints.flatMap((endpoint) => endpoint.host.knownHostsFiles);
  await registerUserKnownHosts(userFiles);
  const files = [...new Set([...(ownFile ? [ownFile] : []), ...userFiles, ...host.globalKnownHostsFiles])];
  const known: KnownEntry[] = [];
  for (const file of files) {
    const text = await readText(file);
    if (text) known.push(...parseKnownHostsText(text).map((entry) => ({ ...entry, file })));
  }

  const scanner = createScanner(run, deps.scanViaProxy ?? scanThroughSsh(run, home));
  const { scannedBySpec, unread } = await scanEndpoints(endpoints, host, known, scanner);
  const scanError = scanner.error();
  const verdicts: Verdict[] = endpoints.map((endpoint, index) =>
    unread.has(index) ? { status: 'pending' } : judge(endpoint, scannedBySpec.get(endpoint.spec) ?? [], known)
  );
  const hops = hopKeys(endpoints, verdicts);
  const chain = endpoints.length > 1 ? { hops } : {};

  const revoked = verdicts.flatMap((verdict, index) => (verdict.status === 'revoked' ? [{ verdict, index }] : []))[0];
  if (revoked) {
    return {
      check: {
        status: 'revoked',
        fingerprint: revoked.verdict.fingerprint,
        host: endpoints[revoked.index].host.hostname,
      },
      summary,
    };
  }
  const changed = verdicts.flatMap((verdict, index) => (verdict.status === 'changed' ? [{ verdict, index }] : []))[0];
  if (changed) {
    return {
      ...changedInspection(changed.verdict, endpoints[changed.index], { ownFile, home, chain }),
      summary,
    };
  }
  if (verdicts.some((verdict) => verdict.status === 'unreadable')) {
    const first = endpoints[verdicts.findIndex((verdict) => verdict.status === 'unreadable')];
    const detail = scanError
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('#'))
      .join('\n')
      .trim();
    return unreachable(
      detail || `Could not read the host key of ${endpoints.length > 1 ? first.name : target.display}.`,
      summary
    );
  }
  const unknown = verdicts.flatMap((verdict, index) =>
    verdict.status === 'unknown' ? [{ best: verdict.best, spec: endpoints[index].spec }] : []
  );
  const shown = unknown[unknown.length - 1];
  if (shown) {
    return {
      check: {
        status: 'unknown',
        fingerprint: keyFingerprint(shown.best.key),
        keyType: keyTypeLabel(shown.best.type),
        ...chain,
      },
      pin: {
        line: unknown.map(({ spec, best }) => `${spec} ${best.type} ${best.key}`).join('\n'),
        file: ownFile ?? host.knownHostsFiles[0] ?? join(home, '.ssh', 'known_hosts'),
      },
      summary,
    };
  }
  const authority = verdicts
    .map((verdict) => (verdict.status === 'trusted' ? verdict.authority : undefined))
    .find(Boolean);
  return { check: { status: 'trusted', ...(authority ? { authority } : {}), ...chain }, summary };
}

/** Appends the confirmed key(s) to known_hosts. */
export async function pinHostKey(pin: { line: string; file: string }): Promise<void> {
  await mkdir(dirname(pin.file), { recursive: true, mode: 0o700 });
  let lead = '';
  try {
    const existing = await readFile(pin.file, 'utf8');
    if (existing && !existing.endsWith('\n')) lead = '\n';
  } catch {
    /* a new file */
  }
  await appendFile(pin.file, `${lead}${pin.line}\n`, { encoding: 'utf8', mode: 0o600 });
}

/** "키 교체": forgets the old key (ssh-keygen -R keeps a .old copy) and pins the one the server presents now. */
export async function replaceHostKey(
  replace: NonNullable<HostKeyInspection['replace']>,
  run: RunTool = runTool
): Promise<void> {
  const removed = await run('ssh-keygen', ['-R', replace.spec, '-f', replace.file], TOOL_TIMEOUT_MS);
  if (removed.code !== 0) throw new Error(removed.stderr.trim() || 'ssh-keygen could not remove the old key.');
  await pinHostKey({ line: replace.line, file: replace.file });
}
