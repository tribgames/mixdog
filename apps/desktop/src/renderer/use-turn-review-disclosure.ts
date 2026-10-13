import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';
import { useComposerIslandTab } from './composer-island-state';

/** The review bar's open/closed state (local, or the island's `files` tab),
 *  its open file, revert confirm/error/undo bookkeeping, and the outside
 *  press / Escape listeners that collapse an expanded bar. */
export function useTurnReviewDisclosure(islandTab: boolean) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const [islandExpanded, setIslandExpanded] = useComposerIslandTab('files');
  const expanded = islandTab ? islandExpanded : localExpanded;
  const setIslandTabExpanded: Dispatch<SetStateAction<boolean>> = (value) =>
    setIslandExpanded(typeof value === 'function' ? value(islandExpanded) : value);
  const setExpanded = islandTab ? setIslandTabExpanded : setLocalExpanded;
  const [openFile, setOpenFile] = useState('');
  // Whether the bar shows file bodies right now. A collapsed bar on a phone
  // asks for files and line counts only; opening it re-reads in full.
  const detailShown = useRef(false);
  detailShown.current = expanded || openFile !== '';
  const [confirmFile, setConfirmFile] = useState('');
  const [reverted, setReverted] = useState<string[]>([]);
  // A refused revert used to vanish into an empty catch, so a legitimate
  // runtime refusal was indistinguishable from a dead button.
  const [revertError, setRevertError] = useState('');
  // The turn boundary at which the last revert succeeded. Until a new tool
  // completes, the runtime's (now emptier) diff outranks the transcript's
  // per-edit uiDiff, which still describes the mutation that was just undone.
  const [revertedBoundary, setRevertedBoundary] = useState('');
  // An expanded review closes on the first pointer press OUTSIDE its own box.
  // Presses inside (rows, revert, diff style) keep it open, so the disclosure
  // never collapses under its own controls.
  const barElement = useRef<HTMLElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: setExpanded is a new closure each render; the listeners only need to rebind when the bar opens, closes or changes kind.
  useEffect(() => {
    if (!expanded) return undefined;
    const collapse = () => {
      setExpanded(false);
      setOpenFile('');
      setConfirmFile('');
      setRevertError('');
    };
    const closeOnOutsidePointer = (event: Event) => {
      const element = barElement.current;
      const target = event.target as Node | null;
      if (!element || (target && element.contains(target))) return;
      collapse();
    };
    // As an island tab, Escape collapses it like the island's other tabs.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') collapse();
    };
    window.addEventListener('pointerdown', closeOnOutsidePointer, true);
    if (islandTab) document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [expanded, islandTab]);
  return {
    expanded,
    setExpanded,
    openFile,
    setOpenFile,
    detailShown,
    confirmFile,
    setConfirmFile,
    reverted,
    setReverted,
    revertError,
    setRevertError,
    revertedBoundary,
    setRevertedBoundary,
    barElement,
  };
}
