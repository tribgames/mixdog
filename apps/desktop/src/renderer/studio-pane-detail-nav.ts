import { type RefObject, useEffect, useRef } from 'react';
import type { MediaAsset } from './studio-support';

// Plain arrow keys page through the gallery while the detail viewer is open,
// unless the key belongs to a text field, select, or playing video. Escape
// closes the viewer only when it is the viewer's: focus inside it, or on the
// page itself while this pane is the focused one. The composer, dialogs, menus
// and other panes keep their own Escape (a menu inside the viewer stops it first).
export function useStudioDetailKeyboardNav(
  selected: MediaAsset | null,
  visibleAssets: readonly MediaAsset[],
  setSelected: (asset: MediaAsset | null) => void,
  paneRef: RefObject<HTMLElement | null>,
  ownsPage: boolean
) {
  const ownsPageRef = useRef(ownsPage);
  ownsPageRef.current = ownsPage;
  useEffect(() => {
    if (!selected) return undefined;
    const navigate = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.isComposing || event.defaultPrevented) return;
        const target = event.target;
        const viewer = paneRef.current?.querySelector('.studio-detail');
        const inViewer = Boolean(viewer && target && viewer.contains(target as Node));
        const onPage = target === document.body || target === document.documentElement || target === document;
        if (!inViewer && !(onPage && ownsPageRef.current)) return;
        event.preventDefault();
        setSelected(null);
        return;
      }
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
  }, [selected, setSelected, visibleAssets, paneRef]);
}
