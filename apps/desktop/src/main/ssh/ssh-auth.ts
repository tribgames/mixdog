/**
 * Interactive login for ssh children that BatchMode cannot serve: a passphrase
 * for a protected key, a password, or a keyboard-interactive code. The first
 * try of every connection stays BatchMode=yes; only a refused login is retried
 * with SSH_ASKPASS pointing at a tiny helper. The helper dials back into this
 * process over a private socket (a named pipe on Windows) and presents a
 * per-attempt random token; main asks the user in the window that connects and
 * hands the answer back. Answers live in memory for the attempt only.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { runTool, type RunTool } from './host-key';
import { mixdogSshConfigFile } from './mixdog-ssh-config';
import { sshToolCommand } from './ssh-binary';
import type { SshRunContext } from './ssh-context';
import { targetSshConfigFor } from './ssh-resolved-config';
import { createPrivateDir } from './ssh-private-dir';

/** `otp`: a code the server asks for. `other`: any server text that is neither a passphrase, a password nor a recognizable code. */
export type AskpassKind = 'passphrase' | 'password' | 'otp' | 'other';

export interface AskpassRequest {
  kind: AskpassKind;
  /** The prompt exactly as ssh printed it. */
  prompt: string;
  /** The answer given before for this prompt was refused. */
  retry: boolean;
}

/** Resolves with the user's answer, or null when they cancelled. `signal` aborts when the prompt timed out. */
export type AskpassAsk = (request: AskpassRequest, signal: AbortSignal) => Promise<string | null>;

export interface AskpassSession {
  /** Environment that points an ssh child at the helper and this session. */
  readonly env: Readonly<Record<string, string>>;
  /** Folder for ssh's connection-sharing socket (macOS / Linux only). */
  readonly controlDir: string | null;
  readonly closed: boolean;
  /** The user dismissed or timed out a prompt of this session. */
  readonly cancelled: boolean;
  close(): Promise<void>;
}

export interface AskpassOptions {
  ask: AskpassAsk;
  /** Folder (a plain path) that holds the per-session private subfolder of the helper files. */
  helperDir: string;
  /** Runs icacls for the private subfolder (Windows). */
  run?: RunTool;
  user?: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  /** An answer asked for again within this time is taken as refused by the server. */
  retryWindowMs?: number;
  now?: () => number;
}

export const ASKPASS_TIMEOUT_MS = 120_000;
const RETRY_WINDOW_MS = 2_000;
const MAX_REQUEST_BYTES = 64 * 1024;

const CODE_PROMPT = /verification|one-time|otp|\bcode\b|token|passcode|authenticator|\bpin\b|duo|yubikey/i;

/** What a prompt asks for. Text the server supplies that is not clearly a code is `other`, never taken for a one-time code. */
export function classifyPrompt(prompt: string): AskpassKind {
  if (/passphrase/i.test(prompt)) return 'passphrase';
  if (CODE_PROMPT.test(prompt)) return 'otp';
  if (/password/i.test(prompt)) return 'password';
  return 'other';
}

// The helper ssh runs as SSH_ASKPASS: ask main (token + prompt over the socket),
// print the answer, exit 0; exit 1 when the user cancelled or main is gone.
const HELPER_SCRIPT = `'use strict';
const net = require('net');
const prompt = process.argv.slice(2).join(' ');
const endpoint = process.env.MIXDOG_ASKPASS_ENDPOINT;
const token = process.env.MIXDOG_ASKPASS_TOKEN;
if (!endpoint || !token) process.exit(2);
let done = false;
let buffer = '';
const socket = net.connect(endpoint);
socket.setEncoding('utf8');
socket.on('connect', () => socket.write(JSON.stringify({ token, prompt }) + '\\n'));
socket.on('data', (chunk) => {
  buffer += chunk;
  const end = buffer.indexOf('\\n');
  if (end < 0 || done) return;
  done = true;
  let reply = null;
  try { reply = JSON.parse(buffer.slice(0, end)); } catch { /* refused below */ }
  if (reply && reply.ok === true && typeof reply.secret === 'string') {
    process.stdout.write(reply.secret + '\\n', () => process.exit(0));
  } else {
    process.exit(1);
  }
});
socket.on('error', () => { if (!done) process.exit(1); });
socket.on('close', () => { if (!done) process.exit(1); });
`;
const POSIX_WRAPPER = `#!/bin/sh
exec "$MIXDOG_ASKPASS_NODE" "$(dirname "$0")/askpass.cjs" "$@"
`;
const WINDOWS_WRAPPER = `@echo off\r\n"%MIXDOG_ASKPASS_NODE%" "%~dp0askpass.cjs" %*\r\n`;

async function writeIfChanged(file: string, content: string, mode?: number): Promise<void> {
  try {
    if ((await readFile(file, 'utf8')) === content) return;
  } catch {
    /* new file */
  }
  await writeFile(file, content, { encoding: 'utf8', mode });
  if (mode !== undefined) await chmod(file, mode);
}

/** Writes the helper files; returns the path ssh must run as SSH_ASKPASS. */
export async function ensureAskpassHelper(dir: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeIfChanged(join(dir, 'askpass.cjs'), HELPER_SCRIPT);
  if (platform === 'win32') {
    const script = join(dir, 'askpass.cmd');
    await writeIfChanged(script, WINDOWS_WRAPPER);
    return script;
  }
  const script = join(dir, 'askpass.sh');
  await writeIfChanged(script, POSIX_WRAPPER, 0o755);
  return script;
}

const sameToken = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Where the helper reaches main: a named pipe on Windows, a socket in a private folder elsewhere (`folder`, removed on close). */
async function helperEndpoint(platform: NodeJS.Platform): Promise<{ endpoint: string; folder: string | null }> {
  if (platform === 'win32') {
    return { endpoint: `\\\\.\\pipe\\mixdog-askpass-${randomBytes(12).toString('hex')}`, folder: null };
  }
  const folder = await mkdtemp(join(tmpdir(), 'mxa-'));
  await chmod(folder, 0o700);
  return { endpoint: join(folder, 's'), folder };
}

/** Puts the prompts in front of the user and remembers what they answered. */
function createAsker(
  ask: AskpassAsk,
  { now, timeoutMs, retryWindowMs }: { now: () => number; timeoutMs: number; retryWindowMs: number }
): { answer(prompt: string): Promise<string | null>; readonly cancelled: boolean; forget(): void } {
  let cancelled = false;
  // password / passphrase answers, reused for the attempt's later handshakes;
  // one-time codes are never reused.
  const answers = new Map<string, { secret: string; at: number }>();
  return {
    async answer(prompt) {
      const kind = classifyPrompt(prompt);
      const known = answers.get(prompt);
      const reusable = kind === 'passphrase' || kind === 'password';
      const retry = known !== undefined && reusable && now() - known.at < retryWindowMs;
      if (known && reusable && !retry) {
        known.at = now();
        return known.secret;
      }
      answers.delete(prompt);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      timer.unref?.();
      try {
        const secret = await Promise.race([
          ask({ kind, prompt, retry }, abort.signal),
          new Promise<null>((resolve) => abort.signal.addEventListener('abort', () => resolve(null), { once: true })),
        ]);
        if (secret === null) {
          cancelled = true;
          return null;
        }
        if (reusable) answers.set(prompt, { secret, at: now() });
        return secret;
      } finally {
        clearTimeout(timer);
        abort.abort();
      }
    },
    get cancelled() {
      return cancelled;
    },
    forget: () => answers.clear(),
  };
}

/** One helper connection: a JSON line with the token and the prompt in, a JSON line with the answer out. */
function serveHelperConnection(
  socket: Socket,
  options: { token: string; timeoutMs: number; isClosed(): boolean; answer(prompt: string): Promise<string | null> }
): void {
  socket.setEncoding('utf8');
  socket.setTimeout(options.timeoutMs + 5_000, () => socket.destroy());
  let buffer = '';
  let handled = false;
  const reply = (body: { ok: boolean; secret?: string }): void => {
    socket.end(`${JSON.stringify(body)}\n`);
  };
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_REQUEST_BYTES) return socket.destroy();
    const end = buffer.indexOf('\n');
    if (end < 0 || handled) return;
    handled = true;
    let request: { token?: unknown; prompt?: unknown } = {};
    try {
      request = JSON.parse(buffer.slice(0, end));
    } catch {
      return reply({ ok: false });
    }
    if (
      options.isClosed() ||
      typeof request.token !== 'string' ||
      !sameToken(request.token, options.token) ||
      typeof request.prompt !== 'string'
    ) {
      return reply({ ok: false });
    }
    void options.answer(request.prompt).then(
      (secret) => reply(secret === null ? { ok: false } : { ok: true, secret }),
      () => reply({ ok: false })
    );
  });
  socket.on('error', () => undefined);
}

export async function startAskpassSession(options: AskpassOptions): Promise<AskpassSession> {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? ASKPASS_TIMEOUT_MS;
  const retryWindowMs = options.retryWindowMs ?? RETRY_WINDOW_MS;
  // A random folder for this session alone, locked to the user before the helper is written.
  const sessionDir = await createPrivateDir(options.run ?? runTool, options.helperDir, 'mxa-', {
    platform,
    user: options.user,
  });
  const script = await ensureAskpassHelper(sessionDir, platform).catch(async (error) => {
    await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  });
  const token = randomBytes(24).toString('hex');
  const { endpoint, folder } = await helperEndpoint(platform);

  let closed = false;
  const sockets = new Set<Socket>();
  const asker = createAsker(options.ask, { now, timeoutMs, retryWindowMs });
  let queue: Promise<unknown> = Promise.resolve();
  // Prompts are answered one at a time, in the order they arrive.
  const answerInOrder = (prompt: string): Promise<string | null> => {
    const run = queue.then(() => (closed ? null : asker.answer(prompt)));
    queue = run.catch(() => null);
    return run;
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    serveHelperConnection(socket, { token, timeoutMs, isClosed: () => closed, answer: answerInOrder });
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (platform !== 'win32') await chmod(endpoint, 0o600).catch(() => undefined);

  return {
    env: {
      SSH_ASKPASS: script,
      MIXDOG_ASKPASS_ENDPOINT: endpoint,
      MIXDOG_ASKPASS_TOKEN: token,
      MIXDOG_ASKPASS_NODE: process.execPath,
      ELECTRON_RUN_AS_NODE: '1',
    },
    controlDir: folder,
    get closed() {
      return closed;
    },
    get cancelled() {
      return asker.cancelled;
    },
    async close() {
      if (closed) return;
      closed = true;
      asker.forget();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
      if (folder) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export interface PreparedSpawn {
  command: string;
  args: string[];
  /** Undefined: inherit this process's environment unchanged. */
  env?: NodeJS.ProcessEnv;
}

const expandHome = (path: string): string =>
  path === '~' || /^~[\\/]/.test(path) ? join(homedir(), path.slice(1)) : path;

/** What `defaultSshSpawn` really runs: the resolved ssh binary, the attempt's
 *  identity file, and — only while an interactive retry is running — the
 *  askpass environment with BatchMode off. */
export function prepareSshSpawn(
  command: string,
  args: readonly string[],
  context: SshRunContext | undefined,
  platform: NodeJS.Platform = process.platform,
  baseEnv: NodeJS.ProcessEnv = process.env,
  sshConfigFile: string | null = mixdogSshConfigFile()
): PreparedSpawn {
  let list = [...args];
  let env: NodeJS.ProcessEnv | undefined;
  if (command === 'ssh') {
    // Mixdog's own known_hosts and config (also read by a jump host's ssh); a caller that passes its own -F keeps it.
    // The target's own generated config when there is one (resolved options, no forwards), else the generic one.
    const configFile = targetSshConfigFor(list) ?? sshConfigFile;
    if (configFile && !list.includes('-F')) list = ['-F', configFile, ...list];
    const identityFile = context?.settings?.identityFile?.trim();
    if (identityFile) list = ['-i', expandHome(identityFile), '-o', 'IdentitiesOnly=yes', ...list];
    const session = context?.askpass;
    if (session && !session.closed) {
      list = list.map((arg) => (arg === 'BatchMode=yes' ? 'BatchMode=no' : arg));
      // One login for the attempt's short commands: the first ssh keeps a master
      // that the rest reuse. The long-lived tunnel (-N) only joins one, so it
      // never turns into a background master the supervisor would lose.
      if (session.controlDir && platform !== 'win32') {
        const joins = list.includes('-N');
        list = list.map((arg) => {
          if (arg === 'ControlMaster=no') return joins ? arg : 'ControlMaster=auto';
          if (arg === 'ControlPath=none') return `ControlPath=${session.controlDir}/%C`;
          return arg;
        });
        if (!joins) list = ['-o', 'ControlPersist=30', ...list];
      }
      env = { ...baseEnv, ...session.env, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: baseEnv.DISPLAY || 'localhost:0' };
    }
  }
  return { command: sshToolCommand(command), args: list, env };
}
