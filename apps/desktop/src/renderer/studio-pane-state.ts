// The Studio pane's own state groups (StudioView.tsx): the composer draft that
// survives restarts, the open detail viewer, and the gallery grid's width and
// entry motion.
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMobileBack } from './mobile-back';
import { readStudioDraftMetadata, writeStudioDraftMetadata } from './studio-draft-cache';
import { useStudioDetailKeyboardNav } from './studio-pane-detail-nav';
import { useStudioGridWidth } from './studio-pane-geometry';
import {
  DEFAULT_STUDIO_OPTIONS,
  STUDIO_GRID_MAX_WIDTH,
  type MediaAsset,
  type MediaKind,
  type StudioOptions,
} from './studio-support';

/** The composer draft — mode, lane, model, options, prompt — restored from
 *  the last session and saved while the pane is active. */
export function useStudioDraft(active: boolean) {
  const [restoredDraft] = useState(() => readStudioDraftMetadata());
  const [kind, setKind] = useState<MediaKind>(restoredDraft?.kind || 'image');
  const [laneId, setLaneId] = useState(restoredDraft?.laneId || '');
  const [model, setModel] = useState(restoredDraft?.model || '');
  const [options, setOptions] = useState<StudioOptions>(() => ({
    ...DEFAULT_STUDIO_OPTIONS,
    ...(restoredDraft?.options || {}),
  }));
  const [prompt, setPrompt] = useState(restoredDraft?.prompt || '');
  useEffect(() => {
    if (!active) return;
    writeStudioDraftMetadata({ kind, laneId, model, options, prompt });
  }, [active, kind, laneId, model, options, prompt]);
  return { kind, setKind, laneId, setLaneId, model, setModel, options, setOptions, prompt, setPrompt };
}

/** The media detail viewer: the opened asset, arrow-key paging, and its
 *  prompt, clamped to two lines until tapped. */
export function useStudioDetailView(visibleAssets: readonly MediaAsset[]) {
  const [selected, setSelected] = useState<MediaAsset | null>(null);
  // ABB: the media detail viewer closes on hardware back.
  useMobileBack(Boolean(selected), () => setSelected(null));
  useStudioDetailKeyboardNav(selected, visibleAssets, setSelected);
  // Compact detail sheet: the prompt is clamped to two lines and expands on tap.
  const [promptOpen, setPromptOpen] = useState(false);
  // ABB: an expanded prompt folds before the detail itself closes.
  useMobileBack(Boolean(selected) && promptOpen, () => setPromptOpen(false));
  // A newly opened asset starts with its prompt collapsed again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the collapse must rerun when the opened asset id changes, though the effect body reads no dependency
  useEffect(() => {
    setPromptOpen(false);
  }, [selected?.id]);
  return {
    selected,
    setSelected,
    promptOpen,
    togglePrompt: () => setPromptOpen((current) => !current),
    openDetail(asset: MediaAsset) {
      setPromptOpen(false);
      setSelected(asset);
    },
  };
}

/** The gallery grid's measured width, and whether its tiles may animate yet:
 *  the entry frame paints at settled geometry, without motion. */
export function useStudioGridMotion(active: boolean, gridRef: RefObject<HTMLDivElement | null>) {
  const [gridWidth, setGridWidth] = useState(STUDIO_GRID_MAX_WIDTH);
  const gridMotionFrame = useRef<number | null>(null);
  const [gridMotionReady, setGridMotionReady] = useState(false);
  useEffect(
    () => () => {
      if (gridMotionFrame.current !== null) window.cancelAnimationFrame(gridMotionFrame.current);
    },
    []
  );
  // The next Studio entry must paint directly at its settled geometry.
  useLayoutEffect(() => {
    if (!active) setGridMotionReady(false);
  }, [active]);
  useStudioGridWidth(active, gridRef, gridMotionFrame, setGridMotionReady, setGridWidth);
  return { gridWidth, gridMotionReady };
}
