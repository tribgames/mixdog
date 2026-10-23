// The desktop pet's body, drawn inside its own always-on-top window
// (desktop-pet-main.tsx): Mixy's mascot, its speech bubble (Mixy's latest
// reply, or a symbol of the chat's live state), and the one-line quick message a click unfolds at
// the pet's feet while the pet hops up onto it. Everything that leaves the
// window (sending, opening the app, the menu, moving the window) is a prop;
// nothing here sends or navigates by itself.
import { ArrowUp, Copy, X } from 'lucide-react';
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { DesktopPetDrag } from '../shared/desktop-pet';
import { t } from './i18n';
import type { CompanionBubble } from './skin-companion-model';
import { measureReplyPages, pageReadMs, type ReplyPage, renderReplyBlocks, replyBlocks } from './skin-companion-paging';

const DRAG_THRESHOLD = 4;
const NUDGE = 8;
const NUDGE_FAR = 32;
/** The soft drop and fold on close (desktop-pet.css skin-companion-fold). */
const QUICK_FOLD_MS = 200;
/** The reply bubble's fade before it is dismissed (desktop-pet.css). */
export const REPLY_FADE_MS = 200;
export const REPLY_HIDE_BASE_MS = 8000;
export const REPLY_HIDE_PER_CHAR_MS = 50;
export const REPLY_HIDE_MAX_MS = 20000;

/** How long a reply stays up untouched: 8 s plus a little per character, at most 20 s. */
export function replyHideMs(text: string): number {
  return Math.min(REPLY_HIDE_MAX_MS, REPLY_HIDE_BASE_MS + REPLY_HIDE_PER_CHAR_MS * [...text].length);
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: no-preference)').matches !== true;

/** What a screen reader hears for a state; idle says nothing (no bubble). */
export function bubbleLabel(bubble: CompanionBubble): string {
  switch (bubble.kind) {
    case 'working':
      return t('Companion: working');
    case 'approval':
      return t('Companion: waiting for your approval');
    case 'reply':
      return t('Companion: Mixy replied');
    default:
      return '';
  }
}

/** Rendered reply blocks (skin-companion-paging.ts draws them: the same
 *  drawing the pages are measured with). */
function ReplyMarkdown({ className, page }: { className: string; page: ReplyPage }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node) node.replaceChildren(renderReplyBlocks(node.ownerDocument, page.blocks));
  }, [page]);
  return <div ref={ref} className={`${className} skin-companion-md`} />;
}

/** A short reply, within the short bubble's height budget
 *  (desktop-pet.css). Its first layout tells whether it overflows: a longer
 *  one is then read page by page (PagedReply). */
function ReplyText({ text, onMeasured }: { text: string; onMeasured: ReplyMeasured }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.replaceChildren(renderReplyBlocks(node.ownerDocument, replyBlocks(text)));
    onMeasured(text, node, node.clientHeight < node.scrollHeight - 1);
  }, [text, onMeasured]);
  return <div ref={ref} className="skin-companion-reply skin-companion-md" />;
}

type ReplyMeasured = (text: string, node: HTMLElement, long: boolean) => void;

/** The page turn: the bubble's height eases to the new page's. */
const PAGE_TURN_MS = 240;
const PAGE_TURN_EASING = 'cubic-bezier(0.2, 0.9, 0.3, 1)';

/** A long reply's top bar (the bot's name, Copy for the whole reply, ✕),
 *  its current page, and the dots under it (the current one fills as its
 *  time runs while `timed`). */
function PagedReply({
  name,
  paging,
  timed,
  onCopy,
  onClose,
}: {
  name: string;
  paging: ReplyPaging;
  timed: boolean;
  onCopy: () => void;
  onClose: () => void;
}) {
  const { pages, index, turn } = paging;
  const clip = useRef<HTMLDivElement | null>(null);
  const height = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per page turn
  useLayoutEffect(() => {
    const node = clip.current;
    if (!node) return;
    const to = node.offsetHeight;
    const from = height.current;
    height.current = to;
    if (from && from !== to && !reducedMotion()) {
      node.animate([{ height: `${from}px` }, { height: `${to}px` }], {
        duration: PAGE_TURN_MS,
        easing: PAGE_TURN_EASING,
      });
    }
  }, [index]);
  const tool = (label: string, className: string, icon: ReactNode, run: () => void) => (
    <button
      type="button"
      className={`skin-companion-reply-tool ${className}`}
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        run();
      }}
    >
      {icon}
    </button>
  );
  return (
    <>
      <div className="skin-companion-reply-bar">
        <span className="skin-companion-reply-name">{name}</span>
        {tool(t('Copy'), 'skin-companion-reply-copy', <Copy size={15} aria-hidden="true" />, onCopy)}
        {tool(t('Close'), 'skin-companion-reply-close', <X size={15} aria-hidden="true" />, onClose)}
      </div>
      <div ref={clip} className="skin-companion-page-clip">
        <ReplyMarkdown key={index} className="skin-companion-page" page={pages[index]} />
      </div>
      {pages.length > 1 && (
        <span className="skin-companion-pages" data-timed={timed ? 'true' : undefined} aria-hidden="true">
          {pages.map((_, n) => (
            <i
              key={n === index ? `on-${turn}` : n}
              data-page={n < index ? 'done' : n === index ? 'on' : undefined}
              style={n === index ? ({ '--page-ms': `${pageReadMs(pages[n].text)}ms` } as CSSProperties) : undefined}
            />
          ))}
        </span>
      )}
    </>
  );
}

interface ReplyPaging {
  pages: ReplyPage[];
  index: number;
  /** Bumped on every turn (by hand or by time): the page's timer restarts. */
  turn: number;
  go: (index: number) => void;
}

/** The shown reply's pages and reading time. `pages` is null for a short
 *  reply (or one not laid out yet: `measured` false). Each page's time runs
 *  while nothing holds it (pointer, focus, off screen), resumes where it
 *  stopped, and restarts on a turn; when it runs out the next page shows
 *  (`autoAdvance`), and on the last page `lastDone` lets the reply close. */
function useReplyPaging(
  replyKey: string,
  text: string,
  held: boolean,
  autoAdvance: boolean,
  measure: (anchor: HTMLElement, text: string) => ReplyPage[],
  /** The bubble's width cap (0: none): a new one measures the reply again. */
  width: number
) {
  const [split, setSplit] = useState<{ text: string; width: number; pages: ReplyPage[] | null } | null>(null);
  const measured = Boolean(text) && split?.text === text && split.width === width;
  const pages = measured ? (split?.pages ?? null) : null;
  const [at, setAt] = useState({ key: '', index: 0, turn: 0 });
  const last = pages ? pages.length - 1 : 0;
  const index = at.key === replyKey ? Math.min(at.index, last) : 0;
  const turn = at.key === replyKey ? at.turn : 0;
  const pageId = `${replyKey}\n${index}\n${turn}`;
  const pageText = pages?.[index]?.text ?? '';
  const [doneId, setDoneId] = useState('');
  const go = useCallback(
    (next: number) =>
      setAt((current) => ({ key: replyKey, index: next, turn: (current.key === replyKey ? current.turn : 0) + 1 })),
    [replyKey]
  );
  const spent = useRef({ id: '', ms: 0 });
  useEffect(() => {
    if (!pageText || held || doneId === pageId) return;
    const before = spent.current.id === pageId ? spent.current.ms : 0;
    const start = window.performance.now();
    const timer = window.setTimeout(
      () => {
        setDoneId(pageId);
        if (autoAdvance && index < last) go(index + 1);
      },
      Math.max(0, pageReadMs(pageText) - before)
    );
    return () => {
      window.clearTimeout(timer);
      spent.current = { id: pageId, ms: before + window.performance.now() - start };
    };
  }, [pageText, held, doneId, pageId, autoAdvance, index, last, go]);
  const onMeasured = useCallback<ReplyMeasured>(
    (measuredText, node, long) =>
      setSplit((current) =>
        current?.text === measuredText && current.width === width
          ? current
          : { text: measuredText, width, pages: long ? measure(node, measuredText) : null }
      ),
    [measure, width]
  );
  return {
    measured,
    paging: pages ? { pages, index, turn, go } : null,
    /** The end is on screen: a short reply, or a long one's last page. */
    atEnd: measured && (!pages || index === last),
    lastDone: !pages || (index === last && doneId === pageId),
    /** What stays up for the dismiss timeout once read. */
    lastText: pages ? pages[last].text : text,
    onMeasured,
  };
}

/** The comic symbol of a busy state. Idle has no bubble; a reply is ReplyText. */
function BubbleSymbol({ bubble }: { bubble: CompanionBubble }) {
  switch (bubble.kind) {
    case 'working':
      return (
        <span className="skin-companion-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      );
    case 'approval':
      return (
        <span className="skin-companion-mark" aria-hidden="true">
          !
        </span>
      );
    default:
      return null;
  }
}

const isContextMenuKey = (event: { key: string; shiftKey: boolean }) =>
  event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);

/** How the quick message or the menu was last opened from the pet: focus
 *  returns to the pet with its ring only when that was the keyboard (a
 *  mouse user who typed and pressed Enter or Esc gets no box). */
let openedByKeyboard = false;
export function notePetOpenedBy(keyboard: boolean): void {
  openedByKeyboard = keyboard;
}

/** The overlay's keyboard rings (desktop-pet.css: the bubble, its reply
 *  tools, the menu's items; never the bot, which draws none) show only while
 *  this is set: a navigation key in the overlay since the last pointer
 *  press. A script focus (the window gaining focus, focus handed back) never
 *  draws them by itself. */
export function setPetKeyboardUse(on: boolean, root: HTMLElement = document.documentElement): void {
  if (on) root.dataset.petKeys = 'true';
  else delete root.dataset.petKeys;
}

/** The keys that move or act in the overlay. Any other (a modifier alone,
 *  PrintScreen, the Win+Shift+S chord of a screenshot, typing) leaves the
 *  ring as it is. */
const PET_NAVIGATION_KEYS = new Set([
  'Tab',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Enter',
  ' ',
  'Escape',
  'ContextMenu',
]);
export function isPetNavigationKey(event: { key: string; shiftKey: boolean }): boolean {
  return PET_NAVIGATION_KEYS.has(event.key) || (event.key === 'F10' && event.shiftKey);
}

/** Navigation keys in this document turn the ring on; a press turns it off. */
export function trackPetKeyboardUse(doc: Document = document): () => void {
  const key = (event: globalThis.KeyboardEvent) => {
    if (isPetNavigationKey(event)) setPetKeyboardUse(true, doc.documentElement);
  };
  const press = () => setPetKeyboardUse(false, doc.documentElement);
  doc.addEventListener('keydown', key, true);
  doc.addEventListener('pointerdown', press, true);
  return () => {
    doc.removeEventListener('keydown', key, true);
    doc.removeEventListener('pointerdown', press, true);
  };
}

/** Back to the pet: the focus ring only for keyboard users. */
export function focusPet(element: HTMLElement | null | undefined): void {
  if (!element) return;
  setPetKeyboardUse(openedByKeyboard, element.ownerDocument.documentElement);
  element.focus({ preventScroll: true, focusVisible: openedByKeyboard } as FocusOptions);
}

export interface CompanionPetProps {
  face: ReactNode;
  /** The bot's name, on a long reply's top bar. */
  name?: string;
  bubble: CompanionBubble;
  /** "Collapse bubble" (the pet's menu): only the pet shows. */
  collapsed: boolean;
  /** Mixy's chat is there to send to. */
  canSend: boolean;
  /** Drag and arrow keys move it (off while pinned above the message box). */
  movable?: boolean;
  /** The reply bubble was clicked: open Mixy's chat in the app at that reply. */
  onOpen: () => void;
  /** Mixy's chat's send path (main → the composer's own route). */
  onSend: (text: string) => Promise<unknown>;
  /** The shown reply is seen: its bubble timed out, or the user left the
   *  quick message (Esc, blur, sent). Only the pet's display clears. */
  onDismiss: (key: string) => void;
  /** Right-click, Shift+F10 or the ContextMenu key. */
  onMenu: () => void;
  /** Pointer drag of the window by the pet. */
  onDrag: (drag: DesktopPetDrag) => void;
  /** Arrow keys on the focused pet. */
  onNudge: (dx: number, dy: number) => void;
  /** Double-click: back to the default spot. */
  onReset: () => void;
  /** The quick message opened/closed: the window takes/leaves keyboard focus. */
  onInputFocus: (open: boolean) => void;
  /** Bumped when the window lost focus: the quick message closes. */
  blurSignal: number;
  /** The window is off screen: the idle animation stops. */
  paused?: boolean;
  /** Mixy's chat is the app's focused view: no bubble, and a click opens
   *  (focuses) that chat instead of the quick message. */
  quiet?: boolean;
  /** A long reply turns its pages by itself (default on). */
  autoAdvance?: boolean;
  /** A read reply closes by itself after its timeout (default on). */
  autoClose?: boolean;
  /** The reply with this key was read here: shown, a long one to its last page. */
  onRead?: (key: string) => void;
  /** Copy the whole reply with this key (main's clipboard). */
  onCopy?: (key: string) => void;
  /** Splits a long reply into pages (default: measured in the bubble's font). */
  measurePages?: (anchor: HTMLElement, text: string) => ReplyPage[];
  /** The span of the window (window px) the bubble stays 16px inside: the
   *  app window's content or the work area (default: the whole window). */
  bubbleSpan?: BubbleSpan;
}

type BubbleSpan = { left: number; right: number };

/** The shown reply fades after its hide time and is then dismissed; `held`
 *  stops the countdown and the fade. Returns whether the bubble is fading. */
function useReplyFade(
  replyKey: string,
  replyText: string,
  held: boolean,
  onDismissRef: { current: (key: string) => void }
): boolean {
  const [fadingKey, setFadingKey] = useState('');
  useEffect(() => {
    if (!replyKey || held) return;
    const timer = window.setTimeout(() => {
      if (reducedMotion()) onDismissRef.current(replyKey);
      else setFadingKey(replyKey);
    }, replyHideMs(replyText));
    return () => window.clearTimeout(timer);
  }, [replyKey, replyText, held, onDismissRef]);
  // Held mid-fade: the fade stops and the bubble is back; the countdown
  // starts over once nothing holds it.
  useEffect(() => {
    if (held) setFadingKey('');
  }, [held]);
  useEffect(() => {
    if (!fadingKey || held) return;
    const timer = window.setTimeout(() => onDismissRef.current(fadingKey), REPLY_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [fadingKey, held, onDismissRef]);
  return Boolean(replyKey) && fadingKey === replyKey && !held;
}

/** Pointer drag of the window by the pet; `suppressClickRef` marks the click that ends a drag. */
function useMascotDrag(movable: boolean, onDrag: (drag: DesktopPetDrag) => void) {
  const [dragging, setDragging] = useState(false);
  const suppressClickRef = useRef(false);
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    suppressClickRef.current = false;
    if (event.button !== 0 || !movable) return;
    const target = event.currentTarget;
    const origin = { screenX: event.screenX, screenY: event.screenY };
    const pointerId = event.pointerId;
    let moved = false;
    target.setPointerCapture?.(pointerId);
    const move = (ev: globalThis.PointerEvent) => {
      if (!moved) {
        if (Math.hypot(ev.screenX - origin.screenX, ev.screenY - origin.screenY) < DRAG_THRESHOLD) return;
        moved = true;
        setDragging(true);
        onDrag({ phase: 'start', ...origin });
      }
      onDrag({ phase: 'move', screenX: ev.screenX, screenY: ev.screenY });
    };
    const up = (ev: globalThis.PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
      if (!moved) return;
      // The click that ends a drag is not a click.
      suppressClickRef.current = true;
      setDragging(false);
      onDrag({ phase: 'end', screenX: ev.screenX, screenY: ev.screenY });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };
  return { dragging, suppressClickRef, onPointerDown };
}

/** How far inside either edge of its span the bubble stays (desktop-pet.css). */
const BUBBLE_EDGE = 16;

/** One bubble element for every state: the reply grows out of the same
 *  anchored bubble the typing dots were in. Pointer and focus are held
 *  through `setHovered` / `setFocusWithin`. A click or Enter closes a short
 *  reply. A long one is read page by page: a click or → turns to the next
 *  page (← back), and on the last page a click or Enter closes it. Esc
 *  closes a reply. The quick message opens from the pet, not the bubble. */
function CompanionBubbleView({
  bubble,
  name,
  fading,
  held,
  paging,
  timed,
  onMeasured,
  onCopy,
  onClose,
  setHovered,
  setFocusWithin,
  span,
}: {
  bubble: CompanionBubble;
  name: string;
  fading: boolean;
  /** The page's time is paused (the current dot's fill stops). */
  held: boolean;
  paging: ReplyPaging | null;
  timed: boolean;
  onMeasured: ReplyMeasured;
  onCopy: () => void;
  onClose: () => void;
  setHovered: (hovered: boolean) => void;
  setFocusWithin: (focused: boolean) => void;
  span: BubbleSpan | undefined;
}) {
  const finished = bubble.kind === 'reply';
  const paged = finished && paging !== null;
  // A short reply: a click (Enter/Space) closes it.
  const short = finished && !paged;
  const ref = useRef<HTMLDivElement | null>(null);
  // Kept 16px inside both edges of its span (the app window's content or
  // the work area; the window without one): moved left when wider than the
  // room right of the head, right when the head is that near the left edge
  // (its tail stays on the pet), measured from the layout box (not the grow
  // animation's scale).
  useLayoutEffect(() => {
    const node = ref.current;
    const balloon = node?.parentElement?.parentElement;
    if (!node || !balloon) return;
    const start = (span?.left ?? 0) + BUBBLE_EDGE;
    const end = (span?.right ?? window.innerWidth) - BUBBLE_EDGE;
    const left = balloon.getBoundingClientRect().left;
    const shift = Math.max(start - left, Math.min(0, end - left - node.offsetWidth));
    if (shift !== 0) node.style.setProperty('--bubble-shift', `${Math.round(shift)}px`);
    else node.style.removeProperty('--bubble-shift');
  });
  const turn = () => {
    if (!paging) return;
    if (paging.index < paging.pages.length - 1) paging.go(paging.index + 1);
    else onClose();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (paging) {
      const last = paging.index === paging.pages.length - 1;
      if (event.key === 'ArrowRight' && !last) paging.go(paging.index + 1);
      else if (event.key === 'ArrowLeft' && paging.index > 0) paging.go(paging.index - 1);
      else if (event.key === 'Enter' && last) onClose();
      else return;
      event.preventDefault();
      return;
    }
    if (!short || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    onClose();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a button or a focusable group whenever it has a handler
    <div
      ref={ref}
      className="skin-companion-bubble"
      data-pet-hit=""
      data-state={bubble.kind}
      data-paged={paged ? 'true' : undefined}
      data-held={paged && held ? 'true' : undefined}
      data-fading={fading ? 'true' : undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false);
      }}
      role={paged ? 'group' : undefined}
      tabIndex={finished ? 0 : undefined}
      onClick={short ? onClose : paged ? turn : undefined}
      onKeyDown={finished ? onKeyDown : undefined}
    >
      {paging && finished ? (
        <PagedReply name={name} paging={paging} timed={timed} onCopy={onCopy} onClose={onClose} />
      ) : finished ? (
        <ReplyText text={bubble.text} onMeasured={onMeasured} />
      ) : (
        <BubbleSymbol bubble={bubble} />
      )}
    </div>
  );
}
interface QuickMessageOptions {
  canSend: boolean;
  quiet: boolean;
  blurSignal: number;
  onSend: (text: string) => Promise<unknown>;
  onInputFocus: (open: boolean) => void;
  onDismissRef: { current: (key: string) => void };
  replyKeyRef: { current: string };
  mascotRef: { current: HTMLButtonElement | null };
}

/** The quick message at the pet's feet: open state, draft, send, and the fold on close. */
function useQuickMessage({
  canSend,
  quiet,
  blurSignal,
  onSend,
  onInputFocus,
  onDismissRef,
  replyKeyRef,
  mascotRef,
}: QuickMessageOptions) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [inputOpen, setInputOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const sendingRef = useRef(false);
  /** An IME (Korean, Japanese, …) is composing in the quick message. */
  const composingRef = useRef(false);
  /** Bumped whenever the quick message opens or closes: a send answers only
   *  the same, still open input it came from. */
  const inputGenRef = useRef(0);
  const quickInput = inputOpen && canSend;

  // Closing folds the input back into the pet's feet before it unmounts
  // (instantly under reduced motion).
  const [folding, setFolding] = useState(false);
  const wasOpen = useRef(false);
  const onInputFocusRef = useRef(onInputFocus);
  onInputFocusRef.current = onInputFocus;
  useEffect(() => {
    inputGenRef.current += 1;
    if (quickInput) {
      wasOpen.current = true;
      setFolding(false);
      onInputFocusRef.current(true);
      inputRef.current?.focus();
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    onInputFocusRef.current(false);
    // Leaving the quick message clears what the pet shows: the draft and the
    // reply on display (seen). A later reply shows as usual.
    setDraft('');
    composingRef.current = false;
    if (replyKeyRef.current) onDismissRef.current(replyKeyRef.current);
    if (reducedMotion()) return;
    setFolding(true);
    const timer = window.setTimeout(() => setFolding(false), QUICK_FOLD_MS);
    return () => window.clearTimeout(timer);
  }, [quickInput, onDismissRef, replyKeyRef]);
  useEffect(() => {
    if (blurSignal) setInputOpen(false);
  }, [blurSignal]);
  useEffect(() => {
    if (quiet) setInputOpen(false);
  }, [quiet]);

  const closeInput = () => {
    setInputOpen(false);
    focusPet(mascotRef.current);
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    // Mid-composition the last syllable is not in the draft yet.
    if (!text || sendingRef.current || composingRef.current) return;
    sendingRef.current = true;
    setDraft('');
    // A refused or failed send keeps the text for another try — only in the
    // same input, still open: one the user left (Esc, blur) stays cleared.
    const generation = inputGenRef.current;
    const same = () => inputGenRef.current === generation;
    const restore = () => {
      if (same()) setDraft((current) => current || text);
    };
    try {
      // Sent: the input stays open, cleared and focused, for the next line
      // (it closes on Esc, blur or the bot); the reply shows above it.
      if ((await onSend(text)) === true) {
        if (same()) inputRef.current?.focus();
      } else restore();
    } catch {
      restore();
    } finally {
      sendingRef.current = false;
    }
  };

  return {
    quickInput,
    folding,
    draft,
    setDraft,
    inputRef,
    composingRef,
    toggle: () => setInputOpen((open) => !open),
    open: () => setInputOpen(true),
    closeInput,
    send,
  };
}

/** How far inside either edge of its span the quick message stays. */
const QUICK_EDGE = 4;

function QuickMessageForm({
  quick,
  span,
}: {
  quick: ReturnType<typeof useQuickMessage>;
  span: BubbleSpan | undefined;
}) {
  const { quickInput, folding, draft, setDraft, inputRef, composingRef, closeInput, send } = quick;
  const ref = useRef<HTMLFormElement | null>(null);
  const shiftRef = useRef(0);
  // Centred under the pet, moved inside its span (the screen or the app
  // window's content) where the bot stands at a side edge and the window
  // runs past it; measured from the layout box (not the unfold's scale).
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) {
      shiftRef.current = 0;
      return;
    }
    const left = node.offsetLeft - shiftRef.current;
    const shift = span
      ? Math.round(
          Math.max(span.left + QUICK_EDGE - left, Math.min(0, span.right - QUICK_EDGE - left - node.offsetWidth))
        )
      : 0;
    shiftRef.current = shift;
    if (shift !== 0) node.style.setProperty('--quick-shift', `${shift}px`);
    else node.style.removeProperty('--quick-shift');
  });
  if (!quickInput && !folding) return null;
  return (
    <form
      ref={ref}
      className="skin-companion-quick"
      data-pet-hit=""
      data-folding={quickInput ? undefined : 'true'}
      onSubmit={send}
    >
      <input
        ref={inputRef}
        type="text"
        value={draft}
        maxLength={4000}
        aria-label={t('Quick message')}
        placeholder={t('Quick message')}
        onChange={(event) => setDraft(event.target.value)}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onKeyDown={(event) => {
          // The key that commits an IME syllable (Enter, Esc) belongs to
          // the IME: no send, no close, like the app composer.
          if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) {
            if (event.key === 'Enter') event.preventDefault();
            return;
          }
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          closeInput();
        }}
      />
      <button type="submit" className="skin-companion-send" aria-label={t('Send message')} disabled={!draft.trim()}>
        <ArrowUp size={14} aria-hidden="true" />
      </button>
    </form>
  );
}

export function CompanionPet({
  face,
  name = '',
  bubble,
  collapsed,
  canSend,
  movable = true,
  onOpen,
  onSend,
  onDismiss,
  onMenu,
  onDrag,
  onNudge,
  onReset,
  onInputFocus,
  blurSignal,
  paused = false,
  quiet = false,
  autoAdvance = true,
  autoClose = true,
  onRead,
  onCopy,
  measurePages = measureReplyPages,
  bubbleSpan,
}: CompanionPetProps) {
  // The widest the bubble may be: its span less both margins.
  const bubbleMax = bubbleSpan ? Math.max(0, Math.round(bubbleSpan.right - bubbleSpan.left - 2 * BUBBLE_EDGE)) : 0;
  const mascotRef = useRef<HTMLButtonElement | null>(null);
  const { dragging, suppressClickRef, onPointerDown } = useMascotDrag(movable, onDrag);
  const [hovered, setHovered] = useState(false);
  /** Keyboard focus is in the bubble: held like a hover. */
  const [focusWithin, setFocusWithin] = useState(false);
  const replyKey = bubble.kind === 'reply' ? bubble.key : '';
  const replyText = bubble.kind === 'reply' ? bubble.text : '';
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const replyKeyRef = useRef(replyKey);
  replyKeyRef.current = replyKey;
  const quick = useQuickMessage({
    canSend,
    quiet,
    blurSignal,
    onSend,
    onInputFocus,
    onDismissRef,
    replyKeyRef,
    mascotRef,
  });
  const { quickInput } = quick;

  // A long reply's pages: their time runs only while the bubble shows and
  // neither the pointer nor focus is on it.
  const pagesHeld = collapsed || quiet || paused || hovered || focusWithin;
  const reading = useReplyPaging(replyKey, replyText, pagesHeld, autoAdvance, measurePages, bubbleMax);
  // A reply hides by itself after a length-based time (a long one once its
  // last page's time ran out, timed by that page), held while the pointer or
  // keyboard focus is on it, the quick message is open, or nothing shows
  // it; never with "close automatically" off. The symbols (working,
  // approval) never time out.
  const held = collapsed || quickInput || hovered || focusWithin || paused || !reading.lastDone || !autoClose;
  const fading = useReplyFade(replyKey, reading.lastText, held, onDismissRef);
  // A bubble that went away under the pointer or focus never sees its leave.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset per reply
  useEffect(() => {
    setHovered(false);
    setFocusWithin(false);
  }, [replyKey]);
  const closeReply = useCallback(() => {
    if (replyKeyRef.current) onDismissRef.current(replyKeyRef.current);
  }, []);
  // Read once its end was on screen: the app counts the chat read too. A
  // long reply closed before its last page stays unread.
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  const readKeyRef = useRef('');
  const readToEnd = Boolean(replyKey) && !collapsed && !quiet && !paused && reading.atEnd;
  useEffect(() => {
    if (!readToEnd || readKeyRef.current === replyKey) return;
    readKeyRef.current = replyKey;
    onReadRef.current?.(replyKey);
  }, [readToEnd, replyKey]);

  const onMascotClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Enter/Space (detail 0) always toggles; a pointer click that ended a drag does not.
    if (suppressClickRef.current && event.detail > 0) {
      suppressClickRef.current = false;
      return;
    }
    suppressClickRef.current = false;
    notePetOpenedBy(event.detail === 0);
    if (quiet) onOpen();
    else if (canSend) quick.toggle();
  };

  const onMascotKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (isContextMenuKey(event)) {
      event.preventDefault();
      notePetOpenedBy(true);
      onMenu();
      return;
    }
    const step = event.shiftKey ? NUDGE_FAR : NUDGE;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = delta[event.key];
    if (!move || !movable) return;
    event.preventDefault();
    onNudge(move[0], move[1]);
  };

  const label = bubbleLabel(bubble);
  const idle = bubble.kind === 'idle';
  return (
    <div
      className="skin-companion"
      data-quick={quickInput ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      data-pinned={movable ? undefined : 'true'}
      // Idle: no bubble; the pet itself breathes and blinks (CSS).
      data-idle={idle && !quickInput && !dragging ? 'true' : undefined}
      data-paused={paused ? 'true' : undefined}
      // The bubble's width cap, shared with the hidden copy pages are measured in.
      style={bubbleMax ? ({ '--bubble-max': `${bubbleMax}px` } as CSSProperties) : undefined}
    >
      <div className="skin-companion-stack">
        <div className="skin-companion-balloon">
          <div className="skin-companion-status" role="status" aria-live="polite">
            <span className="sr-only">{label}</span>
            {!collapsed && !idle && !quiet && (
              <CompanionBubbleView
                bubble={bubble}
                name={name}
                fading={fading}
                held={pagesHeld}
                paging={reading.paging}
                timed={autoAdvance}
                onMeasured={reading.onMeasured}
                onCopy={() => onCopy?.(replyKey)}
                onClose={closeReply}
                setHovered={setHovered}
                setFocusWithin={setFocusWithin}
                span={bubbleSpan}
              />
            )}
          </div>
        </div>
        <button
          ref={mascotRef}
          type="button"
          className="skin-companion-pet"
          data-pet-hit=""
          aria-label={t(
            'Representative bot overlay. Click or press Enter for a quick message; right-click or Shift+F10 for options; drag or use the arrow keys to move it.'
          )}
          aria-haspopup="menu"
          aria-expanded={canSend && !quiet ? quickInput : undefined}
          onPointerDown={onPointerDown}
          onClick={onMascotClick}
          onContextMenu={(event) => {
            event.preventDefault();
            // The ContextMenu key fires this too, without a pointer (button -1 / no coordinates).
            notePetOpenedBy(event.button !== 2);
            onMenu();
          }}
          onDoubleClick={onReset}
          onKeyDown={onMascotKeyDown}
        >
          {face}
        </button>
      </div>
      <QuickMessageForm quick={quick} span={bubbleSpan} />
    </div>
  );
}
