// The one approval surface (design/mockups/approval-buttons): content centred
// and decided with buttons. The requester's face with the "needs you" dot, a
// one-line question, who asks (chain, service, a link to a sub-agent's
// session), the preview box, an optional reason, then one row of equal
// buttons exactly as wide as the preview and the scope line under it. Deny
// ends the request in one click (onDeny with no reason).
// Keys follow question-card-keys.ts: Esc denies, Enter allows
// only where the card says so; never while typing, never right after a card
// appears or another one was decided. They answer while focus is anywhere in
// the card's own conversation on something that is neither a typing target nor
// a control with keys of its own (a button, a link), or nowhere; the chips
// (data-keys) show on exactly that condition.
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { type AgentAvatarValue, agentAvatar } from '../../../../src/runtime/shared/agent-avatar.mjs';
import { isContactAgentRow, MIXY_AGENT_ID } from '../shared/agent-contacts';
import { AgentAvatar } from './agent-avatar';
import { useLeadAvatar } from './lead-avatar-store';
import { OPEN_TASK_SESSION_EVENT } from './agent-task-events';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { mixyAvatar } from './mixy-identity';
import { bindCardKeys, cardKeysChanged, isTypingTarget, ownsKeyboard, watchCardKeyOwner } from './question-card-keys';
import { useSidebarReferences } from './sidebar-reference-cache';
import { touchPrimaryPointer } from './surface-input-focus';
import { isComposerComposing } from './use-composer-ime';

/** Opens a sub-agent's session from the card ("세션 열기"); provided by the dock. */
export const ApprovalOpenSessionContext = createContext<((sessionId: string) => void) | null>(null);

// A key that answered one card must not answer the next queued one: a card
// takes no key for a moment after it appears or after any card decided.
const KEY_SETTLE_MS = 400;
let lastDecisionAt = 0;
export const noteApprovalDecision = () => {
  lastDecisionAt = Date.now();
  // Every other card settles again: its chips go off for the window.
  cardKeysChanged();
};
/** Milliseconds left of a card's settling since it mounted at `mountedAt`. */
const settleLeft = (mountedAt: number) =>
  Math.max(0, KEY_SETTLE_MS - (Date.now() - Math.max(mountedAt, lastDecisionAt)));

// The asking sessions whose request is docked as a card right now, per chat:
// a task session's "waiting for approval" line in that chat gives way to it.
const dockedBySurface = new Map<string, string>();
const dockedListeners = new Set<() => void>();
const subscribeDocked = (listener: () => void) => {
  dockedListeners.add(listener);
  return () => {
    dockedListeners.delete(listener);
  };
};

/** Record which session's request `surfaceSessionId`'s dock shows ('' = none). */
export function publishDockedApproval(surfaceSessionId: string, askingSessionId: string): void {
  if ((dockedBySurface.get(surfaceSessionId) ?? '') === askingSessionId) return;
  if (askingSessionId) dockedBySurface.set(surfaceSessionId, askingSessionId);
  else dockedBySurface.delete(surfaceSessionId);
  for (const listener of dockedListeners) listener();
}

/** Whether a docked card currently asks for `sessionId`. */
export function useApprovalDockedFor(sessionId: string): boolean {
  return useSyncExternalStore(
    subscribeDocked,
    () => Boolean(sessionId) && [...dockedBySurface.values()].includes(sessionId),
    () => false
  );
}

const AGENT_KEYS = ['agents'] as const;

/** A face as its catalog row stores it for a bot (Mixy's from its identity);
 *  every other agent (a role, a Workflows agent) wears the shared Lead face. */
export function useAgentFace(agentId: string): AgentAvatarValue {
  const api = typeof window === 'undefined' ? undefined : window.mixdogDesktop;
  const { values } = useSidebarReferences(api, AGENT_KEYS, Boolean(agentId) && agentId !== MIXY_AGENT_ID);
  const lead = useLeadAvatar();
  if (agentId === MIXY_AGENT_ID) return agentAvatar(MIXY_AGENT_ID, mixyAvatar());
  const row = Array.isArray(values.agents)
    ? (values.agents as Array<{ id?: unknown; avatar?: unknown; kind?: unknown }>).find(
        (entry) => entry?.id === agentId
      )
    : undefined;
  if (row && !isContactAgentRow(row)) return lead;
  return agentAvatar(agentId, row?.avatar);
}

/** The requester's face: a bot's own avatar, or the LEAD mark of a coding session. */
export function ApprovalFace({ agentId }: { agentId: string }) {
  const avatar = useAgentFace(agentId);
  // The mark is drawn by CSS (a brand label, not translated text).
  if (!agentId) return <span className="approval-lead-mark" aria-hidden="true" />;
  return <AgentAvatar agentId={agentId} avatar={avatar} className="approval-face-avatar" />;
}

export interface ApprovalButton {
  label: string;
  /** primary: the blue allow. */
  tone?: 'primary';
  /** deny: Esc's button; with `onDeny` a press denies at once, with no reason. */
  deny?: boolean;
  disabled?: boolean;
  /** "Always allow": never the initial focus and never the card's own Enter;
   *  pressed only by a click, or Enter / Space on it once focused on purpose. */
  always?: boolean;
  /** Its tooltip and accessible description (what "Always allow" changes,
   *  why a click is required); the label otherwise. */
  hint?: string;
  /** Its own full-width row above the others (a takeover's "Open"). */
  wide?: boolean;
  onClick?: () => void;
}

export interface ApprovalPromptProps {
  /** The question ("이 메일을 보낼까요?"). */
  title: string;
  /** The requesting bot ('' = the coding session's Lead). */
  faceAgentId: string;
  tone?: 'need' | 'done';
  /** "사무관 › Worker", the bot's name, or Lead. */
  requester: string;
  /** The tool or service ("Gmail", "Browser"). */
  service?: string;
  /** The raw tool id behind a friendly service name (its tooltip). */
  serviceTitle?: string;
  /** A session this chat handed work to whose request this is: the amber
   *  chip beside the requester ("▣ {title}", or a bot's face and name). */
  target?: { name: string; agentId?: string } | null;
  /** A sub-agent's own session: the "세션 열기" link. `handoff`: a session
   *  this chat handed work to, opened as any session is (not as a sub-agent). */
  sessionLink?: { sessionId: string; label: string; handoff?: boolean } | null;
  /** "1/2" when more requests wait (the dock: "1/N" for another session's too). */
  queue?: string;
  /** The timer's end ("0:28 남음"), or a fixed corner text. */
  expiresAt?: number;
  /** When the request lapses: the top-left "15분 안에" (in place of the queue). */
  deadline?: number;
  corner?: string;
  preview?: ReactNode;
  /** Left to right; the stacked phone layout puts the primary first. */
  buttons: ApprovalButton[];
  /** Which button takes focus: the allow, or deny for anything risky. */
  focus: 'deny' | 'primary';
  /** Enter allows (the primary); false for payment, delete, an Office rollback or
   *  recovery discard (shared/approval-enter-rule.ts) and unconfirmed targets. */
  enterAllows: boolean;
  /** Deny the request; the card always passes '' (no reason). */
  onDeny?: (reason: string) => void;
  /** "Decide later" (✕ and Esc) instead of Esc denying. */
  onClose?: () => void;
  /** Replaces the buttons: how it ended ("Allowed from Pixel"). */
  status?: string;
  error?: string;
  busy?: boolean;
  kind?: string;
  agentMode?: boolean;
  /** false: no Enter / Esc chips on the buttons (the keys still answer). */
  keyChips?: boolean;
  data?: Record<`data-${string}`, string | undefined>;
  children?: ReactNode;
}

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** "15분 안에": the time a request has left, in whole minutes (seconds in the last one). */
export function deadlineText(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return t('Within {{n}} s', { n: seconds });
  return t('Within {{n}} min', { n: Math.ceil(seconds / 60) });
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

const idle = () => {
  const active = document.activeElement;
  return !active || active === document.body;
};

// Anything with key semantics of its own is not the card's. This fails closed
// in two ways: (1) the focused element, or any ancestor of it, is a control or
// a keyboard-owning widget/surface from the list below (native controls, the
// ARIA widget and composite roles, an element driving an active descendant, a
// contenteditable, embedded documents and the editor / terminal hosts), and
// (2) the focused element or any ancestor of it within the card's pane that
// declares an ARIA role outside PASSIVE_ROLES is treated as a widget, so a
// role the list does not know about (an `application`, say) still wins over
// the card. What is left is the transcript's role="log" scroller, regions,
// row containers and the pane background. A role-less tabindex div with its own
// onKeyDown cannot be told from a scroller; the app has none in a conversation.
const OWN_KEY_CONTROLS = [
  'button',
  'a[href]',
  'summary',
  'select',
  'input',
  'textarea',
  'iframe',
  'webview',
  'embed',
  'object',
  'video[controls]',
  'audio[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[aria-activedescendant]',
  '.monaco-editor',
  '.xterm',
  '[role="button"]',
  '[role="link"]',
  '[role^="menu"]',
  '[role="tab"]',
  '[role="tablist"]',
  '[role="tree"]',
  '[role="treeitem"]',
  '[role="treegrid"]',
  '[role="grid"]',
  '[role="gridcell"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="combobox"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="radio"]',
  '[role="radiogroup"]',
  '[role="toolbar"]',
  '[role="spinbutton"]',
  '[role="slider"]',
  '[role="scrollbar"]',
  '[role="textbox"]',
  '[role="searchbox"]',
].join(',');
const PASSIVE_ROLES = new Set([
  'log',
  'region',
  'article',
  'group',
  'document',
  'list',
  'listitem',
  'presentation',
  'none',
  'status',
  'feed',
  'main',
  'complementary',
  'generic',
  'figure',
  // Roles the conversation itself renders around its rows.
  'alert',
  'img',
  'tooltip',
  'note',
  'heading',
  'paragraph',
  'tabpanel',
]);
/** `active` or an ancestor up to `scope` (the card's pane) has key semantics of its own. */
const ownsItsKeys = (active: Element, scope: Element): boolean => {
  if (active.closest(OWN_KEY_CONTROLS)) return true;
  for (let node: Element | null = active; node; node = node === scope ? null : node.parentElement) {
    const role = node.getAttribute('role')?.trim().split(/\s+/)[0];
    if (role && !PASSIVE_ROLES.has(role)) return true;
  }
  return false;
};

/** Where focus lets the card answer Enter / Esc: nowhere (`active` null or the
 *  body), anywhere in the card (a typing target aside), or in the card's own
 *  conversation (the enclosing `.conversation`; the card itself when it sits
 *  in none) on something that is neither a typing target nor a control of its
 *  own (a button or link there keeps its Enter). Focus in another pane, the
 *  sidebar or settings, or in the composer, is not. */
function keysOpen(card: HTMLElement, active: Element | null): boolean {
  if (!active || active === document.body) return true;
  if (isTypingTarget(active)) return false;
  if (card.contains(active)) return true;
  const scope = card.closest('.conversation') ?? card;
  return scope.contains(active) && !ownsItsKeys(active, scope);
}

const phoneSurface = () => document.documentElement.hasAttribute('data-mixdog-mobile-tabs');

/** A composer holding no unsent text gives up focus, so the card takes it and
 *  its Enter / Esc answer (and show their chips); that includes the moment
 *  right after Send, when a tool call usually lands. On a phone it also
 *  closes the soft keyboard. A draft keeps the caret (Enter sends it).
 *  Only the composer of the card's own conversation (`scope`, the enclosing
 *  `.conversation`): a card in another pane leaves the typing pane alone.
 *  Returns the released composer so the card can hand focus back. */
export function releaseIdleComposer(scope: Element | null): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !scope?.contains(active) || !active.closest('.composer-input-row')) {
    return null;
  }
  const draft =
    active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? active.value : active.textContent;
  if (draft?.trim() || isComposerComposing(active)) return null;
  active.blur();
  return active;
}

export function ApprovalPrompt(props: ApprovalPromptProps) {
  const {
    title,
    faceAgentId,
    tone = 'need',
    requester,
    target,
    service,
    serviceTitle,
    sessionLink,
    queue,
    expiresAt,
    deadline,
    corner,
    preview,
    buttons,
    focus,
    enterAllows,
    onDeny,
    onClose,
    status,
    error,
    busy = false,
    kind,
    agentMode = false,
    keyChips = true,
    data,
    children,
  } = props;
  const titleId = useId();
  const ref = useRef<HTMLElement | null>(null);
  const mountedAt = useRef(Date.now());
  const now = useNow(Boolean(expiresAt || deadline) && !status);
  const openSession = useOpenSession();
  const decided = Boolean(status);
  const primaryIndex = buttons.findIndex((button) => button.tone);
  const denyIndex = buttons.findIndex((button) => button.deny);
  const primaryIsAlways = Boolean(buttons[primaryIndex]?.always);
  const initialIndex = (focus === 'deny' || primaryIsAlways) && denyIndex >= 0 ? denyIndex : primaryIndex;

  // The one dispatch path of an accepted decision (click, pane Enter, Esc):
  // it restarts every other card's settle window before the answer goes out.
  const press = (button: ApprovalButton) => {
    if (button.disabled || busy) return;
    noteApprovalDecision();
    if (button.deny && onDeny) return onDeny('');
    button.onClick?.();
  };
  const enterPresses = enterAllows && !primaryIsAlways;
  const live = useRef({ press, buttons, primaryIndex, denyIndex, enterAllows: enterPresses, onClose });
  live.current = { press, buttons, primaryIndex, denyIndex, enterAllows: enterPresses, onClose };

  // The designated button takes focus when nothing else holds it (a person
  // typing in the composer keeps the caret; an empty composer lets go). Once
  // the card is decided or gone, an idle focus (or one left inside the card)
  // goes back to the composer it was taken from, so typing goes on. Not on a
  // phone or touch screen: that would raise the keyboard.
  useEffect(() => {
    const node = ref.current;
    if (!node || decided) return;
    const released = releaseIdleComposer(node.closest('.conversation'));
    const giveBack = () => {
      if (!released?.isConnected || phoneSurface() || touchPrimaryPointer()) return;
      if (!idle() && !node.contains(document.activeElement)) return;
      released.focus({ preventScroll: true });
    };
    if (!idle() && !node.contains(document.activeElement)) return;
    const target = node.querySelector<HTMLElement>('[data-initial]') ?? node;
    target.focus({ preventScroll: true });
    node.scrollIntoView?.({ block: 'nearest' });
    return giveBack;
  }, [decided]);

  // Whether Enter / Esc answer this card right now; the chips show on exactly
  // this (`data-keys`), both read from `keysOpen`.
  const [keys, setKeys] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || decided) return;
    let settleEnd = 0;
    // The chips follow exactly what the handler below answers: not while the
    // card settles (re-evaluated when that ends), not with the window blurred,
    // focus elsewhere, a modal open or another card owning the pane's keys.
    const refresh = (active: Element | null = document.activeElement) => {
      const wait = settleLeft(mountedAt.current);
      window.clearTimeout(settleEnd);
      if (wait > 0) settleEnd = window.setTimeout(() => refresh(), wait);
      setKeys(wait === 0 && document.hasFocus() && keysOpen(node, active) && ownsKeyboard(node, active));
    };
    const unbind = bindCardKeys(node, (event) => {
      if (isTypingTarget(event.target)) return;
      const target = event.target instanceof Node ? event.target : null;
      const inside = Boolean(target && node.contains(target));
      // Enter / Esc belong to the card while focus is in its conversation on
      // something that is not a typing target, or nowhere (see keysOpen); a
      // card that appears while someone types takes no key until then. Of
      // several cards in one pane only the newest hears the key (bindCardKeys).
      // A window without focus answers nothing (the chips are off then too).
      if (!document.hasFocus() || !keysOpen(node, document.activeElement)) return;
      const state = live.current;
      const settling = settleLeft(mountedAt.current) > 0;
      const handled = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (event.key === 'Escape') {
        // Like Enter, a key meant for the previous card never lands here.
        if (settling) return handled();
        handled();
        if (state.onClose) state.onClose();
        else if (state.denyIndex >= 0) state.press(state.buttons[state.denyIndex]);
        return;
      }
      if (event.key !== 'Enter') return;
      // A focused button answers Enter itself (native activation), except in
      // the first moment, so a key meant for the previous card never lands here.
      const control = event.target instanceof Element && event.target.closest('button, a');
      if (settling) return handled();
      if (control && inside) return;
      if (!state.enterAllows || state.primaryIndex < 0) return;
      handled();
      state.press(state.buttons[state.primaryIndex]);
    });
    const onFocusIn = () => refresh();
    // During focusout the focus is already gone; the element it goes to is the
    // relatedTarget (none: nothing holds focus).
    // A removed focused element ends in a focusout too (no relatedTarget); the
    // deferred pass reads where focus really settled.
    let settleTimer = 0;
    const onFocusOut = (event: FocusEvent) => {
      refresh(event.relatedTarget instanceof Element ? event.relatedTarget : null);
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => refresh(), 0);
    };
    const onWindowBlur = () => refresh();
    const onWindowFocus = () => refresh();
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('focus', onWindowFocus);
    const unwatch = watchCardKeyOwner(refresh);
    refresh();
    return () => {
      unwatch();
      window.clearTimeout(settleTimer);
      window.clearTimeout(settleEnd);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('focus', onWindowFocus);
      unbind();
    };
  }, [decided]);

  const left = expiresAt && !status ? t('{{left}} left', { left: clock(expiresAt - now) }) : '';
  // A wide button takes its own row; the others share the row below it.
  const lead = buttons.some((button) => button.wide);
  const rowCount = buttons.filter((button) => !button.wide).length;
  const columns = rowCount > 3 ? 1 : Math.max(1, rowCount);
  return (
    <section
      ref={ref}
      tabIndex={-1}
      className="approval-prompt"
      role="alertdialog"
      aria-labelledby={titleId}
      data-tone={decided ? 'done' : tone}
      data-approval={kind}
      data-agent-mode={agentMode || undefined}
      data-settled={decided || undefined}
      data-keys={(keys && !decided) || undefined}
      aria-busy={busy || undefined}
      {...data}
    >
      <div className="approval-prompt-top">
        <span className="approval-queue">{queue || (deadline && !status ? deadlineText(deadline - now) : '')}</span>
        <span className="approval-corner">{corner ?? left}</span>
        {onClose && !decided && (
          <button
            type="button"
            className="approval-close"
            aria-label={t('Decide later')}
            title={t('Decide later')}
            onClick={onClose}
          >
            ✕
          </button>
        )}
      </div>
      <div className="approval-face">
        <ApprovalFace agentId={faceAgentId} />
        <span className="approval-need-dot" aria-hidden="true" />
      </div>
      <h3 id={titleId} className="approval-title">
        {title}
      </h3>
      {(requester || target || service || sessionLink) && (
        <div className="approval-who">
          {requester && (
            <span className="approval-chip" title={requester}>
              {faceAgentId && (
                <span className="approval-chip-face" aria-hidden="true">
                  <ApprovalFace agentId={faceAgentId} />
                </span>
              )}
              <span className="approval-chip-name">{requester}</span>
            </span>
          )}
          {target && (
            <span className="approval-chip approval-target-chip" title={target.name}>
              {target.agentId ? (
                <span className="approval-chip-face" aria-hidden="true">
                  <ApprovalFace agentId={target.agentId} />
                </span>
              ) : (
                <span className="approval-target-mark" aria-hidden="true">
                  ▣
                </span>
              )}
              <span className="approval-chip-name">{target.name}</span>
            </span>
          )}
          {service && (
            <span className="approval-service" title={serviceTitle}>
              {service}
            </span>
          )}
          {sessionLink && (
            <button
              type="button"
              className="approval-link"
              onClick={() => (sessionLink.handoff ? openAnySession : openSession)(sessionLink.sessionId)}
            >
              {sessionLink.label}
            </button>
          )}
        </div>
      )}
      {preview && <div className="approval-preview">{preview}</div>}
      {children}
      {error && <ErrorNotice error={error} />}
      {status ? (
        <p className="approval-status" role="status">
          {status}
        </p>
      ) : (
        <>
          {buttons.length > 0 && (
            <div
              className="approval-buttons"
              data-count={String(columns === 1 && buttons.length > 1 ? 'many' : buttons.length)}
              data-lead={lead || undefined}
              style={{ '--approval-columns': columns } as CSSProperties}
            >
              {buttons.map((button, index) => {
                const shortcut = button.deny && !onClose ? 'Esc' : index === primaryIndex && enterPresses ? 'Enter' : '';
                const chip = keyChips ? shortcut : '';
                // Where Enter does not allow (payment, permanent delete, an
                // unconfirmed receiver, a file from outside the project), an
                // allow is never activated by Enter or Space on the focused
                // button: those keys are cancelled, so the browser never makes
                // their click. A pointer, touch, pen or assistive-tech click allows.
                const pointerOnly = !enterAllows && !button.deny;
                const blockKey = (event: KeyboardEvent<HTMLButtonElement>) => {
                  if (pointerOnly && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
                };
                return (
                  <button
                    // biome-ignore lint/suspicious/noArrayIndexKey: buttons are positional and never reorder
                    key={index}
                    type="button"
                    className="approval-button"
                    data-tone={button.tone}
                    data-deny={button.deny || undefined}
                    data-wide={button.wide || undefined}
                    data-initial={index === initialIndex || undefined}
                    disabled={busy || button.disabled}
                    title={button.hint || button.label}
                    aria-describedby={button.hint ? `${titleId}-hint-${index}` : undefined}
                    aria-keyshortcuts={shortcut === 'Esc' ? 'Escape' : shortcut || undefined}
                    data-pointer-only={pointerOnly || undefined}
                    onKeyDown={blockKey}
                    // Space clicks as its keyup's default action.
                    onKeyUp={blockKey}
                    onClick={() => press(button)}
                  >
                    <span className="approval-button-label">{button.label}</span>
                    {chip && <kbd className="approval-kbd">{chip}</kbd>}
                  </button>
                );
              })}
            </div>
          )}
          {/* The hints as accessible descriptions only; never drawn. */}
          {buttons.map((button, index) =>
            button.hint ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: buttons are positional and never reorder
              <span key={index} id={`${titleId}-hint-${index}`} hidden>
                {button.hint}
              </span>
            ) : null
          )}
        </>
      )}
    </section>
  );
}

/** The app's task-session opener: opens any session by id. */
const openAnySession = (sessionId: string) =>
  window.dispatchEvent(new CustomEvent(OPEN_TASK_SESSION_EVENT, { detail: { sessionId } }));

/** The dock's opener; off the dock (a floating or held card) the app's
 *  task-session opener. */
function useOpenSession(): (sessionId: string) => void {
  return useContext(ApprovalOpenSessionContext) ?? openAnySession;
}

/** One preview row: a pixel icon, the main line and an optional sub line. */
export function ApprovalPreviewRow({
  icon,
  main,
  sub,
  warn = false,
}: {
  icon: ReactNode;
  main: ReactNode;
  sub?: ReactNode;
  warn?: boolean;
}) {
  return (
    <div className="approval-preview-row" data-warn={warn || undefined}>
      {icon}
      <span className="approval-preview-text">
        <span className="approval-preview-main">{main}</span>
        {sub ? <small>{sub}</small> : null}
      </span>
    </div>
  );
}
