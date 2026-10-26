// Keys in Comment mode, routed to the one pane they are meant for: Esc closes
// an open card, Alt+↑/↓ move the target, Space and ←/→ play and seek a video.
import { type RefObject, useEffect } from 'react';

import { paneCell, paneVideo } from './visualize-comment-pane';

/** Layers in Comment mode that take keys, and the one the pointer was last
 *  over: a key outside every pane goes to that pane only. */
const keyLayers = new Set<HTMLElement>();
let activeKeyLayer: HTMLElement | null = null;

/** The pointer is over this layer: keys outside every pane go to its pane. */
export function setActiveVisualizeKeyLayer(layer: HTMLElement): void {
  activeKeyLayer = layer;
}

/** Whether a key event in Comment mode is for this layer's pane: one inside
 *  its pane, or one outside every pane while it is the active (or only) one. */
function layerOwnsKey(layer: HTMLElement, target: Node | null): boolean {
  if (paneCell(layer)?.contains(target)) return true;
  const section = layer.closest('.visualize-pane');
  if (target && target !== document.body && !section?.contains(target)) return false;
  for (const other of keyLayers) if (other !== layer && paneCell(other)?.contains(target)) return false;
  if (activeKeyLayer?.isConnected && keyLayers.has(activeKeyLayer)) return activeKeyLayer === layer;
  return keyLayers.size === 1;
}

/** Takes this layer's keys while Comment mode is on in a pane that picks
 *  elements or plays media; the open draft and the actions are read live. */
export function useVisualizeCommentKeys(
  layer: RefObject<HTMLDivElement | null>,
  { comment, picks, media }: { comment: boolean; picks: boolean; media: boolean },
  live: RefObject<{ draft: unknown }>,
  keys: RefObject<{ close(): void; step(dir: 'up' | 'down'): void }>
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs passed in are stable; the keys are those the layer had
  useEffect(() => {
    const own = layer.current;
    if (!comment || (!picks && !media) || !own) return;
    keyLayers.add(own);
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !event.isTrusted) return;
      const target = event.target as HTMLElement | null;
      if (!layerOwnsKey(own, target)) return;
      if (event.key === 'Escape' && live.current.draft) {
        event.preventDefault();
        keys.current.close();
        return;
      }
      if (picks && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        keys.current.step(event.key === 'ArrowUp' ? 'up' : 'down');
        return;
      }
      if (!media) return;
      const typing =
        target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement || target?.isContentEditable;
      const playing = typing ? null : paneVideo(own);
      if (!playing) return;
      if (event.key === ' ') {
        event.preventDefault();
        if (playing.paused) void playing.play().catch(() => {});
        else playing.pause();
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        playing.pause();
        const delta = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 5 : 1);
        playing.currentTime = Math.max(0, playing.currentTime + delta);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      keyLayers.delete(own);
      if (activeKeyLayer === own) activeKeyLayer = null;
    };
  }, [comment, picks, media]);
}
