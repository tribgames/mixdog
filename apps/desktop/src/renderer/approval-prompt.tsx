// The one approval surface (design/mockups/approval-buttons): content centred
// and decided with buttons. The requester's face with the "needs you" dot, a
// one-line question, who asks (chain, service, a link to a sub-agent's
// session), the preview box, an optional reason, then one row of equal
// buttons exactly as wide as the preview and the scope line under it. Deny
// ends the request in one click (onDeny with no reason).
// Keys follow question-card-keys.ts: Esc denies, Enter allows
// only where the card says so; never while typing, never right after a card
// appears or another one was decided.
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
import { bindCardKeys, isTypingTarget } from './question-card-keys';
import { useSidebarReferences } from './sidebar-reference-cache';

/** Opens a sub-agent's session from the card ("세션 열기"); provided by the dock. */
export const ApprovalOpenSessionContext = createContext<((sessionId: string) => void) | null>(null);

// A key that answered one card must not answer the next queued one: a card
// takes no key for a moment after it appears or after any card decided.
const KEY_SETTLE_MS = 400;
let lastDecisionAt = 0;
export const noteApprovalDecision = () => {
  lastDecisionAt = Date.now();
};

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
  /** primary: the blue allow; danger: a payment or permanent delete's allow. */
  tone?: 'primary' | 'danger';
  /** deny: Esc's button; with `onDeny` a press denies at once, with no reason. */
  deny?: boolean;
  disabled?: boolean;
  /** Its tooltip and accessible description (what "Always allow" changes,
   *  why a click is required); the label otherwise. */
  hint?: string;
  onClick?: () => void;
}

export interface ApprovalPromptProps {
  /** The question ("이 메일을 보낼까요?"). */
  title: string;
  /** The requesting bot ('' = the coding session's Lead). */
  faceAgentId: string;
  tone?: 'need' | 'danger' | 'done';
  /** "사무관 › Worker", the bot's name, or Lead. */
  requester: string;
  /** The tool or service ("Gmail", "Browser"). */
  service?: string;
  /** The raw tool id behind a friendly service name (its tooltip). */
  serviceTitle?: string;
  /** A sub-agent's own session: the "세션 열기" link. */
  sessionLink?: { sessionId: string; label: string } | null;
  /** "1/2" when more requests wait. */
  queue?: string;
  /** The timer's end ("0:28 남음"), or a fixed corner text. */
  expiresAt?: number;
  corner?: string;
  preview?: ReactNode;
  /** Left to right; the stacked phone layout puts the primary first. */
  buttons: ApprovalButton[];
  /** Which button takes focus: the allow, or deny for anything risky. */
  focus: 'deny' | 'primary';
  /** Enter allows (the primary); false for danger and unconfirmed targets. */
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
  data?: Record<`data-${string}`, string | undefined>;
  children?: ReactNode;
}

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

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

const phoneSurface = () => document.documentElement.hasAttribute('data-mixdog-mobile-tabs');

/** Phone: a composer holding no unsent text gives up focus (and the soft
 *  keyboard), so the card has the screen; that includes the moment right
 *  after Send, when a tool call usually lands. A draft keeps the caret. */
export function releaseIdleComposer(): void {
  const active = document.activeElement;
  if (!phoneSurface() || !(active instanceof HTMLElement) || !active.closest('.composer-input-row')) return;
  const draft =
    active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? active.value : active.textContent;
  if (draft?.trim()) return;
  active.blur();
}

export function ApprovalPrompt(props: ApprovalPromptProps) {
  const {
    title,
    faceAgentId,
    tone = 'need',
    requester,
    service,
    serviceTitle,
    sessionLink,
    queue,
    expiresAt,
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
    data,
    children,
  } = props;
  const titleId = useId();
  const ref = useRef<HTMLElement | null>(null);
  const mountedAt = useRef(Date.now());
  const now = useNow(Boolean(expiresAt) && !status);
  const openSession = useOpenSession();
  const decided = Boolean(status);
  const primaryIndex = buttons.findIndex((button) => button.tone);
  const denyIndex = buttons.findIndex((button) => button.deny);
  const initialIndex = focus === 'deny' && denyIndex >= 0 ? denyIndex : primaryIndex;

  const press = (button: ApprovalButton) => {
    if (button.disabled || busy) return;
    if (button.deny && onDeny) return sendDeny();
    button.onClick?.();
  };
  const sendDeny = () => {
    if (busy) return;
    noteApprovalDecision();
    onDeny?.('');
  };
  const live = useRef({ press, buttons, primaryIndex, denyIndex, enterAllows, onClose });
  live.current = { press, buttons, primaryIndex, denyIndex, enterAllows, onClose };

  // The designated button takes focus when nothing else holds it (a person
  // typing in the composer keeps the caret).
  useEffect(() => {
    const node = ref.current;
    if (!node || decided) return;
    releaseIdleComposer();
    if (!idle() && !node.contains(document.activeElement)) return;
    const target = node.querySelector<HTMLElement>('[data-initial]') ?? node;
    target.focus({ preventScroll: true });
    node.scrollIntoView?.({ block: 'nearest' });
  }, [decided]);

  useEffect(() => {
    const node = ref.current;
    if (!node || decided) return;
    return bindCardKeys(node, (event) => {
      if (isTypingTarget(event.target)) return;
      const target = event.target instanceof Node ? event.target : null;
      const inside = Boolean(target && node.contains(target));
      // Enter / Esc belong to the card only while focus is inside it; a card
      // that appears while someone types elsewhere takes no key until focused.
      if (!inside) return;
      const state = live.current;
      const settling = Date.now() - Math.max(mountedAt.current, lastDecisionAt) < KEY_SETTLE_MS;
      const handled = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (event.key === 'Escape') {
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
  }, [decided]);

  const left = expiresAt && !status ? t('{{left}} left', { left: clock(expiresAt - now) }) : '';
  const columns = buttons.length > 3 ? 1 : buttons.length;
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
      aria-busy={busy || undefined}
      {...data}
    >
      <div className="approval-prompt-top">
        <span className="approval-queue">{queue}</span>
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
        {service && (
          <span className="approval-service" title={serviceTitle}>
            {service}
          </span>
        )}
        {sessionLink && openSession && (
          <button type="button" className="approval-link" onClick={() => openSession(sessionLink.sessionId)}>
            {sessionLink.label}
          </button>
        )}
      </div>
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
              style={{ '--approval-columns': columns } as CSSProperties}
            >
              {buttons.map((button, index) => {
                const shortcut = button.deny && !onClose ? 'Esc' : index === primaryIndex && enterAllows ? 'Enter' : '';
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
                    data-initial={index === initialIndex || undefined}
                    disabled={busy || button.disabled}
                    title={button.hint || button.label}
                    aria-describedby={button.hint ? `${titleId}-hint-${index}` : undefined}
                    aria-keyshortcuts={shortcut === 'Esc' ? 'Escape' : shortcut || undefined}
                    data-pointer-only={pointerOnly || undefined}
                    onKeyDown={blockKey}
                    // Space clicks as its keyup's default action.
                    onKeyUp={blockKey}
                    onClick={() => {
                      // sendDeny notes a deny itself.
                      if (!button.deny || !onDeny) noteApprovalDecision();
                      press(button);
                    }}
                  >
                    <span className="approval-button-label">{button.label}</span>
                    {shortcut && <kbd className="approval-kbd">{shortcut}</kbd>}
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

/** The dock's opener; off the dock (a floating or held card) the app's
 *  task-session opener. */
function useOpenSession(): (sessionId: string) => void {
  return (
    useContext(ApprovalOpenSessionContext) ??
    ((sessionId: string) => window.dispatchEvent(new CustomEvent(OPEN_TASK_SESSION_EVENT, { detail: { sessionId } })))
  );
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
