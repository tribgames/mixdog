// Read-only snapshot the island "PR / commit" request sends to the model, so
// the agent does not have to investigate before acting. Raw reads only; the
// renderer decides what fits the message.
import { childEnvironment } from './child-environment';
import { run, runWithStatus } from './git-runner';
import { runGithubProcess } from '../../../../src/runtime/github/client.mjs';

const FILE_PATCH_LIMIT = 40_000;
const TEXT_LIMIT = 20_000;
const RECENT_SUBJECTS = 12;

export interface GitRequestContextInput {
  /** Files of the shown Changes source. */
  paths: string[];
  /** Base branch for the branch-vs-base reads; '' skips them. */
  base: string;
}

export interface GitRequestContext {
  statusShort: string;
  diffStat: string;
  files: { path: string; patch: string; truncated: boolean }[];
  recentSubjects: string[];
  branchCommits: string;
  branchDiffStat: string;
  pr: { number: number; title: string; url: string; state: string; baseRefName: string } | null;
}

const clip = (text: string): string => (text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text);

const attempt = async (read: () => Promise<string>): Promise<string> => {
  try {
    return await read();
  } catch {
    return '';
  }
};

async function filePatch(cwd: string, path: string, untracked: boolean) {
  // `diff --no-index` exits 1 when the files differ.
  const patch = untracked
    ? (await runWithStatus(cwd, ['diff', '--no-index', '--', '/dev/null', path])).stdout
    : await attempt(() => run(cwd, ['diff', 'HEAD', '--', path]));
  const truncated = patch.length > FILE_PATCH_LIMIT;
  return { path, patch: truncated ? patch.slice(0, FILE_PATCH_LIMIT) : patch, truncated };
}

async function currentPullRequest(cwd: string): Promise<GitRequestContext['pr']> {
  try {
    const raw = await runGithubProcess(
      { args: ['pr', 'view', '--json', 'number,title,url,state,baseRefName'], mutation: false },
      { cwd, env: childEnvironment() }
    );
    const record = JSON.parse(raw) as Record<string, unknown>;
    return {
      number: Number(record.number) || 0,
      title: String(record.title ?? ''),
      url: String(record.url ?? ''),
      state: String(record.state ?? ''),
      baseRefName: String(record.baseRefName ?? ''),
    };
  } catch {
    return null;
  }
}

export async function gitRequestContext(cwd: string, input: GitRequestContextInput): Promise<GitRequestContext> {
  const untracked = new Set(
    input.paths.length
      ? (await attempt(() => run(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...input.paths])))
          .split('\0')
          .filter(Boolean)
      : []
  );
  const base = input.base;
  const [statusShort, diffStat, files, subjects, branchCommits, branchDiffStat, pr] = await Promise.all([
    attempt(() => run(cwd, ['status', '--short', '--branch'])),
    attempt(() => run(cwd, ['diff', 'HEAD', '--stat'])),
    Promise.all(input.paths.map((path) => filePatch(cwd, path, untracked.has(path.replace(/\\/g, '/'))))),
    attempt(() => run(cwd, ['log', `-${RECENT_SUBJECTS}`, '--format=%s'])),
    base ? attempt(() => run(cwd, ['log', '--oneline', `${base}..HEAD`])) : Promise.resolve(''),
    base ? attempt(() => run(cwd, ['diff', `${base}...HEAD`, '--stat'])) : Promise.resolve(''),
    currentPullRequest(cwd),
  ]);
  return {
    statusShort: clip(statusShort),
    diffStat: clip(diffStat),
    files,
    recentSubjects: subjects.split(/\r?\n/).filter(Boolean),
    branchCommits: clip(branchCommits),
    branchDiffStat: clip(branchDiffStat),
    pr,
  };
}
