export interface GitBranchEntry {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string;
  lastCommitAt?: string;
  lastCommitRelative?: string;
  ahead?: number;
  behind?: number;
}

interface GitBranchDependencies {
  run(cwd: string, args: string[]): Promise<string>;
  currentGitOperation(cwd: string): Promise<string>;
  gitStatus(cwd: string): Promise<{ files: Array<{ path: string }> }>;
}

const BRANCH_FIELDS =
  '%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)'
  + '%00%(committerdate:iso-strict)%00%(committerdate:relative)';

function parseBranchRows(raw: string): GitBranchEntry[] {
  return raw.split(/\r?\n/).flatMap((line) => {
    const [
      ref = '',
      name = '',
      head = '',
      upstream = '',
      committerDate = '',
      relativeDate = '',
      aheadBehind = '',
    ] = line.split('\0');
    if (!ref || !name || /\/HEAD$/.test(name)) return [];
    const [ahead = '', behind = ''] = aheadBehind.trim().split(/\s+/);
    const counted = /^\d+$/.test(ahead) && /^\d+$/.test(behind);
    return [{
      name,
      current: head.trim() === '*',
      remote: ref.startsWith('refs/remotes/'),
      upstream,
      lastCommitAt: committerDate.trim(),
      lastCommitRelative: relativeDate.trim(),
      ...(counted ? { ahead: Number(ahead), behind: Number(behind) } : {}),
    }];
  }).sort((left, right) =>
    Number(right.current) - Number(left.current)
    || Number(left.remote) - Number(right.remote)
    || left.name.localeCompare(right.name));
}

export function createGitBranchOperations({
  run,
  currentGitOperation,
  gitStatus,
}: GitBranchDependencies) {
  async function checkedBranchName(cwd: string, value: string): Promise<string> {
    const branch = String(value || '').trim();
    if (!branch) throw new TypeError('A Git branch name is required.');
    await run(cwd, ['check-ref-format', '--branch', branch]);
    return branch;
  }

  async function gitBranches(cwd: string): Promise<GitBranchEntry[]> {
    const refs = ['refs/heads', 'refs/remotes'];
    try {
      return parseBranchRows(await run(cwd, [
        'for-each-ref',
        `--format=${BRANCH_FIELDS}%00%(ahead-behind:HEAD)`,
        ...refs,
      ]));
    } catch {
      return parseBranchRows(await run(cwd, ['for-each-ref', `--format=${BRANCH_FIELDS}`, ...refs]));
    }
  }

  async function gitCheckoutBranch(
    cwd: string,
    value: string,
    remote = false,
  ): Promise<string> {
    const branch = await checkedBranchName(cwd, value);
    if (!remote) return run(cwd, ['switch', branch]);
    const localBranch = branch.replace(/^[^/]+\//, '');
    const localExists = await run(cwd, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${localBranch}`,
    ]).then(() => true).catch(() => false);
    return run(cwd, localExists
      ? ['switch', localBranch]
      : ['switch', '--track', branch]);
  }

  async function gitCreateBranch(cwd: string, value: string): Promise<string> {
    return run(cwd, ['switch', '-c', await checkedBranchName(cwd, value)]);
  }

  async function gitRenameBranch(
    cwd: string,
    value: string,
    nextValue: string,
  ): Promise<string> {
    const branch = await checkedBranchName(cwd, value);
    const nextBranch = await checkedBranchName(cwd, nextValue);
    return run(cwd, ['branch', '-m', branch, nextBranch]);
  }

  async function gitDeleteBranch(cwd: string, value: string): Promise<string> {
    return run(cwd, ['branch', '-d', await checkedBranchName(cwd, value)]);
  }

  async function gitMergeBranch(cwd: string, value: string): Promise<string> {
    const branch = await checkedBranchName(cwd, value);
    const inFlight = await currentGitOperation(cwd);
    if (inFlight) {
      throw new Error(
        `A ${inFlight} is already in progress. Continue or abort it before merging ${branch}.`,
      );
    }
    const dirty = (await gitStatus(cwd)).files.map((file) => file.path);
    if (dirty.length) {
      throw new Error([
        `Uncommitted changes would be overwritten by merging ${branch}`,
        `: ${dirty.slice(0, 10).join(', ')}`,
        '. Commit or stash them first.',
      ].join(''));
    }
    try {
      return await run(cwd, ['merge', '--no-edit', branch]);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      const conflicted = /conflict/i.test(message)
        || await currentGitOperation(cwd).then((operation) => operation === 'merge').catch(() => false);
      if (!conflicted) throw reason instanceof Error ? reason : new Error(message);
      const names = await run(cwd, ['diff', '--name-only', '--diff-filter=U'])
        .catch(() => '');
      const files = names.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const current = await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
        .then((name) => name.trim()).catch(() => 'HEAD');
      throw new Error([
        `Merging ${branch} into ${current} hit conflicts`,
        files.length ? ` in ${files.length} file(s): ${files.slice(0, 10).join(', ')}` : '',
        '. Resolve them, then continue or abort the merge.',
      ].join(''));
    }
  }

  return {
    checkedBranchName,
    gitBranches,
    gitCheckoutBranch,
    gitCreateBranch,
    gitRenameBranch,
    gitDeleteBranch,
    gitMergeBranch,
  };
}
