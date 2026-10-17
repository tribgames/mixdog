import { anchoredPanelGeometry, anchoredPanelStyle, paneBounds, rectFrom } from './anchored-panel';

export interface BreadcrumbPickerAnchor {
  x: number;
  /** Below the crumb: the panel's top edge. */
  top?: number;
  /** Above the crumb: the panel's bottom edge, as a CSS `bottom` offset. */
  bottom?: number;
  width: number;
  maxHeight: number;
  sourceIndex: number;
}

/** The shared anchored-popup rule (anchored-panel.ts) inside the editor's pane:
 *  below the crumb, left edges aligned, flipping above only when below cannot
 *  hold the picker and above is roomier. */
export function breadcrumbPickerAnchor(node: HTMLElement, sourceIndex: number): BreadcrumbPickerAnchor {
  const trigger = rectFrom(node);
  const geometry = anchoredPanelGeometry({
    trigger,
    bounds: paneBounds(node),
    preferredWidth: Math.max(240, window.innerWidth / 4.17),
    naturalHeight: 300,
  });
  // Above, the picker is bottom-pinned to the crumb so short content hugs it.
  const { top, bottom } = anchoredPanelStyle(geometry, trigger);
  return {
    x: geometry.left,
    top,
    bottom,
    width: geometry.width,
    maxHeight: Math.min(300, geometry.maxHeight),
    sourceIndex,
  };
}
