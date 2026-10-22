import { useEffect, useSyncExternalStore } from 'react';
import { actionLabel, actionQuestion, alwaysAllowScope } from './ApprovalCard';
import { type ApprovalButton, ApprovalPrompt } from './approval-prompt';
import { showDesktopToast } from './desktop-toasts';
import { t } from './i18n';
import { PixelIcon } from './pixel-icon';

export type BrowserApprovalPrompt = {
  id: string;
  action: string;
  url: string;
  sessionId: string;
  /** The top-level chat the card docks in (a sub-agent's root chat); the
   *  asking session itself when absent. */
  surfaceSessionId?: string;
  /** The bot whose face the card shows ('' = a coding session's Lead). */
  agentId?: string;
  requester: string;
  target: string;
  paths: string[];
  origin?: string;
  receiverOrigin?: string;
  files?: Array<{ name: string; path: string; size: number; outside: boolean }>;
  /** Absent: the card waits until the person answers (no countdown). */
  expiresAt?: number;
  remember: { kinds: string[] } | null;
};

/** The store action a kind of gated step is allowed under (see main/browser/approval-dialog.ts). */
const KIND_ACTION: Record<string, string> = {
  submit: 'browser_submit',
  post: 'browser_post',
  upload: 'browser_upload',
};

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What "Always allow" would change, in the card's own words. */
export function alwaysAllowNote(requester: string, kinds: string[]): string {
  return alwaysAllowScope(requester, kinds.map((kind) => actionLabel(KIND_ACTION[kind] ?? kind)).join(', '));
}

// The waiting browser approvals, oldest first, and which chats dock them: a
// conversation showing a prompt's top-level chat claims it; an unclaimed one
// floats above the app so it is never missed.
let queue: BrowserApprovalPrompt[] = [];
const claims = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => {
  version += 1;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const surfaceOf = (prompt: BrowserApprovalPrompt) => prompt.surfaceSessionId || prompt.sessionId;
const drop = (id: string) => {
  const next = queue.filter((entry) => entry.id !== id);
  if (next.length === queue.length) return;
  queue = next;
  notify();
};

function useStoreVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version
  );
}

/** The browser approvals docked in `sessionId`'s chat (claimed while mounted). */
export function useBrowserApprovals(sessionId: string): BrowserApprovalPrompt[] {
  useStoreVersion();
  useEffect(() => {
    if (!sessionId) return;
    claims.set(sessionId, (claims.get(sessionId) ?? 0) + 1);
    notify();
    return () => {
      const left = (claims.get(sessionId) ?? 1) - 1;
      if (left > 0) claims.set(sessionId, left);
      else claims.delete(sessionId);
      notify();
    };
  }, [sessionId]);
  return sessionId ? queue.filter((prompt) => surfaceOf(prompt) === sessionId) : [];
}

function answer(prompt: BrowserApprovalPrompt, decision: 'once' | 'always' | 'deny', reason = '') {
  drop(prompt.id);
  void window.mixdogDesktop?.browserApprovalDecide?.(prompt.id, decision, reason || undefined);
}

/** A Browser Use submit, post or upload as the approval card: allow once,
 *  allow always (this bot, these kinds of step; undone in the bot's profile),
 *  or deny (one click, no reason). Operator-confirmed actions
 *  only ever ask once. The page and target stay on the card: a standing allow
 *  is per kind, not per site. */
export function BrowserApprovalCard({
  prompt,
  queueLabel,
  floating = false,
}: {
  prompt: BrowserApprovalPrompt;
  queueLabel?: string;
  /** No open chat docks it: its link opens the chat it belongs to. */
  floating?: boolean;
}) {
  const requester = prompt.requester || prompt.sessionId;
  const files = prompt.files ?? [];
  const page = prompt.origin || prompt.url;
  // An unconfirmed receiver or a file from outside the project: allowing takes a click.
  const risky = (files.length > 0 && !prompt.receiverOrigin) || files.some((file) => file.outside);
  const kind = prompt.remember?.kinds[0];
  let title = t('Allow this action?');
  if (files.length) title = actionQuestion('browser_upload');
  else if (kind && KIND_ACTION[kind]) title = actionQuestion(KIND_ACTION[kind]);
  // The tooltips: what "Always allow" changes, and why an allow takes a click.
  const riskNote = risky ? t('This is not confirmed, so allowing takes a click; Enter does not allow.') : '';
  const scope = prompt.remember ? alwaysAllowNote(requester, prompt.remember.kinds) : '';
  const buttons: ApprovalButton[] = [
    { label: t('Deny'), deny: true },
    ...(prompt.remember
      ? [
          {
            label: t('Always allow'),
            hint: [scope, riskNote].filter(Boolean).join(' '),
            onClick: () => answer(prompt, 'always'),
          },
        ]
      : []),
    {
      label: t('Allow just once'),
      tone: 'primary' as const,
      hint: riskNote || undefined,
      onClick: () => answer(prompt, 'once'),
    },
  ];
  const surface = surfaceOf(prompt);
  const preview = (
    <>
      <div className="approval-preview-row">
        <PixelIcon name="globe" />
        <span className="approval-preview-text">
          <span className="approval-preview-main">{prompt.url}</span>
          <small className="approval-preview-target">{prompt.target}</small>
        </span>
      </div>
      {files.length > 0 ? (
        <>
          <div className="approval-preview-row" data-warn={prompt.receiverOrigin ? undefined : true}>
            <PixelIcon name={prompt.receiverOrigin ? 'globe' : 'alert'} />
            <span className="approval-preview-text">
              <span className="browser-approval-destination">
                {prompt.receiverOrigin ? (
                  <>
                    <span className="approval-preview-main">{prompt.receiverOrigin}</span>
                    {prompt.receiverOrigin !== prompt.origin && (
                      <small>{t('Frame embedded in {{origin}}', { origin: page })}</small>
                    )}
                  </>
                ) : (
                  <>
                    <span className="approval-preview-main">{t('Receiving site not confirmed')}</span>
                    <small>{t('Page: {{origin}}', { origin: page })}</small>
                  </>
                )}
              </span>
              <small>{t('Upload to')}</small>
            </span>
          </div>
          <ul className="browser-approval-files">
            {files.map((file) => (
              <li key={file.path} className="approval-preview-row">
                <PixelIcon name="file" />
                <span className="approval-preview-text">
                  <span className="approval-preview-main">
                    {file.name} <span className="approval-muted">· {fileSize(file.size)}</span>
                    {file.outside && <span className="approval-tag">{t('Outside the project')}</span>}
                  </span>
                  <small>{file.path}</small>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        prompt.paths.map((path) => (
          <div key={path} className="approval-preview-row">
            <PixelIcon name="file" />
            <span className="approval-preview-text">
              <small>{path}</small>
            </span>
          </div>
        ))
      )}
    </>
  );
  return (
    <ApprovalPrompt
      title={title}
      faceAgentId={prompt.agentId || ''}
      requester={requester}
      service={t('Browser')}
      sessionLink={
        floating && surface
          ? { sessionId: surface, label: t('Open session') }
          : prompt.sessionId && prompt.sessionId !== surface
            ? { sessionId: prompt.sessionId, label: t('Open session') }
            : null
      }
      queue={queueLabel}
      expiresAt={prompt.expiresAt}
      preview={preview}
      buttons={buttons}
      focus={risky ? 'deny' : 'primary'}
      enterAllows={!risky}
      onDeny={(reason) => answer(prompt, 'deny', reason)}
      kind="browser"
    />
  );
}

/** Receives the browser approvals for this window: keeps the queue (each one
 *  leaves when answered, closed or expired), tells a failed "always allow"
 *  save, and floats a prompt no open chat docks. */
export function BrowserApprovalHost() {
  useStoreVersion();
  useEffect(
    () =>
      window.mixdogDesktop?.onBrowserApproval?.((prompt) => {
        if ('saveFailed' in prompt) {
          showDesktopToast(t('Allowed this once. The setting could not be saved.'), 'warn');
          return;
        }
        const rest = queue.filter((entry) => entry.id !== prompt.id);
        queue = prompt.closed ? rest : [...rest, prompt as BrowserApprovalPrompt];
        notify();
      }),
    []
  );
  // A prompt with an expiry leaves on it (main denies it then too); one
  // without waits until answered or closed.
  const firstId = queue[0]?.id ?? '';
  const firstExpiry = queue[0]?.expiresAt ?? 0;
  useEffect(() => {
    if (!firstId || !firstExpiry) return;
    const timer = setTimeout(() => drop(firstId), Math.max(0, firstExpiry - Date.now()));
    return () => clearTimeout(timer);
  }, [firstId, firstExpiry]);
  const floating = queue.filter((prompt) => !claims.has(surfaceOf(prompt)));
  const prompt = floating[0];
  if (!prompt) return null;
  return (
    <div className="browser-approval-float">
      <BrowserApprovalCard
        key={prompt.id}
        prompt={prompt}
        queueLabel={floating.length > 1 ? `1/${floating.length}` : undefined}
        floating
      />
    </div>
  );
}
