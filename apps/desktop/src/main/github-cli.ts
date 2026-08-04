// Settings → Git: GitHub CLI (gh) integration — presence probe, guided
// install (winget/brew), device-flow login through a PTY (gh insists on a
// TTY for `auth login`), logout, and the global git identity. Everything in
// this module is desktop-only surface; the remote shim never reaches it.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  DesktopGithubCliAccount,
  DesktopGithubCliLoginFlow,
  DesktopGithubCliStatus,
  DesktopGitGlobalConfig,
  DesktopGitGlobalConfigKey,
} from '../shared/contract';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(file: string, args: string[], timeout = 15_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
        return;
      }
      const failure = error as NodeJS.ErrnoException;
      if (failure.code === 'ENOENT') {
        resolve({ code: -1, stdout: '', stderr: 'ENOENT' });
        return;
      }
      resolve({
        code: typeof failure.code === 'number' ? failure.code : 1,
        stdout: String(stdout || ''),
        stderr: String(stderr || '') || failure.message,
      });
    });
  });
}

function ghPathCandidates(): string[] {
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const localAppData = process.env.LOCALAPPDATA || '';
    return [
      'gh',
      join(programFiles, 'GitHub CLI', 'gh.exe'),
      ...(localAppData ? [join(localAppData, 'Microsoft', 'WinGet', 'Links', 'gh.exe')] : []),
    ];
  }
  if (process.platform === 'darwin') return ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'];
  return ['gh', '/usr/bin/gh', '/usr/local/bin/gh'];
}

let cachedGh: { path: string; version: string } | null | undefined;

/** Resolve a working gh executable. Known install locations are probed too,
 *  so a just-installed gh is found before a fresh PATH ever reaches this
 *  (already-running) process. */
async function resolveGh(refresh = false): Promise<{ path: string; version: string } | null> {
  if (!refresh && cachedGh !== undefined) return cachedGh;
  for (const candidate of ghPathCandidates()) {
    if (candidate !== 'gh' && !existsSync(candidate)) continue;
    const probe = await run(candidate, ['--version']);
    if (probe.code === 0) {
      cachedGh = { path: candidate, version: /gh version (\S+)/.exec(probe.stdout)?.[1] || '' };
      return cachedGh;
    }
  }
  cachedGh = null;
  return null;
}

function loginFromAuthOutput(output: string): string {
  // gh ≥2.40 prints "✓ Logged in to github.com account <login> (keyring)";
  // older builds print "✓ Logged in to github.com as <login> (oauth_token)".
  return /account\s+(\S+)/.exec(output)?.[1]
    || /Logged in to \S+ as (\S+)/.exec(output)?.[1]
    || '';
}

export async function githubCliStatus(refresh = false): Promise<DesktopGithubCliStatus> {
  const gh = await resolveGh(refresh);
  if (!gh) return { installed: false, authenticated: false };
  const auth = await run(gh.path, ['auth', 'status', '--hostname', 'github.com']);
  const authenticated = auth.code === 0;
  const login = authenticated ? loginFromAuthOutput(`${auth.stdout}\n${auth.stderr}`) : '';
  return {
    installed: true,
    ...(gh.version ? { version: gh.version } : {}),
    authenticated,
    ...(login ? { login } : {}),
  };
}

const INSTALL_TIMEOUT_MS = 10 * 60_000;

export async function installGithubCli(): Promise<DesktopGithubCliStatus> {
  if (process.platform === 'win32') {
    const result = await run('winget', [
      'install', '--id', 'GitHub.cli', '--exact', '--source', 'winget',
      '--accept-package-agreements', '--accept-source-agreements',
      '--disable-interactivity',
    ], INSTALL_TIMEOUT_MS);
    if (result.code === -1) {
      throw new Error('winget is unavailable. Install GitHub CLI from https://cli.github.com and try again.');
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split('\n').filter(Boolean).pop();
      throw new Error(`winget could not install GitHub CLI: ${detail || `exit code ${result.code}`}`);
    }
  } else if (process.platform === 'darwin') {
    const result = await run('brew', ['install', 'gh'], INSTALL_TIMEOUT_MS);
    if (result.code === -1) {
      throw new Error('Homebrew is unavailable. Install GitHub CLI from https://cli.github.com and try again.');
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split('\n').filter(Boolean).pop();
      throw new Error(`brew could not install GitHub CLI: ${detail || `exit code ${result.code}`}`);
    }
  } else {
    throw new Error('Automatic install is not supported on this platform. Install GitHub CLI from https://cli.github.com.');
  }
  const status = await githubCliStatus(true);
  if (!status.installed) {
    throw new Error('GitHub CLI installed, but the executable was not found yet. Restart Mixdog Desktop to pick it up.');
  }
  return status;
}

type PtyModule = typeof import('@homebridge/node-pty-prebuilt-multiarch');
let ptyModule: Promise<PtyModule> | null = null;

interface ActiveLoginFlow {
  flow: DesktopGithubCliLoginFlow;
  pty: import('@homebridge/node-pty-prebuilt-multiarch').IPty | null;
  output: string;
  answeredGitPrompt: boolean;
  pressedEnterToOpen: boolean;
  timer: NodeJS.Timeout | null;
}

const loginFlows = new Map<string, ActiveLoginFlow>();
let flowSequence = 0;

const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const LOGIN_OUTPUT_LIMIT = 20_000;

function stripControl(text: string): string {
  return text.replace(ANSI_PATTERN, '').replace(/\r/g, '');
}

export async function githubCliLoginStart(): Promise<DesktopGithubCliLoginFlow> {
  const gh = await resolveGh();
  if (!gh) throw new Error('GitHub CLI is not installed.');
  // One login at a time: a fresh start supersedes (and kills) earlier flows.
  for (const id of [...loginFlows.keys()]) cancelGithubCliLogin(id);
  const { spawn } = await (ptyModule ??= import('@homebridge/node-pty-prebuilt-multiarch'));
  const flowId = `ghlogin_${process.pid}_${++flowSequence}`;
  const entry: ActiveLoginFlow = {
    flow: { flowId, state: 'pending' },
    pty: null,
    output: '',
    answeredGitPrompt: false,
    pressedEnterToOpen: false,
    timer: null,
  };
  loginFlows.set(flowId, entry);
  const pty = spawn(
    gh.path,
    ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'],
    {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: homedir(),
      env: process.env as Record<string, string>,
    },
  );
  entry.pty = pty;
  entry.timer = setTimeout(() => {
    if (entry.flow.state === 'pending' || entry.flow.state === 'code') {
      entry.flow = { ...entry.flow, state: 'error', message: 'Login timed out after 10 minutes.' };
      try { pty.kill(); } catch { /* already gone */ }
    }
  }, LOGIN_TIMEOUT_MS);
  pty.onData((data) => {
    entry.output = (entry.output + stripControl(data)).slice(-LOGIN_OUTPUT_LIMIT);
    const code = /one-time code:\s*([A-Z0-9-]{6,})/i.exec(entry.output)?.[1];
    const url = /(https:\/\/github\.com\/login\/device\S*)/.exec(entry.output)?.[1];
    if (code && entry.flow.state === 'pending') {
      entry.flow = { ...entry.flow, state: 'code', code, url: url || 'https://github.com/login/device' };
    } else if (url && !entry.flow.url) {
      entry.flow = { ...entry.flow, url };
    }
    // gh's interactive pauses (TTY-only): default-accept the git
    // credential-helper question and the press-Enter-to-open-browser stop —
    // gh itself then opens the device page in the user's browser.
    if (!entry.answeredGitPrompt && /Authenticate Git with your GitHub credentials/.test(entry.output)) {
      entry.answeredGitPrompt = true;
      pty.write('\r');
    }
    if (!entry.pressedEnterToOpen && /Press Enter to open/.test(entry.output)) {
      entry.pressedEnterToOpen = true;
      pty.write('\r');
    }
  });
  pty.onExit(({ exitCode }) => {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.pty = null;
    if (entry.flow.state === 'error') return;
    if (exitCode === 0) {
      void githubCliStatus(true).then((status) => {
        entry.flow = status.authenticated
          ? { ...entry.flow, state: 'success', ...(status.login ? { login: status.login } : {}) }
          : { ...entry.flow, state: 'error', message: 'gh finished, but no account is signed in.' };
      });
      return;
    }
    const tail = entry.output.trim().split('\n').filter(Boolean).slice(-3).join(' ');
    entry.flow = { ...entry.flow, state: 'error', message: tail || `gh exited with code ${exitCode}` };
  });
  return entry.flow;
}

export function githubCliLoginStatus(flowId: string): DesktopGithubCliLoginFlow {
  const entry = loginFlows.get(flowId);
  if (!entry) throw new Error('Unknown GitHub login flow.');
  return entry.flow;
}

export function cancelGithubCliLogin(flowId: string): void {
  const entry = loginFlows.get(flowId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  try { entry.pty?.kill(); } catch { /* already gone */ }
  loginFlows.delete(flowId);
}

export async function githubCliLogout(): Promise<DesktopGithubCliStatus> {
  const gh = await resolveGh();
  if (!gh) throw new Error('GitHub CLI is not installed.');
  const status = await githubCliStatus();
  const base = ['auth', 'logout', '--hostname', 'github.com'];
  let result = await run(gh.path, base, 30_000);
  if (result.code !== 0 && status.login) {
    // Multiple signed-in accounts make gh demand an explicit --user.
    result = await run(gh.path, [...base, '--user', status.login], 30_000);
  }
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || 'gh could not sign out.');
  }
  return githubCliStatus(true);
}

/** The signed-in account, straight from the GitHub API through gh. */
export async function githubCliAccount(): Promise<DesktopGithubCliAccount> {
  const gh = await resolveGh();
  if (!gh) throw new Error('GitHub CLI is not installed.');
  const result = await run(gh.path, ['api', 'user'], 20_000);
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout).trim() || 'gh could not read the signed-in user.');
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error('gh returned an unreadable user payload.');
  }
  const login = typeof data.login === 'string' ? data.login : '';
  if (!login) throw new Error('gh returned no signed-in user.');
  const id = typeof data.id === 'number' ? data.id : 0;
  return {
    login,
    name: typeof data.name === 'string' && data.name ? data.name : login,
    // No public email → the account's noreply address, exactly like GitHub
    // Desktop's suggested commit email.
    email: typeof data.email === 'string' && data.email
      ? data.email
      : `${id ? `${id}+` : ''}${login}@users.noreply.github.com`,
  };
}

const GIT_CONFIG_FIELDS: ReadonlyArray<readonly [keyof DesktopGitGlobalConfig, DesktopGitGlobalConfigKey]> = [
  ['name', 'user.name'],
  ['email', 'user.email'],
  ['defaultBranch', 'init.defaultBranch'],
];

export async function gitGlobalConfig(): Promise<DesktopGitGlobalConfig> {
  const config: DesktopGitGlobalConfig = { name: '', email: '', defaultBranch: '' };
  for (const [field, key] of GIT_CONFIG_FIELDS) {
    const result = await run('git', ['config', '--global', '--get', key]);
    // Exit 1 = unset. Any other failure (git absent) also reads as empty —
    // the save path surfaces the real error when the user acts.
    config[field] = result.code === 0 ? result.stdout.trim() : '';
  }
  return config;
}

export async function setGitGlobalConfig(
  key: DesktopGitGlobalConfigKey,
  value: string,
): Promise<DesktopGitGlobalConfig> {
  const trimmed = value.trim();
  const result = trimmed
    ? await run('git', ['config', '--global', key, trimmed])
    : await run('git', ['config', '--global', '--unset', key]);
  // Unsetting an already-unset key exits 5 — that outcome IS the requested state.
  if (result.code !== 0 && !(trimmed === '' && (result.code === 5 || result.code === 1))) {
    throw new Error((result.stderr || result.stdout).trim() || `git config exited with code ${result.code}`);
  }
  return gitGlobalConfig();
}
