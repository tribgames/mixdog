import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import type { DesktopModelSelection, DesktopWorkflowState } from '../shared/contract';
import type { ResolvedDraftPrefs } from './draft-pane-prefs-store';

/** State whose latest value is also readable synchronously (outside render)
 *  through a ref; the setter updates both at once. */
function useMirroredState<T>(initial: T): [T, MutableRefObject<T>, (next: T) => void] {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((next: T) => {
    ref.current = next;
    setValue(next);
  }, []);
  return [value, ref, set];
}

/** The working singletons that always mirror the FOCUSED draft (the submit
 *  path reads them). Every draft pane keeps its own staged entry elsewhere;
 *  these are only what the focused pane currently paints. */
export type FocusedDraftRoute = {
  projectPath: string;
  projectPathRef: MutableRefObject<string>;
  setProjectPath(next: string): void;
  modelSelection: DesktopModelSelection | null;
  modelSelectionRef: MutableRefObject<DesktopModelSelection | null>;
  setModelSelection(next: DesktopModelSelection | null): void;
  workflow: DesktopWorkflowState | null;
  workflowRef: MutableRefObject<DesktopWorkflowState | null>;
  setWorkflow(next: DesktopWorkflowState | null): void;
  /** Paints a resolved draft into the singletons; the project only unless opted out. */
  paint(resolved: ResolvedDraftPrefs, options?: { projectPath?: boolean }): void;
};

export function useFocusedDraftRoute(): FocusedDraftRoute {
  const [projectPath, projectPathRef, setProjectPath] = useMirroredState('');
  const [modelSelection, modelSelectionRef, setModelSelection] = useMirroredState<DesktopModelSelection | null>(null);
  const [workflow, workflowRef, setWorkflow] = useMirroredState<DesktopWorkflowState | null>(null);
  const paint = useCallback(
    (resolved: ResolvedDraftPrefs, options: { projectPath?: boolean } = {}) => {
      if (options.projectPath !== false) setProjectPath(resolved.projectPath);
      setModelSelection(resolved.modelSelection);
      setWorkflow(resolved.workflow);
    },
    [setModelSelection, setProjectPath, setWorkflow]
  );
  return {
    projectPath,
    projectPathRef,
    setProjectPath,
    modelSelection,
    modelSelectionRef,
    setModelSelection,
    workflow,
    workflowRef,
    setWorkflow,
    paint,
  };
}
