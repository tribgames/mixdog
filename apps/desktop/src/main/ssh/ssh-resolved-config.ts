// The ssh config Mixdog's own ssh invocations (probe, exec, tunnel) run with,
// built per target from what `ssh -G` resolves for it (the way orca's
// ssh-g-config-resolution does): every resolved option of the host and of each
// ProxyJump hop, except what forwards something (ports, agent, X11, local
// commands), and without including the user's config. A hop's ssh reads the
// same file (`-F` is passed on to it), so each hop gets its own `Host` block.
// Mixdog's known_hosts is listed first, then the user's files. The file is
// checked by resolving the target through it and comparing: when it does not say
// the same, nothing is written for the target and the caller falls back to the
// generic config that includes the user's file (and tells the user which
// forwards then apply).
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parseSshConfigDump, type RunTool, type ResolvedHost } from './host-key';
import { mixdogKnownHostsFile, mixdogSshDir, word } from './mixdog-ssh-config';
import { parseSshTarget, type SshTarget } from './ssh-command';

const TOOL_TIMEOUT_MS = 8_000;
const MAX_CHAIN = 6;

/** What forwards something or runs a local command: never carried into Mixdog's config. */
export const FORWARDING_KEYS: ReadonlySet<string> = new Set([
  'localforward',
  'remoteforward',
  'dynamicforward',
  'clearallforwardings',
  'forwardagent',
  'forwardx11',
  'forwardx11trusted',
  'forwardx11timeout',
  'gatewayports',
  'tunnel',
  'tunneldevice',
  'permitlocalcommand',
  'localcommand',
]);
/** Lines that would open another block, or are written by Mixdog itself. */
const SKIPPED_KEYS: ReadonlySet<string> = new Set([
  'host',
  'match',
  'include',
  'userknownhostsfile',
  'globalknownhostsfile',
]);
/** Values that are file names: quoted when they hold spaces, which some ssh builds print bare. */
const PATH_KEYS: ReadonlySet<string> = new Set([
  'identityfile',
  'certificatefile',
  'controlpath',
  'identityagent',
  'revokedhostkeys',
  'pkcs11provider',
  'securitykeyprovider',
]);

export type DumpLine = [key: string, value: string];

export function parseDump(stdout: string): DumpLine[] {
  const lines: DumpLine[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\S+)\s+(.*)$/.exec(line.trim());
    if (match) lines.push([match[1].toLowerCase(), match[2].trim()]);
  }
  return lines;
}

/** The forwards of a dump, as `local <from> <to>` lines. */
export const forwardsOf = (lines: readonly DumpLine[]): string[] =>
  lines
    .filter(([key]) => key === 'localforward' || key === 'remoteforward' || key === 'dynamicforward')
    .map(([key, value]) => `${key.replace('forward', '')} ${value}`);

/** What a faithful config must reproduce: the resolved options that are neither forwarding nor Mixdog's own, order and path separators aside. */
const comparable = (lines: readonly DumpLine[]): string[] =>
  lines
    .filter(([key]) => !FORWARDING_KEYS.has(key) && !SKIPPED_KEYS.has(key))
    .map(([key, value]) => `${key} ${value.replace(/\\/g, '/').replace(/"/g, '')}`)
    .sort();

interface Block {
  target: SshTarget;
  pattern: string;
  lines: DumpLine[];
  host: ResolvedHost;
}

const hostPart = (target: SshTarget): string => target.destination.slice(target.destination.lastIndexOf('@') + 1);

/** One `Host` block for a resolved server. */
export function resolvedBlockText(block: Pick<Block, 'pattern' | 'lines' | 'host'>, ownKnownHosts: string): string {
  const out = [
    `Host ${word(block.pattern)}`,
    `  UserKnownHostsFile ${[ownKnownHosts, ...block.host.knownHostsFiles].map(word).join(' ')}`,
  ];
  if (block.host.globalKnownHostsFiles.length > 0)
    out.push(`  GlobalKnownHostsFile ${block.host.globalKnownHostsFiles.map(word).join(' ')}`);
  for (const [key, value] of block.lines) {
    if (FORWARDING_KEYS.has(key) || SKIPPED_KEYS.has(key)) continue;
    out.push(`  ${key} ${PATH_KEYS.has(key) && /\s/.test(value) && !value.startsWith('"') ? word(value) : value}`);
  }
  return out.join('\n');
}

/** ssh -G prints characters the console code page lacks as ?: a path that went through that is not the user's path any more, and the config cannot carry it faithfully. */
const LOSSY = /[?\uFFFD]/;
const isLossy = (block: Pick<Block, 'lines' | 'host'>): boolean =>
  block.lines.some(([key, value]) => PATH_KEYS.has(key) && LOSSY.test(value)) ||
  [...block.host.knownHostsFiles, ...block.host.globalKnownHostsFiles].some((file) => LOSSY.test(file));

const portArgs = (target: SshTarget): string[] => (target.port ? ['-p', String(target.port)] : []);

async function resolveChain(run: RunTool, target: SshTarget, seen: Set<string>): Promise<Block[] | null> {
  if (seen.size >= MAX_CHAIN) return null;
  const dump = await run('ssh', ['-G', ...portArgs(target), '--', target.destination], TOOL_TIMEOUT_MS).catch(
    () => null
  );
  if (dump?.code !== 0) return null;
  const host = parseSshConfigDump(dump.stdout, { home: homedir(), env: process.env });
  if (!host) return null;
  const pattern = hostPart(target);
  seen.add(pattern);
  const blocks: Block[] = [{ target, pattern, lines: parseDump(dump.stdout), host }];
  if (host.proxyJump) {
    for (const part of host.proxyJump.split(',')) {
      let hop: SshTarget;
      try {
        hop = parseSshTarget(part.trim().replace(/^ssh:\/\//, ''));
      } catch {
        return null;
      }
      if (seen.has(hostPart(hop))) continue;
      const inner = await resolveChain(run, hop, seen);
      if (!inner) return null;
      blocks.push(...inner);
    }
  }
  return blocks;
}

// destination + port → the generated file.
const configs = new Map<string, string>();
const keyOf = (destination: string, port: string): string => `${destination}\u0000${port}`;

/** The generated config of the target an ssh argument list is for (`... -p N -- destination ...`), if one was built. */
export function targetSshConfigFor(args: readonly string[]): string | null {
  const dash = args.indexOf('--');
  const destination = dash >= 0 ? args[dash + 1] : undefined;
  if (!destination) return null;
  const before = args.slice(0, dash);
  const at = before.lastIndexOf('-p');
  return configs.get(keyOf(destination, at >= 0 ? (before[at + 1] ?? '') : '')) ?? null;
}

export interface TargetConfigResult {
  /** The target runs with its own generated config: no forward of the user's config applies. */
  resolved: boolean;
  /** When not resolved: the forwards the user's config applies to this connection (and its hops). */
  forwards: string[];
}

/**
 * Builds and verifies the generated config for `target`. `resolved: false` means
 * the generic config (which includes the user's) stays in use.
 */
export async function prepareTargetSshConfig(run: RunTool, target: SshTarget): Promise<TargetConfigResult> {
  const key = keyOf(target.destination, target.port ? String(target.port) : '');
  configs.delete(key);
  const own = mixdogKnownHostsFile();
  const dir = mixdogSshDir();
  const blocks = await resolveChain(run, target, new Set());
  if (!blocks) return { resolved: false, forwards: [] };
  const forwards = [...new Set(blocks.flatMap((block) => forwardsOf(block.lines)))].slice(0, 8);
  if (!own || !dir) return { resolved: false, forwards };
  const file = join(dir, `t-${createHash('sha256').update(key).digest('hex').slice(0, 12)}.conf`);
  const text = [
    '# Written by Mixdog from what ssh resolves for this server; forwards are left out.',
    ...blocks.map((block) => resolvedBlockText(block, own)),
    '',
  ].join('\n');
  if (blocks.some(isLossy)) return { resolved: false, forwards };
  await writeFile(file, text, 'utf8');
  // The file must say what ssh resolved, for the server and for every hop.
  for (const block of blocks) {
    const check = await run(
      'ssh',
      ['-G', '-F', file, ...portArgs(block.target), '--', block.target.destination],
      TOOL_TIMEOUT_MS
    ).catch(() => null);
    const again = check && check.code === 0 ? comparable(parseDump(check.stdout)) : null;
    if (!again || again.join('\n') !== comparable(block.lines).join('\n')) return { resolved: false, forwards };
  }
  configs.set(key, file);
  return { resolved: true, forwards: [] };
}

/** Test seam. */
export function resetTargetSshConfigs(): void {
  configs.clear();
}
