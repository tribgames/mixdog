import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { anchoredPanelGeometry, anchoredPanelStyle, paneBounds, rectFrom } from './anchored-panel';
import { t } from './i18n';
import { closeOnUserScroll, useMenuDismiss } from './menu-dismiss';
import { useMobileBack } from './mobile-back';
import { ROUTE_PANEL_WIDTH } from './route-editor-logic';
import { moveRouteFocus, type RouteSessionChoice, routeSessionChoicePane } from './route-editor-panes';
import { useSurfaceActive } from './surface-activity';

const OPTION_SELECTOR = '.route-sheet-option:not(:disabled)';

/** The route label's own menu under the composer card: the conversation's
 *  workflow and delegation options, anchored to the label (right edges shared,
 *  above it) and as tall as its options. A tap on any option closes it. */
export function ComposerRouteChoices({
  anchor,
  choices,
  onClose,
  side = 'above',
  align = 'end',
}: {
  anchor: RefObject<HTMLElement | null>;
  choices: RouteSessionChoice[];
  onClose(restoreFocus: boolean): void;
  /** Where it opens from its anchor: the session panel's rows open it below, from their start. */
  side?: 'above' | 'below';
  align?: 'start' | 'end';
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({
    left: 0,
    top: 0,
    width: ROUTE_PANEL_WIDTH,
    visibility: 'hidden',
  });
  const [placement, setPlacement] = useState<'above' | 'below'>('above');
  const close = useCallback(() => onClose(false), [onClose]);

  // Placed from the measured panel, so the side it opens to fits all of it.
  const place = useCallback(() => {
    const trigger = anchor.current;
    const node = panel.current;
    if (!trigger || !node) return;
    const rect = rectFrom(trigger);
    const geometry = anchoredPanelGeometry({
      trigger: rect,
      bounds: paneBounds(trigger),
      preferredWidth: ROUTE_PANEL_WIDTH,
      naturalHeight: node.scrollHeight,
      align,
      placement: side,
    });
    setPlacement(geometry.placement);
    setStyle({ ...anchoredPanelStyle(geometry, rect), width: geometry.width });
  }, [anchor, align, side]);

  useLayoutEffect(() => {
    place();
    const node = panel.current;
    (
      node?.querySelector<HTMLElement>(`${OPTION_SELECTOR}[aria-checked="true"]`) ??
      node?.querySelector<HTMLElement>(OPTION_SELECTOR)
    )?.focus({
      preventScroll: true,
    });
  }, [place]);

  useEffect(() => {
    const visual = window.visualViewport;
    window.addEventListener('resize', place);
    visual?.addEventListener('resize', place);
    visual?.addEventListener('scroll', place);
    const stopScroll = closeOnUserScroll(close, (target) =>
      Boolean(target && (panel.current?.contains(target) || anchor.current?.contains(target)))
    );
    return () => {
      window.removeEventListener('resize', place);
      visual?.removeEventListener('resize', place);
      visual?.removeEventListener('scroll', place);
      stopScroll();
    };
  }, [anchor, close, place]);

  const surfaceActive = useSurfaceActive();
  useEffect(() => {
    if (!surfaceActive) close();
  }, [close, surfaceActive]);
  useMenuDismiss({ open: true, close, trigger: anchor, panels: () => [panel.current] });
  useMobileBack(true, () => onClose(true));

  const onOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    moveRouteFocus(event, panel.current, OPTION_SELECTOR);
  };
  return createPortal(
    <div
      ref={panel}
      className="route-sheet-flyout composer-route-choices"
      role="menu"
      aria-label={t('Workflow and delegation')}
      data-placement={placement}
      data-state="open"
      style={style}
    >
      {choices.map((choice) => (
        // biome-ignore lint/a11y/useSemanticElements: a fieldset's default border and margins would change the menu.
        <div key={choice.id} className="composer-route-choices-group" role="group" aria-label={choice.label}>
          <div className="route-sheet-flyout-title" aria-hidden="true">
            {choice.label}
          </div>
          {routeSessionChoicePane({ choice, onOptionKeyDown, onPicked: () => onClose(true) })}
        </div>
      ))}
    </div>,
    document.body
  );
}
