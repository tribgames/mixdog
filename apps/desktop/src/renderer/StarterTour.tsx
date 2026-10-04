// Spotlight tour for the getting-started guide: dims the app, cuts a hole
// around one real control at a time and explains it in a card beside it.
// Also the one-time welcome card that offers the tour after onboarding.
import { ArrowLeft, ArrowRight, Check, GraduationCap, MousePointerClick, ThumbsUp } from 'lucide-react';
import type React from 'react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { t } from './i18n';
import { FOCUSABLE_SELECTOR, trapTab } from './settings/dialog-modality';
import './starter-tour.css';

export interface TourStop {
  /** CSS selector, or selectors in priority order (a precise control first,
   *  then its container); the first VISIBLE match is spotlighted. */
  target: string | readonly string[];
  title: string;
  body: string;
  /** A recommendation shown as a highlighted callout under the body. */
  tip?: string;
  /** The spotlighted control is live: clicking it performs its real action
   *  and completes this stop (the tour steps aside for what it opens). */
  action?: boolean;
  /** With `action` on a non-final stop: selector of the form the control
   *  opens. Instead of ending, the tour steps aside while it is open and
   *  carries on at the next stop once it closes, however it was closed. */
  resume?: string;
}

type Side = 'right' | 'left' | 'below' | 'above' | 'center';

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

// Rail panels and settings mount lazily; a target that never shows up in
// this window is skipped (a final stop gets a centred card instead).
const TARGET_WAIT_MS = 2500;
const FALLBACK_AFTER_MS = 1200;
const TARGET_SEPARATOR = '\n';
const LIVE_CONTROL = 'button, input, select, textarea, a[href], [role="button"], [role="combobox"]';
const EDGE = 12;
const GAP = 14;
const PAD = 6;
// Rail list rows sit 4px apart, so a lit row keeps a 2px vertical margin
// inside that gap instead of reaching into its neighbours.
const LIST_ROW = '.schedules-row';
const LIST_ROW_PAD_Y = 2;

function findTarget(target: string | readonly string[]): HTMLElement | null {
  for (const selector of typeof target === 'string' ? [target] : target) {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const box = element.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) return element;
    }
  }
  return null;
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = window.getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/** Brings the target into view unless it is taller than its list and its
 *  top edge already shows: aligning such a target to the top would scroll
 *  the controls above it (the Extensions tabs) out of sight. */
function revealTarget(element: HTMLElement, scroller: HTMLElement | null): void {
  if (scroller) {
    const view = scroller.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    if (box.height > view.height && box.top >= view.top && box.top < view.bottom) return;
  }
  element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

function sameBox(current: Box | null, next: Box): boolean {
  return (
    current !== null &&
    current.top === next.top &&
    current.left === next.left &&
    current.width === next.width &&
    current.height === next.height
  );
}

const ARROW_INSET = 18;

/** Card beside the hole — right, left, below, above — centred on the
 *  target's middle, with the arrow offset that points back at it. */
export function tourCardPosition(
  target: Box | null,
  card: { width: number; height: number },
  view: { width: number; height: number }
): { top: number; left: number; side: Side; arrow: number } {
  const centred = {
    top: (view.height - card.height) / 2,
    left: (view.width - card.width) / 2,
    side: 'center' as const,
    arrow: 0,
  };
  if (!target) return centred;
  const clamp = (value: number, max: number) => Math.max(EDGE, Math.min(max - EDGE, value));
  const middleY = target.top + target.height / 2;
  const middleX = target.left + target.width / 2;
  const beside = (left: number, side: Side) => {
    const top = clamp(middleY - card.height / 2, view.height - card.height);
    const arrow = Math.max(ARROW_INSET, Math.min(card.height - ARROW_INSET, middleY - top));
    return { top, left, side, arrow };
  };
  const stacked = (top: number, side: Side) => {
    const left = clamp(middleX - card.width / 2, view.width - card.width);
    const arrow = Math.max(ARROW_INSET, Math.min(card.width - ARROW_INSET, middleX - left));
    return { top, left, side, arrow };
  };
  // Controls in the window's lower band (the composer row) sit among other
  // controls on the same line: a card beside them would cover their
  // neighbours, so it rises into the open space above instead.
  const above = target.top - GAP - card.height;
  if (target.top + target.height / 2 > view.height * 0.75 && above >= EDGE) return stacked(above, 'above');
  const right = target.left + target.width + GAP;
  if (right + card.width <= view.width - EDGE) return beside(right, 'right');
  const left = target.left - GAP - card.width;
  if (left >= EDGE) return beside(left, 'left');
  const below = target.top + target.height + GAP;
  if (below + card.height <= view.height - EDGE) return stacked(below, 'below');
  if (above >= EDGE) return stacked(above, 'above');
  // A target too big to sit beside: dock the card to the bottom edge so it
  // covers the target's tail, never its middle.
  return { ...stacked(view.height - card.height - EDGE, 'center'), side: 'center' };
}

/** Full-screen click shield; an action stop cuts the hole out of it so the
 *  real control underneath takes the click. */
function shieldClip(target: Box | null, live: boolean): string | undefined {
  if (!target || !live) return undefined;
  const { top, left, width, height } = target;
  const right = left + width;
  const bottom = top + height;
  return `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${left}px ${top}px, ${right}px ${top}px, ${right}px ${bottom}px, ${left}px ${bottom}px, ${left}px ${top}px)`;
}

/** Escape leaves and Tab cycles inside `root`; neither key reaches the dialog
 *  underneath (window capture runs before its document listener). */
function useModalKeys(root: { current: HTMLElement | null }, onEscape: () => void, enabled = true) {
  const handler = useRef(onEscape);
  handler.current = onEscape;
  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const element = root.current;
      if (!element || (event.key !== 'Escape' && event.key !== 'Tab')) return;
      event.stopPropagation();
      if (event.key === 'Tab') {
        trapTab(event, element, Array.from(element.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)));
        return;
      }
      event.preventDefault();
      handler.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [root, enabled]);
}

export function StarterTour({
  stops,
  onClose,
}: {
  stops: readonly TourStop[];
  /** `finished`: the last stop was completed. `handedOff`: an action stop's
   *  control was clicked and now owns the screen (a dialog, a form). */
  onClose(finished: boolean, handedOff: boolean): void;
}) {
  const [index, setIndex] = useState(0);
  // A resume stop's form is open: the tour is out of the way until it closes.
  const [aside, setAside] = useState(false);
  const [target, setTarget] = useState<Box | null>(null);
  const [ready, setReady] = useState(false);
  const [cardSize, setCardSize] = useState({ width: 320, height: 180 });
  const [, setViewport] = useState(0);
  const cardRef = useRef<HTMLElement>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const stop = stops[index];
  const last = index === stops.length - 1;
  const lastRef = useRef(last);
  lastRef.current = last;
  const asideRef = useRef(aside);
  asideRef.current = aside;
  const advance = () => (last ? onClose(true, false) : setIndex((value) => value + 1));
  // The form owns Escape and Tab while the tour stands aside.
  useModalKeys(cardRef, () => onClose(false, false), !aside);

  // An action stop completes when its live control is clicked. The click
  // runs its own handler first (capture only observes); the tour then steps
  // aside so whatever the control opened is usable.
  const onActionClick = useRef<() => void>(() => {});
  onActionClick.current = () => (stop.resume && !last ? setAside(true) : onClose(last, true));
  useEffect(() => {
    if (!stop.action || aside) return undefined;
    const onClick = (event: MouseEvent) => {
      const element = targetRef.current;
      // Only a real control counts: a click on the lit area's padding or
      // text is not "doing it".
      const control = event.target instanceof Element ? event.target.closest(LIVE_CONTROL) : null;
      if (!element || !control || !element.contains(control)) return;
      window.setTimeout(() => onActionClick.current(), 0);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [stop.action, aside]);

  // Back once the form has come and gone — saved or cancelled alike, since
  // the next stop works either way. A form that never opened (the click
  // failed) must not strand the tour off screen either.
  const resumeSelector = aside ? stop.resume : undefined;
  useEffect(() => {
    if (!resumeSelector) return undefined;
    const startedAt = performance.now();
    let opened = false;
    let frame = 0;
    const watch = () => {
      const open = document.querySelector(resumeSelector) !== null;
      opened ||= open;
      if ((opened && !open) || (!opened && performance.now() - startedAt > TARGET_WAIT_MS)) {
        setAside(false);
        setIndex((value) => value + 1);
        return;
      }
      frame = window.requestAnimationFrame(watch);
    };
    watch();
    return () => window.cancelAnimationFrame(frame);
  }, [resumeSelector]);

  // Follow the target every frame: panels slide, lists scroll and dialogs
  // animate in, and the hole must stay glued to the control through all of it.
  // Keyed by value: the parent rebuilds its stop list on every render.
  const targetKey = typeof stop.target === 'string' ? stop.target : stop.target.join(TARGET_SEPARATOR);
  useEffect(() => {
    setTarget(null);
    setReady(false);
    const startedAt = performance.now();
    const selectors = targetKey.split(TARGET_SEPARATOR);
    let element: HTMLElement | null = null;
    let scroller: HTMLElement | null = null;
    let frame = 0;
    const track = () => {
      // The precise control wins whenever it is on screen; a container
      // fallback is only taken once the control had its chance to mount
      // (Settings panels load their rows a beat after the dialog opens).
      const precise = findTarget(selectors.slice(0, 1));
      const fallbackAllowed = performance.now() - startedAt > FALLBACK_AFTER_MS;
      const next = precise ?? (element?.isConnected ? element : fallbackAllowed ? findTarget(selectors) : null);
      if (next !== element) {
        element = next;
        targetRef.current = element;
        scroller = element ? scrollParent(element) : null;
        if (element) revealTarget(element, scroller);
      }
      const box = element?.getBoundingClientRect();
      if (box && box.width > 0 && box.height > 0) {
        // The lit hole stops at its list's visible edge, so a long target
        // never spills over what is pinned below the list.
        const view = scroller?.getBoundingClientRect();
        const top = view ? Math.max(box.top, view.top) : box.top;
        const bottom = view ? Math.min(box.bottom, view.bottom) : box.bottom;
        const padY = element?.matches(LIST_ROW) ? LIST_ROW_PAD_Y : PAD;
        const next = {
          top: top - padY,
          left: box.left - PAD,
          width: box.width + PAD * 2,
          height: Math.max(0, bottom - top) + padY * 2,
        };
        setTarget((current) => (sameBox(current, next) ? current : next));
        setReady(true);
      } else if (performance.now() - startedAt > TARGET_WAIT_MS) {
        // A stop whose control never appeared is skipped rather than shown
        // as a dimmed screen with nothing lit; only a final stop falls back
        // to a centred card so the tour still ends on its explanation.
        // Standing aside, the form may cover or unmount the control; only
        // the form closing moves the tour on.
        if (asideRef.current) {
          frame = window.requestAnimationFrame(track);
          return;
        }
        if (!lastRef.current) {
          setIndex((value) => value + 1);
          return;
        }
        setTarget(null);
        setReady(true);
      }
      frame = window.requestAnimationFrame(track);
    };
    track();
    return () => window.cancelAnimationFrame(frame);
  }, [targetKey]);

  useEffect(() => {
    const onResize = () => setViewport((value) => value + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const next = { width: card.offsetWidth, height: card.offsetHeight };
    setCardSize((current) => (current.width === next.width && current.height === next.height ? current : next));
  });

  // Focus lands on the card once it shows; Back/Next keep focus afterwards.
  useEffect(() => {
    if (ready) cardRef.current?.focus();
  }, [ready]);

  if (aside) return null;
  const position = tourCardPosition(target, cardSize, { width: window.innerWidth, height: window.innerHeight });
  const live = Boolean(stop.action && target);
  return createPortal(
    <div className="starter-tour" data-modal-above="" data-ready={ready ? 'true' : undefined}>
      <div className="starter-tour-shield" style={{ clipPath: shieldClip(target, live) }} />
      {target ? (
        <div
          className="starter-tour-hole"
          data-live={live ? 'true' : undefined}
          style={{ top: target.top, left: target.left, width: target.width, height: target.height }}
        />
      ) : (
        <div className="starter-tour-scrim" />
      )}
      <section
        ref={cardRef}
        className="starter-tour-card"
        data-side={position.side}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        style={
          {
            top: position.top,
            left: position.left,
            '--starter-tour-arrow': `${position.arrow}px`,
          } as React.CSSProperties
        }
      >
        {stops.length > 1 && (
          <span className="starter-tour-count">
            {index + 1}/{stops.length}
          </span>
        )}
        <h2 id={titleId}>{stop.title}</h2>
        <p id={bodyId}>{stop.body}</p>
        {stop.tip && (
          <p className="starter-tour-tip">
            <ThumbsUp size={14} aria-hidden="true" /> {stop.tip}
          </p>
        )}
        {live && (
          <p className="starter-tour-try">
            <MousePointerClick size={14} aria-hidden="true" /> {t('Try it: click the highlighted control.')}
          </p>
        )}
        <footer>
          <button type="button" className="starter-tour-skip" onClick={() => onClose(false, false)}>
            {t('Skip')}
          </button>
          <div>
            {index > 0 && (
              <button type="button" onClick={() => setIndex((value) => value - 1)}>
                <ArrowLeft size={14} aria-hidden="true" /> {t('Back')}
              </button>
            )}
            <button type="button" className={live ? undefined : 'primary'} onClick={advance}>
              {last ? (
                <>
                  <Check size={14} aria-hidden="true" /> {t('Done')}
                </>
              ) : (
                <>
                  {t('Next')} <ArrowRight size={14} aria-hidden="true" />
                </>
              )}
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body
  );
}

export function StarterWelcome({
  steps,
  onStart,
  onLater,
}: {
  steps: readonly string[];
  onStart(): void;
  onLater(): void;
}) {
  const startRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const titleId = useId();
  useModalKeys(cardRef, onLater);
  useEffect(() => startRef.current?.focus(), []);
  return createPortal(
    <div className="starter-tour" data-modal-above="" data-ready="true">
      <div className="starter-tour-shield" />
      <div className="starter-tour-scrim" />
      <section ref={cardRef} className="starter-welcome" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <span className="starter-welcome-icon" aria-hidden="true">
          <GraduationCap size={20} />
        </span>
        <h2 id={titleId}>{t('Welcome to Mixdog')}</h2>
        <p>{t('Five quick steps to get set up.')}</p>
        <ol>
          {steps.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ol>
        <footer>
          <button type="button" className="starter-tour-skip" onClick={onLater}>
            {t('Maybe later')}
          </button>
          <button type="button" ref={startRef} className="primary" onClick={onStart}>
            {t('Start the tour')} <ArrowRight size={14} aria-hidden="true" />
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}
