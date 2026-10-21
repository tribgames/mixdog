// Settings → Git: GitHub CLI (gh) integration — presence probe, guided
// install (winget/brew), device-flow login through a PTY (gh insists on a
// TTY for `auth login`), logout, and the global git identity. Everything in
// this module is a desktop-only surface executed by the singleton daemon.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { childEnvironment } from './child-environment';
import { installWithPackageManager, run } from './cli-run';

import type {
  DesktopGithubCliAccount,
  DesktopGithubCliLoginFlow,
  DesktopGithubCliStatus,
  DesktopGitCliStatus,
  DesktopGitGlobalConfig,
  DesktopGitGlobalConfigKey,
} from '../shared/contract';

function ghPathCandidates(): string[] {
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const localAppData = process.env.LOCALAPPDATA || '';
    // Absolute paths only: the login PTY's own Path search skips the last
    // entry (and quoted ones), failing with an empty "File not found: ".
    const pathDirs = (process.env.PATH || '')
      .split(delimiter)
      .map((dir) => dir.replace(/"/g, '').trim())
      .filter(Boolean);
    return [
      ...pathDirs.map((dir) => join(dir, 'gh.exe')),
      join(programFiles, 'GitHub CLI', 'gh.exe'),
      ...(localAppData ? [join(localAppData, 'Microsoft', 'WinGet', 'Links', 'gh.exe')] : []),
    ];
  }
  if (process.platform === 'darwin') return ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'];
  return ['gh', '/usr/bin/gh', '/usr/local/bin/gh'];
}

/** Command runner; swappable by tests through githubCliLoginTestHooks.run. */
const exec = (): typeof run => githubCliLoginTestHooks.run ?? run;

const INSTALL_TIMEOUT_MS = 10 * 60_000;
let cachedGh: { path: string; version: string } | null | undefined;
let cachedGit: { path: string; version: string } | null | undefined;

/** Resolve a working gh executable. Known install locations are probed too,
 *  so a just-installed gh is found before a fresh PATH ever reaches this
 *  (already-running) process. */
async function resolveGh(refresh = false): Promise<{ path: string; version: string } | null> {
  if (!refresh && cachedGh !== undefined) return cachedGh;
  for (const candidate of ghPathCandidates()) {
    if (candidate !== 'gh' && !existsSync(candidate)) continue;
    const probe = await exec()(candidate, ['--version']);
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
  return /account\s+(\S+)/.exec(output)?.[1] || /Logged in to \S+ as (\S+)/.exec(output)?.[1] || '';
}

export async function githubCliStatus(refresh = false): Promise<DesktopGithubCliStatus> {
  const gh = await resolveGh(refresh);
  if (!gh) return { installed: false, authenticated: false };
  // Without --active, `gh auth status` exits 1 when ANY stored github.com
  // account has a stale token, even though the active one is signed in, so a
  // successful login was reported as "no account is signed in". gh < 2.40 has
  // no --active flag; fall back to the plain check there.
  let auth = await exec()(gh.path, ['auth', 'status', '--hostname', 'github.com', '--active']);
  if (auth.code !== 0 && /unknown flag:? --active/i.test(`${auth.stdout}\n${auth.stderr}`)) {
    auth = await exec()(gh.path, ['auth', 'status', '--hostname', 'github.com']);
  }
  const authenticated = auth.code === 0;
  const login = authenticated ? loginFromAuthOutput(`${auth.stdout}\n${auth.stderr}`) : '';
  return {
    installed: true,
    ...(gh.version ? { version: gh.version } : {}),
    authenticated,
    ...(login ? { login } : {}),
  };
}

function gitPathCandidates(): string[] {
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const localAppData = process.env.LOCALAPPDATA || '';
    return [
      'git',
      join(programFiles, 'Git', 'cmd', 'git.exe'),
      ...(localAppData ? [join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe')] : []),
    ];
  }
  if (process.platform === 'darwin') return ['git', '/opt/homebrew/bin/git', '/usr/local/bin/git'];
  return ['git', '/usr/bin/git', '/usr/local/bin/git'];
}

async function resolveGit(refresh = false): Promise<{ path: string; version: string } | null> {
  if (!refresh && cachedGit !== undefined) return cachedGit;
  for (const candidate of gitPathCandidates()) {
    if (candidate !== 'git' && !existsSync(candidate)) continue;
    const probe = await run(candidate, ['--version']);
    if (probe.code === 0) {
      cachedGit = {
        path: candidate,
        version: /git version (\S+)/i.exec(probe.stdout)?.[1] || '',
      };
      return cachedGit;
    }
  }
  cachedGit = null;
  return null;
}

export async function gitCliStatus(refresh = false): Promise<DesktopGitCliStatus> {
  const git = await resolveGit(refresh);
  if (!git) return { installed: false };
  return { installed: true, ...(git.version ? { version: git.version } : {}) };
}

export async function installGitCli(): Promise<DesktopGitCliStatus> {
  // A system Git that is already present answers first: the Install click
  // follows the Mixdog marker, not Git presence, and winget treats an installed
  // package as an upgrade request (0x8A15002B when none applies).
  const existing = await gitCliStatus(true);
  if (existing.installed) return existing;
  await installWithPackageManager({
    label: 'Git',
    homepage: 'https://git-scm.com',
    wingetId: 'Git.Git',
    brewArgs: ['install', 'git'],
    timeoutMs: INSTALL_TIMEOUT_MS,
    unsupported: 'Automatic Git installation is not supported on this platform. Install Git from https://git-scm.com.',
  });
  const status = await gitCliStatus(true);
  if (!status.installed) {
    throw new Error('Git installed, but the executable was not found yet. Restart Mixdog Desktop to pick it up.');
  }
  return status;
}

export async function installGithubCli(): Promise<DesktopGithubCliStatus> {
  await installWithPackageManager({
    label: 'GitHub CLI',
    homepage: 'https://cli.github.com',
    wingetId: 'GitHub.cli',
    brewArgs: ['install', 'gh'],
    timeoutMs: INSTALL_TIMEOUT_MS,
    unsupported: 'Automatic install is not supported on this platform. Install GitHub CLI from https://cli.github.com.',
  });
  const status = await githubCliStatus(true);
  if (!status.installed) {
    throw new Error(
      'GitHub CLI installed, but the executable was not found yet. Restart Mixdog Desktop to pick it up.'
    );
  }
  return status;
}

type PtyModule = typeof import('@homebridge/node-pty-prebuilt-multiarch');
let ptyModule: Promise<PtyModule> | null = null;

interface ActiveLoginFlow {
  flow: DesktopGithubCliLoginFlow;
  pty: import('@homebridge/node-pty-prebuilt-multiarch').IPty | null;
  output: string;
  timer: NodeJS.Timeout | null;
  stallTimer: NodeJS.Timeout | null;
}

const loginFlows = new Map<string, ActiveLoginFlow>();
let flowSequence = 0;

const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const LOGIN_OUTPUT_LIMIT = 20_000;
/** gh prints the one-time code within seconds; silence past this is a stall. */
const LOGIN_CODE_STALL_MS = 45_000;

function stripControl(text: string): string {
  return text.replace(ANSI_PATTERN, '').replace(/\r/g, '');
}

/** A command that exits 0 and ignores the URL argument, per platform. */
const NO_OP_BROWSER = process.platform === 'win32' ? 'cmd /c exit 0' : 'true';

/** Environment for `gh auth login`. Prompts are disabled so gh never asks the
 *  git-protocol / git-credentials questions (and skips its press-Enter stop),
 *  and its browser launcher is a no-op: the renderer opens the device page
 *  itself, on the browser the user actually sits at. */
export function githubLoginEnvironment(): Record<string, string> {
  return {
    ...(childEnvironment() as Record<string, string>),
    GH_PROMPT_DISABLED: '1',
    BROWSER: NO_OP_BROWSER,
    GH_BROWSER: NO_OP_BROWSER,
  };
}

/** Test seam: substitute the PTY module, the resolved gh and the command runner. */
export const githubCliLoginTestHooks: {
  pty?: PtyModule;
  gh?: { path: string; version: string };
  run?: typeof run;
} = {};

export async function githubCliLoginStart(): Promise<DesktopGithubCliLoginFlow> {
  const gh = githubCliLoginTestHooks.gh ?? (await resolveGh());
  if (!gh) throw new Error('GitHub CLI is not installed.');
  // One login at a time: a fresh start supersedes (and kills) earlier flows.
  for (const id of [...loginFlows.keys()]) cancelGithubCliLogin(id);
  ptyModule ??= import('@homebridge/node-pty-prebuilt-multiarch');
  const { spawn } = githubCliLoginTestHooks.pty ?? (await ptyModule);
  const flowId = `ghlogin_${process.pid}_${++flowSequence}`;
  const entry: ActiveLoginFlow = {
    flow: { flowId, state: 'pending' },
    pty: null,
    output: '',
    timer: null,
    stallTimer: null,
  };
  loginFlows.set(flowId, entry);
  const pty = spawn(gh.path, ['auth', 'login', '--hostname', 'github.com', '--web'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: homedir(),
    env: githubLoginEnvironment(),
  });
  entry.pty = pty;
  entry.stallTimer = setTimeout(() => {
    if (entry.flow.state !== 'pending') return;
    entry.flow = {
      ...entry.flow,
      state: 'error',
      message: 'GitHub sign-in did not start. Run `gh auth login` in a terminal instead.',
    };
    try {
      pty.kill();
    } catch {
      /* already gone */
    }
  }, LOGIN_CODE_STALL_MS);
  entry.timer = setTimeout(() => {
    if (entry.flow.state === 'pending' || entry.flow.state === 'code') {
      entry.flow = { ...entry.flow, state: 'error', message: 'Login timed out after 10 minutes.' };
      try {
        pty.kill();
      } catch {
        /* already gone */
      }
    }
  }, LOGIN_TIMEOUT_MS);
  pty.onData((data) => {
    entry.output = (entry.output + stripControl(data)).slice(-LOGIN_OUTPUT_LIMIT);
    // "First copy your one-time code: XXXX-XXXX", or — when gh's own
    // clipboard option is on — "One-time code (XXXX-XXXX) copied to clipboard".
    const code = /one-time code(?::\s*|\s*\()([A-Z0-9-]{6,})/i.exec(entry.output)?.[1];
    const url = /(https:\/\/github\.com\/login\/device\S*)/.exec(entry.output)?.[1];
    if (code && entry.flow.state === 'pending') {
      if (entry.stallTimer) clearTimeout(entry.stallTimer);
      entry.stallTimer = null;
      entry.flow = { ...entry.flow, state: 'code', code, url: url || 'https://github.com/login/device' };
    } else if (url && !entry.flow.url) {
      entry.flow = { ...entry.flow, url };
    }
  });
  pty.onExit(({ exitCode }) => {
    for (const key of ['timer', 'stallTimer'] as const) {
      if (entry[key]) clearTimeout(entry[key]);
      entry[key] = null;
    }
    entry.pty = null;
    if (entry.flow.state === 'error') return;
    if (exitCode === 0) {
      void githubCliStatus(true).then(async (status) => {
        if (status.authenticated) {
          // Non-interactive login skips gh's git-credentials step; wire it up here.
          const setup = await exec()(gh.path, ['auth', 'setup-git', '--hostname', 'github.com'], 30_000);
          entry.flow =
            setup.code === 0
              ? { ...entry.flow, state: 'success', ...(status.login ? { login: status.login } : {}) }
              : {
                  ...entry.flow,
                  state: 'error',
                  message: `Signed in to GitHub, but Git could not be set up to use it: ${setup.stderr.trim() || `gh auth setup-git exited with code ${setup.code}`}`,
                };
        } else {
          entry.flow = { ...entry.flow, state: 'error', message: 'gh finished, but no account is signed in.' };
        }
      });
      return;
    }
    const tail = entry.output.trim().split('\n').filter(Boolean).slice(-3).join(' ');
    entry.flow = { ...entry.flow, state: 'error', message: tail || `gh exited with code ${exitCode}` };
  });
  return entry.flow;
}

/** The code card's "Copy & open GitHub". gh itself never opens a browser
 *  (no-op launcher, prompts disabled), so this always returns false and the
 *  renderer opens the device page. */
export function githubCliLoginOpenBrowser(flowId: string): boolean {
  if (!loginFlows.has(flowId)) throw new Error('Unknown GitHub login flow.');
  return false;
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
  if (entry.stallTimer) clearTimeout(entry.stallTimer);
  try {
    entry.pty?.kill();
  } catch {
    /* already gone */
  }
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
  // No public email → the account's noreply address, exactly like GitHub
  // Desktop's suggested commit email.
  const noreplyEmail = `${id ? `${id}+` : ''}${login}@users.noreply.github.com`;
  return {
    login,
    name: typeof data.name === 'string' && data.name ? data.name : login,
    email: typeof data.email === 'string' && data.email ? data.email : noreplyEmail,
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
  value: string
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
