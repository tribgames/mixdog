// Diagnostics for SSH connections: a small in-memory ring buffer per server
// (ssh argv without secrets, stderr, the probe / bootstrap results, timings,
// tunnel starts and exits), the text a user can copy to report a problem, and
// the redaction both go through. Nothing here is written to disk.
import type { ChildProcess } from 'node:child_process';
import { arch, platform, release } from 'node:os';

import { sshTargetKey, type SshTarget } from './ssh-command';

export const DIAGNOSTICS_MAX_ENTRIES = 400;
const MAX_TEXT = 600;
const MAX_ARG = 160;
const UNSCOPED = '*';

export type DiagnosticKind = 'ssh' | 'stderr' | 'result' | 'exit' | 'tunnel' | 'phase' | 'log';

export interface DiagnosticEntry {
  at: number;
  kind: DiagnosticKind;
  text: string;
}

const rings = new Map<string, DiagnosticEntry[]>();

/** Which server's ring an ssh of this target writes to. */
export const diagnosticsKeyFor = (target: SshTarget): string => sshTargetKey(target);

// Daemon tokens, bearer headers, passwords, pairing codes and long secret-looking values.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [
    /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSPHRASE|API_KEY)[A-Za-z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
    '$1=<redacted>',
  ],
  [/\b(token|secret|password|passphrase|authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2<redacted>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '<redacted>'],
  [/\b[A-Za-z0-9_-]{40,}\b/g, '<redacted>'],
];

/** Text with every secret-looking value removed. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The server's user and host names, in the forms they appear in. Names of 3 characters or fewer are only replaced next to an `@` (see redactServer): on their own they would hit ordinary words. */
export function serverNames(target: SshTarget, extra: readonly string[] = []): string[] {
  const at = target.destination.lastIndexOf('@');
  const names = [
    target.display,
    target.destination,
    at >= 0 ? target.destination.slice(0, at) : '',
    target.destination.slice(at + 1),
    ...extra,
  ];
  return [...new Set(names.map((name) => name.trim()).filter((name) => name.length > 0))].sort(
    (a, b) => b.length - a.length
  );
}

/** Text with the server's user and host replaced by <server>, for text that leaves this PC. */
export function redactServer(text: string, names: readonly string[]): string {
  let out = text;
  for (const name of names) {
    const escaped = escapeRegExp(name);
    const alone = `(?<![A-Za-z0-9._-])${escaped}(?![A-Za-z0-9_-])`;
    // A short name is replaced only as the user or the host of a user@host pair.
    const pattern =
      name.length > SHORT_NAME_MAX
        ? alone
        : `(?<![A-Za-z0-9._-])${escaped}(?=@[A-Za-z0-9])|(?<=[A-Za-z0-9._-]@)${escaped}(?![A-Za-z0-9_-])`;
    out = out.replace(new RegExp(pattern, 'gi'), '<server>');
  }
  return out;
}

const SHORT_NAME_MAX = 3;

const clip = (text: string, max = MAX_TEXT): string =>
  text.length > max ? `${text.slice(0, max)}…(${text.length} chars)` : text;

/** Adds a line to a server's ring (secrets are removed on the way in). */
export function appendDiagnostic(key: string | undefined, kind: DiagnosticKind, text: string, at = Date.now()): void {
  const ring = rings.get(key ?? UNSCOPED) ?? [];
  rings.set(key ?? UNSCOPED, ring);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    ring.push({ at, kind, text: clip(redactSecrets(trimmed)) });
  }
  if (ring.length > DIAGNOSTICS_MAX_ENTRIES) ring.splice(0, ring.length - DIAGNOSTICS_MAX_ENTRIES);
}

export const readDiagnostics = (key: string): DiagnosticEntry[] => [...(rings.get(key) ?? [])];

const stamp = (at: number): string => new Date(at).toISOString().slice(11, 23);

/** The ring as log lines: `12:00:01.234 stderr message`. */
export const diagnosticLines = (key: string, last = DIAGNOSTICS_MAX_ENTRIES): string[] =>
  readDiagnostics(key)
    .slice(-last)
    .map((entry) => `${stamp(entry.at)} ${entry.kind.padEnd(6)} ${entry.text}`);

/** The argument list of an ssh run, without anything long (the remote script) or secret. */
export function describeArgv(command: string, args: readonly string[]): string {
  return [command.replace(/^.*[\\/]/, ''), ...args.map((arg) => clip(redactSecrets(arg), MAX_ARG))].join(' ');
}

/** Records one spawned ssh tool: its argv, stderr, bootstrap result lines, exit and duration, and the tunnel's starts and exits. */
export function traceSpawn(
  command: string,
  args: readonly string[],
  child: ChildProcess,
  key: string | undefined,
  now: () => number = Date.now
): void {
  const started = now();
  const tunnel = args.includes('-N');
  appendDiagnostic(key, tunnel ? 'tunnel' : 'ssh', `${tunnel ? 'start ' : ''}${describeArgv(command, args)}`, started);
  let results = '';
  child.stdout?.on('data', (chunk: Buffer | string) => {
    if (results.length > 65_536) return;
    results += chunk.toString();
    const lines = results.split(/\r?\n/);
    results = lines.pop() ?? '';
    for (const line of lines) if (line.startsWith('MIXDOG_')) appendDiagnostic(key, 'result', line, now());
  });
  child.stderr?.on('data', (chunk: Buffer | string) => appendDiagnostic(key, 'stderr', chunk.toString(), now()));
  child.once('error', (error: Error) => appendDiagnostic(key, 'exit', `could not start: ${error.message}`, now()));
  child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
    if (results.startsWith('MIXDOG_')) appendDiagnostic(key, 'result', results, now());
    const ended = now();
    appendDiagnostic(
      key,
      tunnel ? 'tunnel' : 'exit',
      `${tunnel ? 'exited ' : ''}${signal ? `signal ${signal}` : `code ${code}`} after ${ended - started} ms`,
      ended
    );
  });
}

export interface DiagnosticsInput {
  key: string;
  target: SshTarget;
  appVersion: string;
  sshVersion: string;
  /** What `ssh -G` resolved, as `key value` lines worth showing. */
  config: readonly string[];
  /** Host names that appear only after config resolution (HostName, jump hosts). */
  extraNames?: readonly string[];
  lines?: number;
}

/** The report a user can copy: environment, the resolved config summary and the last log lines — with the server's user and host replaced by <server> and no secrets. */
export function buildDiagnosticsText(input: DiagnosticsInput): string {
  const text = [
    'Mixdog SSH diagnostics',
    `App: ${input.appVersion}`,
    `OS: ${platform()} ${release()} (${arch()})`,
    `ssh: ${input.sshVersion || 'unknown'}`,
    'Config:',
    ...input.config.map((line) => `  ${line}`),
    `Log (last ${input.lines ?? 100} lines):`,
    ...diagnosticLines(input.key, input.lines ?? 100),
  ].join('\n');
  return redactServer(redactSecrets(text), serverNames(input.target, input.extraNames));
}

/** Test seam. */
export function resetDiagnostics(): void {
  rings.clear();
}
