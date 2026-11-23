import { type CSSProperties, type RefObject, useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { anchoredPanelGeometry, anchoredPanelStyle, onAnchorEdges, paneBounds, rectFrom } from './anchored-panel';

/** Where a body-portalled panel stands against its anchor: placed from the
 *  measured panel, so the side it opens to fits all of it, and again when the
 *  window, the viewport, the anchor's box or the panel's own size changes.
 *  Hidden until first placed. */
export function useAnchoredPlacement({
  anchor,
  panel,
  width,
  side,
  align,
  shown = true,
}: {
  anchor: RefObject<HTMLElement | null>;
  panel: RefObject<HTMLElement | null>;
  /** The panel's width, or the anchor's own. */
  width: number | 'anchor';
  side: 'above' | 'below';
  align: 'start' | 'end';
  /** The panel is mounted. */
  shown?: boolean;
}): { style: CSSProperties; placement: 'above' | 'below' } {
  const [style, setStyle] = useState<CSSProperties>({
    left: 0,
    top: 0,
    width: width === 'anchor' ? undefined : width,
    visibility: 'hidden',
  });
  const [placement, setPlacement] = useState(side);
  const place = useCallback(() => {
    const trigger = anchor.current;
    const node = panel.current;
    if (!trigger || !node) return;
    const rect = rectFrom(trigger);
    // Its whole content's height, not the height an earlier, smaller room capped it to.
    const cap = node.style.maxHeight;
    node.style.maxHeight = 'none';
    const naturalHeight = node.scrollHeight;
    node.style.maxHeight = cap;
    const geometry = anchoredPanelGeometry({
      trigger: rect,
      bounds: paneBounds(trigger),
      preferredWidth: width === 'anchor' ? rect.width : width,
      naturalHeight,
      align,
      placement: side,
    });
    setPlacement(geometry.placement);
    const placed = anchoredPanelStyle(geometry, rect);
    // As wide as its anchor, it shares the anchor's edges, however near the pane's edge the anchor stands.
    setStyle(width === 'anchor' ? onAnchorEdges(placed, rect) : { ...placed, width: geometry.width });
  }, [anchor, panel, width, align, side]);

  useLayoutEffect(() => {
    if (shown) place();
  }, [shown, place]);

  useEffect(() => {
    const node = panel.current;
    if (!shown || !node) return undefined;
    const visual = window.visualViewport;
    window.addEventListener('resize', place);
    visual?.addEventListener('resize', place);
    visual?.addEventListener('scroll', place);
    // Rows that arrive after it opened make it taller; the anchor's own box
    // settles in a later render than the window event that moved it.
    const resized = new ResizeObserver(place);
    resized.observe(node);
    if (anchor.current) resized.observe(anchor.current);
    return () => {
      window.removeEventListener('resize', place);
      visual?.removeEventListener('resize', place);
      visual?.removeEventListener('scroll', place);
      resized.disconnect();
    };
  }, [shown, panel, anchor, place]);

  return { style, placement };
}
