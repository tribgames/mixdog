import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { primeEditorFileLoad } from '../editor-file-loader';
import { getEditorCommandCapabilities, subscribeEditorLanguageStore } from '../editor-language-store';
import { paneActiveSelection } from '../pane-layout';
import type { usePaneWorkspace } from '../pane-workspace-state';
import type { EditorSaveHandle } from '../use-pane-tab-close';
import type { useAppShellPanels } from '../use-app-shell-panels';

export interface UseAppEditorStateOptions {
  paneWorkspace: ReturnType<typeof usePaneWorkspace>;
  startupFocusedPaneSelection: ReturnType<typeof paneActiveSelection>;
  bottomPanel: ReturnType<typeof useAppShellPanels>['bottomPanel'];
}

export function useAppEditorState({
  paneWorkspace,
  startupFocusedPaneSelection,
  bottomPanel,
}: UseAppEditorStateOptions) {
  const startupFilePrimed = useRef(false);
  useLayoutEffect(() => {
    if (startupFilePrimed.current) return;
    startupFilePrimed.current = true;
    // Prime EVERY restored file tab, focused pane first: only the focused
    // file primed before, so background editors started their engine-gated
    // reads seconds later at boot and sat visibly empty (user report).
    const primed = new Set<string>();
    const prime = (selection: ReturnType<typeof paneActiveSelection>) => {
      if (selection?.kind !== 'file') return;
      const key = `${selection.project}\u0000${selection.rel}\u0000${selection.accessToken || ''}`;
      if (primed.has(key)) return;
      primed.add(key);
      void primeEditorFileLoad(window.mixdogDesktop, selection.project, selection.rel, selection.accessToken)?.catch(
        () => {}
      );
    };
    prime(startupFocusedPaneSelection);
    for (const leaf of paneWorkspace.leaves) prime(paneActiveSelection(leaf));
  }, [paneWorkspace.leaves, startupFocusedPaneSelection]);

  useEffect(() => {
    const showProblems = () => {
      if (bottomPanel.open) bottomPanel.setOpen(false);
      else bottomPanel.setTab('problems');
    };
    window.addEventListener('mixdog:show-problems', showProblems);
    return () => window.removeEventListener('mixdog:show-problems', showProblems);
  }, [bottomPanel.open, bottomPanel.setOpen, bottomPanel.setTab]);

  const editorCommandCapabilities = useSyncExternalStore(
    subscribeEditorLanguageStore,
    getEditorCommandCapabilities,
    getEditorCommandCapabilities
  );

  const [dirtyFileKeys, setDirtyFileKeys] = useState<ReadonlySet<string>>(() => new Set());
  const editorSaveHandles = useRef(new Map<string, EditorSaveHandle>());

  const { pinTabByKey: pinPaneTabByKey } = paneWorkspace;
  const handleFileDirty = useCallback(
    (key: string, dirty: boolean) => {
      if (dirty) pinPaneTabByKey(key);
      setDirtyFileKeys((current) => {
        if (current.has(key) === dirty) return current;
        const next = new Set(current);
        if (dirty) next.add(key);
        else next.delete(key);
        return next;
      });
    },
    [pinPaneTabByKey]
  );

  const registerEditorSaveHandle = useCallback((key: string, save: EditorSaveHandle | null) => {
    if (save) editorSaveHandles.current.set(key, save);
    else editorSaveHandles.current.delete(key);
  }, []);

  return {
    editorCommandCapabilities,
    dirtyFileKeys,
    editorSaveHandles,
    handleFileDirty,
    registerEditorSaveHandle,
  };
}
