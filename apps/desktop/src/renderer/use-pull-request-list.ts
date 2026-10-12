// Pull request list loading for the dock surface. A retained (inactive) surface
// issues no reads; every load carries an epoch so deactivation, project change
// or a newer load orphans older in-flight answers.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopPullRequestCategory } from '../shared/contract';
import { preferredBaseBranch } from './pull-requests-model';

export function usePullRequestList(
  api: Window['mixdogDesktop'],
  projectPath: string,
  currentBranch: string,
  surfaceActive: boolean,
  /** Pane-owned state to clear when the loaded project changes. */
  onProjectReset: () => void
) {
  const [categories, setCategories] = useState<DesktopPullRequestCategory[] | null>(null);
  const [readError, setReadError] = useState('');
  const [loading, setLoading] = useState(false);
  const [localBranchNames, setLocalBranchNames] = useState<Set<string>>(new Set());
  const [baseBranchNames, setBaseBranchNames] = useState<string[]>(['main']);
  const [defaultBranchName, setDefaultBranchName] = useState('');
  const listEpoch = useRef(0);
  const loadedProject = useRef<string | null>(null);
  const latestReset = useRef(onProjectReset);
  latestReset.current = onProjectReset;

  // biome-ignore lint/correctness/useExhaustiveDependencies: api and currentBranch are deliberate triggers; a new api or branch change must produce a fresh loadList so dependent effects reload.
  const loadList = useCallback(async () => {
    if (!projectPath || !surfaceActive) return;
    const epoch = ++listEpoch.current;
    setLoading(true);
    try {
      const [rows, branches, remoteDefaultBranch] = await Promise.all([
        api?.ghPrList?.(projectPath),
        api?.gitBranches?.(projectPath).catch(() => []),
        api?.ghPrDefaultBranch?.(projectPath).catch(() => '') ?? Promise.resolve(''),
      ]);
      if (epoch !== listEpoch.current) return;
      setCategories(rows ?? []);
      setLocalBranchNames(new Set((branches ?? []).filter((branch) => !branch.remote).map((branch) => branch.name)));
      const baseNames = [
        ...new Set(
          (branches ?? []).flatMap((branch) => {
            const name = branch.remote ? branch.name.replace(/^[^/]+\//, '') : branch.name;
            return !name || name === 'HEAD' ? [] : [name];
          })
        ),
      ];
      setBaseBranchNames(baseNames.length ? baseNames : ['main']);
      setDefaultBranchName(remoteDefaultBranch || preferredBaseBranch(baseNames));
      setReadError('');
    } catch (cause) {
      if (epoch !== listEpoch.current) return;
      setReadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (epoch === listEpoch.current) setLoading(false);
    }
  }, [api, currentBranch, projectPath, surfaceActive]);

  useEffect(() => {
    if (!surfaceActive) {
      // Deactivation cancels: the epoch bump orphans every in-flight answer.
      listEpoch.current += 1;
      setLoading(false);
      return;
    }
    if (loadedProject.current !== projectPath) {
      loadedProject.current = projectPath;
      setCategories(null);
      setReadError('');
      latestReset.current();
      setDefaultBranchName('');
    }
    void loadList();
  }, [loadList, projectPath, surfaceActive]);

  return { categories, readError, loading, localBranchNames, baseBranchNames, defaultBranchName, loadList };
}
