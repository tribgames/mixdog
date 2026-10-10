// The detail card a usage chart opens over one of its buckets: hover previews,
// a click pins, and the card is placed against its bucket inside the dialog.
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';
import { t } from './i18n';
import { useHoverPopover } from './hover-popover';
import { acquireModalLayer } from './modal-layer';

type TrendDetailMode = 'hover' | 'focus' | 'click';

/** `dependencies` are the chart inputs that move the buckets under the card. */
export function useTrendDetail(dependencies: readonly unknown[]) {
  const popover = useHoverPopover();
  const detailId = useId();
  const detailRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeKey and the caller's dependencies re-place the card; popover members are read at run time and popover.host/close are not stable identities
  useLayoutEffect(() => {
    const host = popover.host.current;
    const card = detailRef.current;
    const anchor = anchorRef.current;
    if (!popover.open || !host || !card || !anchor) return;
    const layer = acquireModalLayer([]);
    layer.attachSurface(card);
    const bounds = host.closest('.mixdog-settings__body')?.getBoundingClientRect() || {
      top: 0,
      left: 0,
      bottom: window.innerHeight,
      right: window.innerWidth,
    };
    const top = Math.max(0, bounds.top) + 8;
    const bottom = Math.min(window.innerHeight, bounds.bottom) - 8;
    const left = Math.max(0, bounds.left) + 8;
    const right = Math.min(window.innerWidth, bounds.right) - 8;
    card.style.maxHeight = `${Math.max(0, bottom - top)}px`;
    const size = card.getBoundingClientRect();
    const owner = host.getBoundingClientRect();
    const trigger = anchor.getBoundingClientRect();
    const above = owner.top - size.height - 8;
    setPosition({
      left: Math.max(left, Math.min(right - size.width, (trigger.left + trigger.right - size.width) / 2)) - owner.left,
      top: Math.max(top, above >= top ? above : Math.min(owner.bottom + 8, bottom - size.height)) - owner.top,
    });
    // A capture listener on window sees EVERY scroller in the document, and a
    // transcript pinned to its end scrolls on each streamed token — a session
    // running BEHIND the popup kept closing this card while the pointer still
    // sat on the bar (user: 바 위에 호버를 했는데 왜 팝업이 자동으로 사라지냐).
    // Only a scroller that CARRIES the chart moves the anchor the card is
    // placed against, so nothing else may dismiss it; the card scrolls inside
    // the host and is excluded by the same containment test.
    const dismissOnScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && !target.contains(host)) return;
      popover.close();
    };
    window.addEventListener('scroll', dismissOnScroll, true);
    window.addEventListener('resize', popover.close);
    return () => {
      layer.release();
      window.removeEventListener('scroll', dismissOnScroll, true);
      window.removeEventListener('resize', popover.close);
    };
  }, [popover.open, activeKey, ...dependencies]);
  const activate = (key: string, element: HTMLElement, mode: TrendDetailMode) => {
    if (mode === 'hover' && popover.pinned) return;
    anchorRef.current = element;
    const changingPinned = mode === 'click' && popover.pinned && activeKey !== key;
    setActiveKey(key);
    if (changingPinned) popover.setOpen(true);
    else if (mode === 'click') popover.triggerProps.onClick();
    else if (mode === 'focus') popover.triggerProps.onFocus();
    else popover.hostProps.onMouseEnter();
  };
  return {
    popover,
    detailId,
    detailRef,
    activeKey,
    position,
    /** Spread on the element that holds the buckets and the card. */
    hostProps: {
      ...popover.hostProps,
      // Only a bucket opens the card. Crossing the chart's frame on the way
      // in or out used to reopen the last bucket's card, so a stale date
      // flashed whenever the pointer left the plot (user: 호버 영역 벗어나면
      // 바로 날짜가 잠시 뜨네); entering the frame now only keeps an open card.
      onMouseEnter: () => {
        if (popover.open) popover.hostProps.onMouseEnter();
      },
      onKeyDownCapture: (event: KeyboardEvent<HTMLElement>) => {
        if (popover.open && event.key === 'Escape') {
          event.stopPropagation();
          popover.close();
        }
      },
    },
    /** Spread on the control of one bucket. */
    interaction: (key: string) => ({
      // The card IS this bucket's hint: the shared tooltip layer would echo
      // its accessible name in a second bubble under the chart.
      'data-tooltip': '',
      onMouseEnter: (event: MouseEvent<HTMLElement>) => activate(key, event.currentTarget, 'hover'),
      onFocus: (event: FocusEvent<HTMLElement>) => activate(key, event.currentTarget, 'focus'),
      onClick: (event: MouseEvent<HTMLElement>) => activate(key, event.currentTarget, 'click'),
      onBlur: popover.triggerProps.onBlur,
    }),
  };
}

type TrendDetail = ReturnType<typeof useTrendDetail>;

export function TrendDetailCard({
  detail,
  title,
  children,
}: {
  detail: TrendDetail;
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      className="stats-trend-detail"
      ref={detail.detailRef}
      id={detail.detailId}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${detail.detailId}-period`}
      style={detail.position}
      data-pinned={detail.popover.pinned ? 'true' : undefined}
    >
      <div className="stats-trend-detail-heading">
        <b id={`${detail.detailId}-period`}>{title}</b>
        <button type="button" aria-label={t('Close')} onClick={detail.popover.close}>
          <X aria-hidden="true" />
        </button>
      </div>
      {children}
    </div>
  );
}
