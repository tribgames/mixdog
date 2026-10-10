import { type RefObject, useEffect } from 'react';
import { t } from './i18n';
import type { RouteSheetPane } from './route-editor-logic';

/** While the sheet is mounted: outside-click and Escape dismiss it, and any
 *  viewport movement re-places the panels. */
export function useRouteDismissal({
  mounted,
  pane,
  layout,
  closeAll,
  closePane,
  trigger,
  sheet,
  modelFlyout,
  optionFlyout,
}: {
  mounted: boolean;
  pane: RouteSheetPane | null;
  layout: () => void;
  closeAll: (restoreFocus?: boolean, immediate?: boolean) => void;
  closePane: (closedPane: RouteSheetPane, restoreFocus?: boolean) => void;
  trigger: RefObject<HTMLElement | null>;
  sheet: RefObject<HTMLElement | null>;
  modelFlyout: RefObject<HTMLElement | null>;
  optionFlyout: RefObject<HTMLElement | null>;
}) {
  useEffect(() => {
    if (!mounted) return undefined;
    layout();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        trigger.current?.contains(target) ||
        sheet.current?.contains(target) ||
        modelFlyout.current?.contains(target) ||
        optionFlyout.current?.contains(target)
      )
        return;
      closeAll();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (pane) closePane(pane, true);
      else closeAll(true);
    };
    const onViewport = () => layout();
    // A phone keyboard resizes and offsets the VISUAL viewport, which fires
    // no window resize on iOS: without these the panel kept its old box while
    // the composer moved and the two drifted apart (user: 타이핑창 올라오면서
    // 분리되어버린다).
    const visual = window.visualViewport;
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onViewport);
    window.addEventListener('scroll', onViewport, true);
    visual?.addEventListener('resize', onViewport);
    visual?.addEventListener('scroll', onViewport);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onViewport);
      window.removeEventListener('scroll', onViewport, true);
      visual?.removeEventListener('resize', onViewport);
      visual?.removeEventListener('scroll', onViewport);
    };
  }, [closeAll, closePane, layout, mounted, pane, trigger, sheet, modelFlyout, optionFlyout]);
}

// Pretendard splits Hangul into lazy unicode-range subsets, so a first open
// painted fallback glyphs and swapped mid-animation (user: 처음 열 때
// 폰트가 튄다). Warming the exact sheet/flyout strings at mount lands the
// real faces long before the picker ever opens.
export function useRouteFontWarmup() {
  useEffect(() => {
    try {
      void document.fonts.load(
        '400 13px "Pretendard Variable"',
        [
          t('Model'),
          t('Reasoning effort'),
          t('Context'),
          t('Speed'),
          t('Standard'),
          t('Fast'),
          t('Default speed'),
          t('Increased speed, increased usage'),
          t('Search models…'),
          t('Loading models…'),
          t('Select model'),
        ].join('')
      );
    } catch {
      /* font readiness stays cosmetic */
    }
  }, []);
}
