// Branch state for the dock: the branch list and resolved default branch,
// and the portaled picker's open/query/merge-mode state.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopGitBranch, DesktopGitStatus } from '../shared/contract';
import { useImmediateOverlayClickGuard } from './immediate-overlay';
import type { ScmContextMenuState } from './ScmContextMenu';
import { DEFAULT_BRANCH_NAMES, useAnchoredPanel } from './source-control-support';

export function useSourceControlBranches({
  api,
  projectPath,
  status,
  surfaceActive,
  contextMenu,
  setError,
}: {
  api: Window['mixdogDesktop'];
  projectPath: string;
  status: DesktopGitStatus | null;
  surfaceActive: boolean;
  contextMenu: ScmContextMenuState | null;
  setError: (message: string) => void;
}) {
  const [branches, setBranches] = useState<DesktopGitBranch[]>([]);
  /** Real default branch, resolved from the remote HEAD (see loadBranches). */
  const [defaultBranchName, setDefaultBranchName] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const clickGuard = useImmediateOverlayClickGuard();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [mergeMode, setMergeMode] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The picker is a document.body PORTAL and the Dock keeps this pane
  // MOUNTED (inert + aria-hidden) while another tab is presented — inert
  // cannot reach a portal that left the pane, so the owning surface's active
  // signal drives the VISIBLE open state.
  const pickerVisible = pickerOpen && surfaceActive;
  // Branch panel: reference width 365px (app/styles/ui/_branches.scss:3-16),
  // capped to the room the window actually has.
  const panelStyle = useAnchoredPanel(pickerVisible, triggerRef, panelRef, {
    preferredWidth: 300,
    minWidth: 220,
    align: 'start',
    placement: 'below',
  });

  const loadBranches = useCallback(async () => {
    if (!projectPath) return;
    if (!api?.gitBranches) {
      setBranches(
        status?.branch
          ? [
              {
                name: status.branch,
                current: true,
                remote: false,
                upstream: status.upstreamName,
              },
            ]
          : []
      );
      return;
    }
    setLoading(true);
    try {
      setBranches(await api.gitBranches(projectPath));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [api, projectPath, status?.branch, status?.upstreamName, setError]);

  /** Branches are grouped under the repository's default branch.
   *  `gitBranches` drops symbolic refs, so the only contract member that
   *  still carries the remote HEAD is the review base
   *  (main/git-cli.ts:806-819 resolves `refs/remotes/<remote>/HEAD`). Resolved
   *  once per project and cached; the conventional names stay as a fallback. */
  const loadDefaultBranch = useCallback(async () => {
    if (!projectPath || !api?.gitReview) return;
    try {
      const review = await api.gitReview(projectPath);
      const base = review?.base || '';
      if (!base || base === 'HEAD') return;
      setDefaultBranchName(base.includes('/') ? base.slice(base.indexOf('/') + 1) : base);
    } catch {
      /* no remote HEAD — the conventional guess stands in */
    }
  }, [api, projectPath]);

  useEffect(() => {
    if (!pickerVisible) return undefined;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      // The right button OPENS a row context menu; it never dismisses the
      // panel that row lives in.
      if (event.button === 2) return;
      // The panel is portaled out of the dock, so both boxes count as "inside".
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target) || contextMenu) return;
      setPickerOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      // An open context menu owns Escape until it closes.
      if (contextMenu) return;
      if (event.key === 'Escape') setPickerOpen(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keydown, true);
    };
  }, [pickerVisible, contextMenu]);
  useEffect(() => {
    setBranches([]);
    setDefaultBranchName('');
    setPickerOpen(false);
    setQuery('');
    setMergeMode(false);
  }, [projectPath]);

  const needle = query.trim().toLocaleLowerCase();
  const visibleBranches = branches.filter((branch) => !needle || branch.name.toLocaleLowerCase().includes(needle));
  // Put the resolved default branch first; only guess from conventional names
  // when the repository exposes no remote HEAD.
  const defaultBranch = defaultBranchName
    ? (visibleBranches.find((branch) => !branch.remote && branch.name === defaultBranchName) ??
      visibleBranches.find((branch) => branch.name.endsWith(`/${defaultBranchName}`)))
    : visibleBranches.find((branch) => !branch.remote && DEFAULT_BRANCH_NAMES.includes(branch.name));
  const otherBranches = visibleBranches.filter((branch) => branch !== defaultBranch);
  const openPicker = () => {
    setPickerOpen(true);
    setQuery('');
    setMergeMode(false);
    void loadBranches();
    if (!defaultBranchName) void loadDefaultBranch();
  };
  const closePicker = useCallback(() => setPickerOpen(false), []);

  return {
    pickerVisible,
    closePicker,
    openPicker,
    clickGuard,
    query,
    setQuery,
    loading,
    mergeMode,
    setMergeMode,
    rootRef,
    triggerRef,
    panelRef,
    panelStyle,
    loadBranches,
    visibleBranches,
    defaultBranch,
    otherBranches,
  };
}
