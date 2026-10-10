import { useEffect } from 'react';
import type { MediaAsset } from './studio-support';

// Plain arrow keys page through the gallery while the detail viewer is open,
// unless the key belongs to a text field, select, or playing video.
export function useStudioDetailKeyboardNav(
  selected: MediaAsset | null,
  visibleAssets: readonly MediaAsset[],
  setSelected: (asset: MediaAsset) => void
) {
  useEffect(() => {
    if (!selected) return undefined;
    const navigate = (event: KeyboardEvent) => {
      if (
        (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.isComposing ||
        event.defaultPrevented
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLVideoElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      )
        return;
      const index = visibleAssets.findIndex((asset) => asset.id === selected.id);
      if (index < 0) return;
      const next = visibleAssets[index + (event.key === 'ArrowRight' ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      setSelected(next);
    };
    window.addEventListener('keydown', navigate);
    return () => window.removeEventListener('keydown', navigate);
  }, [selected, setSelected, visibleAssets]);
}
