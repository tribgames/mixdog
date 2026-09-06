import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { buildGithubCommand } from './commands.mjs';
import { githubRepository, githubRequestMutates, validateGithubRequest } from './contract.mjs';
import { withGitRepoWriteLock } from '../agent/orchestrator/tools/builtin/git-repo-rw-lock.mjs';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const mutationTails = new Map();

function executable(env) {
  const candidates = process.platform === 'win32'
    ? [join(env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
      ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'gh.exe')] : [])]
    : ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];
  return candidates.find((path) => existsSync(path)) || 'gh';
}

export function runGithubProcess(command, { cwd, signal, env = process.env } = {}) {
  return new Promise((done, reject) => {
    const child = execFile(executable(env), command.args, {
      cwd, signal, windowsHide: true, timeout: 120000, maxBuffer: MAX_OUTPUT_BYTES,
      env: {
        ...env, GH_HOST: command.hostname || env.GH_HOST || '', GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: '', PAGER: '', CLICOLOR: '0', NO_COLOR: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    }, (error, stdout, stderr) => {
      if (!error) return done(String(stdout));
      const missing = error.code === 'ENOENT';
      const bounded = String(stderr || error.message).slice(0, 12000);
      const uncertain = command.mutation && !missing
        ? ' The write was not retried. Check the remote state before trying again.' : '';
      const message = missing
        ? 'GitHub CLI is not installed. Open Extensions → Plugin → Git & GitHub to install and connect it.'
        : `${bounded}${uncertain}`;
      reject(new Error(message));
    });
    // Input JSON is data, never a command/flag or local filename.
    child.stdin?.on('error', () => {});
    child.stdin?.end(command.input ?? '');
  });
}

async function cloneDestination(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[~$*?\0\r\n]/.test(value)
    || /^\\\\[?.]/.test(value)) throw new TypeError('Clone destination must be an explicit absolute new directory.');
  const destination = resolve(value);
  if (destination === parse(destination).root || destination.toLowerCase() === resolve(homedir()).toLowerCase()) {
    throw new TypeError('Cannot clone into a filesystem root or home directory.');
  }
  try {
    await lstat(destination);
    throw new TypeError('Clone destination already exists. Choose a new directory; existing files are never removed.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await realpath(dirname(destination));
  return destination;
}

async function serial(key, work) {
  const prior = mutationTails.get(key) || Promise.resolve();
  const result = prior.catch(() => {}).then(work);
  mutationTails.set(key, result);
  try { return await result; }
  finally { if (mutationTails.get(key) === result) mutationTails.delete(key); }
}

export async function executeGithubRequest(value, cwd, options = {}) {
  const input = validateGithubRequest(value);
  options = { ...options, signal: options.signal || options.abortSignal };
  if (options.signal?.aborted) throw new Error('GitHub request cancelled before dispatch.');
  const run = options.run || runGithubProcess;
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) {
    throw new TypeError('An absolute Project directory is required.');
  }
  const repoFree = input.action === 'repo.list' || input.action.startsWith('notification.');
  if (['repo.create', 'repo.clone', 'repo.fork'].includes(input.action) && !input.repo) {
    throw new TypeError('This action requires an explicit owner/name in repo.');
  }
  if (!repoFree && !input.repo) {
    // Bind every request to a concrete repository before any write is sent.
    const raw = await run({
      args: ['repo', 'view', '--json', 'nameWithOwner'], hostname: input.hostname || 'github.com',
      json: true, mutation: false,
    }, { ...options, cwd });
    input.repo = githubRepository(JSON.parse(raw).nameWithOwner);
  }
  if (input.action === 'repo.clone') input.destination = await cloneDestination(input.destination);
  const command = buildGithubCommand(input);
  const invoke = async () => {
    if (options.signal?.aborted) throw new Error('GitHub request cancelled before dispatch.');
    const raw = await run(command, { ...options, cwd });
    let data;
    try { data = command.json && raw.trim() ? JSON.parse(raw) : raw.trim(); }
    catch {
      throw new Error(command.mutation
        ? 'The write completed, but its response was unreadable. Inspect remote state; do not replay the write.'
        : 'GitHub returned an unreadable response.');
    }
    if (input.action === 'pr.merge' && data?.merged === false) {
      throw new Error(data.message || 'GitHub refused to merge this pull request.');
    }
    const result = { action: input.action, repo: input.repo || '', hostname: input.hostname || 'github.com', data };
    if (command.list) {
      const items = command.collection ? data?.[command.collection] : data;
      if (!Array.isArray(items)) throw new Error('GitHub returned an invalid list.');
      result.data = input.action === 'issue.list' ? items.filter((item) => !item.pull_request) : items;
      // The REST issues list also contains PRs; paginate on the unfiltered page.
      result.page = command.page;
      result.hasMore = items.length === command.limit;
    }
    return result;
  };
  const work = input.action === 'pr.checkout' || input.action === 'repo.clone'
    ? () => withGitRepoWriteLock(input.destination || cwd, async () => {
      // Reserve the new directory atomically; an intervening creator wins.
      // A failed clone is left in place for recovery, never recursively removed.
      if (input.action === 'repo.clone') await mkdir(input.destination);
      return invoke();
    }, { signal: options.signal })
    : invoke;
  return githubRequestMutates(input)
    ? serial(`${input.hostname || 'github.com'}/${input.repo || '@account'}`.toLowerCase(), work)
    : invoke();
}
