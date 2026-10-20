// The pending human decision (human-gate/requests.mjs kinds), shown in the
// transcript exactly where a QuestionCard shows, in QuestionCard's grammar and
// keyboard model (question-card-keys.ts): head row (icon, title + meta, ✕),
// text, the content blocks on the `.question-other` surface, one-click
// numbered rows and the foot hint. ✕ means "decide later": the card folds into
// a one-line chip and the request stays pending. Held requests of unattended
// runs render as the same card from their home-thread row (HeldRequestCard).
import { useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MIXY_AGENT_ID, agentHomeSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import type { DesktopBrowserLoginStatus, ToolApprovalDecision } from '../shared/contract';
import { loginSiteLabel } from '../shared/login-site';
import { agentHomeTitle } from './agent-contacts-model';
import { requestBrowserImport } from './browser-page-request';
import { MarkdownSessionContext } from './MarkdownLink';
import type { Approval, TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import { ProgressSpinner } from './ProgressSpinner';
import { bindCardKeys, focusCardWhenIdle, isTypingTarget } from './question-card-keys';
import { asRecord, textOf } from './text-format';
import { useRemoteHostImageUrl } from './local-image-preview';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { useSidebarReferences } from './sidebar-reference-cache';

function approvalText(value: unknown, preferredKey: string): string {
  const preferred = asRecord(value)?.[preferredKey];
  return (typeof preferred === 'string' ? preferred : textOf(value)).trim();
}

// The one argument that says what the call does, shown on its own the way a
// command approval shows the command; anything else falls back to the JSON.
const PRIMARY_ARG_KEYS = ['command', 'cmd', 'script', 'patch', 'file_path', 'path', 'url', 'query', 'pattern'];

function approvalDetail(args: unknown): string {
  const record = asRecord(args);
  const key = PRIMARY_ARG_KEYS.find((name) => typeof record?.[name] === 'string' && String(record[name]).trim());
  return key ? String(record?.[key]).trim() : textOf(args).trim();
}

function localPreviewUrl(path: unknown): string {
  const value = String(path || '').replace(/\\/g, '/');
  return value ? `file:///${encodeURI(value).replace(/^\/+/, '')}` : '';
}

// Desktop shows the host file directly; a paired browser has no access to the
// host disk, so it reads the image through the remote preview lane instead.
function ApprovalPreviewImage({ path, alt }: { path: unknown; alt: string }) {
  const remoteUrl = useRemoteHostImageUrl(String(path || ''));
  const src = isRemoteHostRenderer() ? remoteUrl : localPreviewUrl(path);
  return <img src={src || undefined} alt={alt} />;
}

const AGENT_KEYS = ['agents'] as const;

/** An agent's display name (its home tab title); its id until the catalog has it. */
export function useAgentName(agentId: string): string {
  const api = typeof window === 'undefined' ? undefined : window.mixdogDesktop;
  const { values } = useSidebarReferences(api, AGENT_KEYS, Boolean(agentId));
  return agentHomeTitle(agentHomeSessionId(agentId) || '', values.agents) || agentId;
}

/** Who the card names as the requester. A bot's chat (agent mode) names the bot,
 *  Mixy included; a coding session is the Lead's (the runtime tags it 'lead'), so
 *  it goes unnamed in the head and reads "Lead" in the remember row. Any other
 *  agent the request names is still named. */
function useRequester(approval: Approval, agentMode: boolean): { agentName: string; headAgent: string } {
  const agentId = String(approval.agentId || '');
  const named = agentMode || (agentId !== '' && agentId !== MIXY_AGENT_ID);
  const name = useAgentName(agentId || MIXY_AGENT_ID);
  return named ? { agentName: name, headAgent: name } : { agentName: t('Lead'), headAgent: '' };
}

/** The action kind's name: the card title and the remember row's "<agent>의 <action>". */
export function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    comment: t('Post a comment'),
    review: t('Post a review'),
    message: t('Send a message'),
    email: t('Send an email'),
    publish: t('Publish a post'),
    form: t('Send a form'),
    payment: t('Confirm payment'),
    delete: t('Confirm permanent delete'),
    trash: t('Move to Trash'),
  };
  return labels[action] || t('Tool approval required');
}

function actionText(action: string): string {
  const texts: Record<string, string> = {
    comment: t('Posts the comment below.'),
    review: t('Posts the review below.'),
    message: t('Sends the message below.'),
    email: t('Sends the email below.'),
    publish: t('Publishes the post below.'),
    form: t('Submits the form below.'),
    payment: t('Makes the payment below.'),
    delete: t('Permanently deletes the items below.'),
    trash: t('Moves the emails below to Trash.'),
  };
  return texts[action] || '';
}

function amountText(details: Record<string, string>): string {
  const amount = Number(details.amount);
  const currency = details.currency || '';
  if (details.amount && Number.isFinite(amount) && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
    } catch {}
  }
  return [details.amount, currency].filter(Boolean).join(' ');
}

function sizeText(value: string): string {
  const bytes = Number(value);
  if (!value || !Number.isFinite(bytes)) return value;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit ? size.toFixed(1) : size}${units[unit]}`;
}

type CardRow = {
  label: string;
  desc?: string;
  /** What the row sends; `takeover` starts doing it yourself, `secret` hands the typed value over,
   *  `reimport` opens the Chrome import and leaves the card open. */
  decision: ToolApprovalDecision | 'takeover' | 'secret' | 'reimport' | 'wait';
  /** The card's edited text rides this decision (edit-and-approve). */
  edits?: boolean;
};

/** Everything a request kind shows, derived from the request alone. */
export function approvalCardModel(approval: Approval) {
  const kind = String(approval.kind || 'approval');
  const args = asRecord(approval.args);
  const outbound = kind === 'outbound' ? asRecord(approval.outbound) : null;
  const action = String(outbound?.category || '');
  const detailRecord = asRecord(outbound?.details) ?? {};
  const details = Object.fromEntries(Object.entries(detailRecord).map(([key, value]) => [key, String(value ?? '')]));
  const office =
    String(approval.name || '').toLowerCase() === 'office' &&
    ['commit', 'rollback', 'discard'].includes(String(args?.action || '').toLowerCase());
  const takeover = asRecord(approval.takeover);
  const secret = asRecord(approval.secret);
  const scopes = asRecord(approval.permission)?.scopes;
  let title = t('Tool approval required');
  let text = approvalText(approval.reason, 'message') || t('Review this tool request before continuing.');
  if (outbound) {
    title = actionLabel(action);
    text = actionText(action) || text;
  } else if (office) {
    title = t('Office transaction review');
  } else if (kind === 'takeover') {
    title = t('Do it yourself');
    text = String(takeover?.instructions || '') || t('The agent needs you to do this step yourself.');
  } else if (kind === 'secret') {
    title = t('Enter a secret');
    text = t('Type the value for {{field}}. It goes straight into the field and the agent never sees it.', {
      field: String(secret?.field || secret?.target || ''),
    });
  } else if (kind === 'permission') {
    title = t('Permission request');
  }
  return {
    kind,
    action,
    office,
    /** A takeover's surface: 'browser' or 'computer'. */
    surface: String(takeover?.surface || ''),
    /** A login takeover (requests.mjs purpose 'login'): the sign-in page and
     *  its site; its card opens the sign-in window instead of the panel. */
    login:
      kind === 'takeover' && takeover?.purpose === 'login' && typeof takeover.url === 'string'
        ? { url: takeover.url, site: loginSiteLabel(takeover.url) }
        : null,
    /** The window a takeover is about (requests.mjs): a browser page ID, or a
     *  computer window id and app; for a future "창 보기" that focuses it. */
    takeoverTarget:
      kind === 'takeover'
        ? {
            label: String(takeover?.target || ''),
            tab: String(takeover?.tab || ''),
            windowId: String(takeover?.windowId || ''),
            app: String(takeover?.app || ''),
          }
        : null,
    title,
    text,
    tool: outbound || kind !== 'approval' ? '' : String(approval.name || ''),
    detail: outbound || office || kind !== 'approval' ? '' : approvalDetail(approval.args),
    target: String(outbound?.target || (kind === 'secret' ? secret?.target : '') || ''),
    account: String(outbound?.account || ''),
    payload: String(outbound?.payload || ''),
    editable: Array.isArray(outbound?.editable) ? outbound.editable.map(String) : [],
    details,
    remember: Array.isArray(approval.remember) && approval.remember.includes('agent'),
    secretId: String(secret?.requestId || ''),
    scopes: (Array.isArray(scopes) ? scopes : [])
      .map(asRecord)
      .filter((scope): scope is Record<string, unknown> => Boolean(scope?.id)),
  };
}

type CardModel = ReturnType<typeof approvalCardModel>;

/** The numbered one-click rows of a card, in order (1–n). */
export function approvalCardRows(
  model: CardModel,
  {
    agentName,
    takingOver,
    officeLabel,
    reimport = false,
    controlReady = true,
  }: { agentName: string; takingOver: boolean; officeLabel: string; reimport?: boolean; controlReady?: boolean }
): CardRow[] {
  const cancel: CardRow = { label: t('Cancel'), decision: { approved: false } };
  if (model.kind === 'takeover') {
    let first: CardRow = { label: t("I'll do it"), decision: 'takeover' };
    if (takingOver) first = { label: t("I'm done"), decision: { approved: true, response: 'done' } };
    // Until the agent is stopped (commands refused, in-flight work drained) the user cannot start.
    else if (!controlReady) first = { label: t('Stopping the agent…'), decision: 'wait' };
    return [
      first,
      // An expired sign-in can also come back from Chrome (the existing importer).
      ...(reimport && model.surface === 'browser'
        ? [{ label: t('Import again from Chrome'), decision: 'reimport' as const }]
        : []),
      cancel,
    ];
  }
  if (model.kind === 'secret') {
    return [
      { label: t('Enter'), decision: 'secret' },
      { label: t('Skip'), decision: { approved: false, response: 'skip' } },
    ];
  }
  if (model.kind === 'permission') {
    return [
      ...model.scopes.map((scope) => ({
        label: String(scope.label || scope.id),
        decision: { approved: true, scope: String(scope.id) },
      })),
      cancel,
    ];
  }
  if (model.office) {
    return [
      { label: officeLabel, decision: { approved: true } },
      { label: t('Keep editing'), decision: { approved: false } },
    ];
  }
  if (model.action === 'payment') {
    return [
      { label: t('Pay {{amount}}', { amount: amountText(model.details) }), decision: { approved: true } },
      cancel,
    ];
  }
  if (model.action === 'delete') {
    return [
      { label: t('Delete {{n}} permanently', { n: model.details.count || '1' }), decision: { approved: true } },
      cancel,
    ];
  }
  return [
    { label: t('Just this once'), decision: { approved: true }, edits: true },
    ...(model.remember
      ? [
          {
            label: t("Don't ask again"),
            desc: t("Applies only to {{agent}}'s {{action}}", { agent: agentName, action: actionLabel(model.action) }),
            decision: { approved: true, remember: 'agent' as const },
            edits: true,
          },
        ]
      : []),
    cancel,
  ];
}

// ✕ ("decide later") and "I'll do it" outlive a remount (a virtualized row
// scrolled away and back) for as long as the request is pending.
const laterIds = new Set<string>();
const takingOverIds = new Set<string>();
const controlReadyIds = new Set<string>();
// A key that answered one card must not answer the next queued one: a card
// takes no number for a moment after it appears or after any card decided.
const KEY_SETTLE_MS = 400;
let lastDecisionAt = 0;

function ApprovalPendingChip({ label, agentMode, onOpen }: { label: string; agentMode: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="question-chip"
      data-agent-mode={agentMode || undefined}
      aria-label={t('Open approval')}
      onClick={onOpen}
    >
      <NeedGlyph />
      <span>{t('Approval pending · {{action}}', { action: label })}</span>
      <span className="question-chip-open">{t('Open')}</span>
    </button>
  );
}

function NeedGlyph() {
  return (
    <svg className="question-need" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2.6" />
      <circle cx="12" cy="12" r="3.3" fill="currentColor" />
    </svg>
  );
}

/** A takeover starts only once this PC reports the agent stopped (takeover-gate.ts);
 *  a client without that boundary (a paired phone) has nothing to wait for. */
function useControlReady(id: string, sessionId: string, takeover: boolean): boolean {
  const awaits = takeover && Boolean(sessionId && window.mixdogDesktop?.takeoverReady);
  const [ready, setReady] = useState(() => !awaits || controlReadyIds.has(id));
  useEffect(() => {
    if (ready || !awaits) return;
    let live = true;
    void Promise.resolve(window.mixdogDesktop?.takeoverReady?.(sessionId, id)).then((value) => {
      if (!value || !live) return;
      controlReadyIds.add(id);
      setReady(true);
    });
    return () => {
      live = false;
    };
  }, [ready, awaits, sessionId, id]);
  return ready;
}

type ApprovalCardProps = {
  approval: Approval;
  /** true: recorded; false: another device already answered (the rows stay
   *  disabled until the request leaves the snapshot). */
  resolve: (decision: ToolApprovalDecision) => Promise<unknown>;
  /** Agent mode: the card narrows to the bubble column with QuestionCard. */
  agentMode?: boolean;
  /** Answered on another device: shown disabled with who answered. */
  settled?: { approved: boolean; device: string } | null;
  /** Replaces the meta line (a held request: its run and the time left). */
  meta?: string;
};

/** The pending human decision of the session, in QuestionCard's place. A
 *  login takeover is the sign-in card; everything else the approval card. */
export function ApprovalCard(props: ApprovalCardProps) {
  const login = approvalCardModel(props.approval).login;
  return login ? <BrowserLoginCard {...props} site={login.site} /> : <ToolApprovalCard {...props} />;
}

// How each login takeover's window last ended, across remounts of its card.
const loginStatuses = new Map<string, DesktopBrowserLoginStatus>();

type LoginRow = { label: string; action: 'open' | 'wait' | 'reimport' | 'cancel' };

/** The login takeover's card (design/mockups/browser-login): one head line
 *  "<site> 로그인이 필요합니다" with 로그인하기 / 취소. 로그인하기 opens this PC's
 *  sign-in window (main/browser/login-popup.ts); closing it without 완료 leaves
 *  "로그인하지 않았습니다 · 다시 로그인하기"; a provider that refuses embedded
 *  sign-in offers the Chrome import; 완료 shows "로그인됨" while the agent
 *  continues. A phone cannot open the window and shows the pending state. */
function BrowserLoginCard({
  approval,
  resolve,
  agentMode = false,
  settled = null,
  site,
}: ApprovalCardProps & { site: string }) {
  const id = String(approval.id ?? '');
  const browserSessionId = useContext(MarkdownSessionContext);
  const sessionId = String(approval.sessionId || browserSessionId || '');
  const { headAgent } = useRequester(approval, agentMode);
  const api = typeof window === 'undefined' ? undefined : window.mixdogDesktop;
  const local = Boolean(sessionId && api?.browserLoginOpen);
  const controlReady = useControlReady(id, sessionId, local && !settled);
  const [status, setStatus] = useState<DesktopBrowserLoginStatus>(() => loginStatuses.get(id) ?? { state: 'idle' });
  const [later, setLater] = useState(() => laterIds.has(id));
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
  const cardRef = useRef<HTMLElement | null>(null);
  const mountedAt = useRef(Date.now());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const follow = (pending: Promise<DesktopBrowserLoginStatus> | undefined) => {
    setError('');
    setStatus({ state: 'open' });
    void Promise.resolve(pending).then(
      (next) => {
        if (next?.state && next.state !== 'unavailable') loginStatuses.set(id, next);
        if (!mounted.current) return;
        if (!next || next.state === 'unavailable') {
          setStatus({ state: 'idle' });
          setError(t('The sign-in window could not open.'));
          return;
        }
        setStatus(next);
      },
      (reason) => {
        if (!mounted.current) return;
        setStatus({ state: 'idle' });
        setError(reason instanceof Error ? reason.message : t('The sign-in window could not open.'));
      }
    );
  };
  // A remounted card picks its window up again where it is.
  // biome-ignore lint/correctness/useExhaustiveDependencies: asks once per takeover
  useEffect(() => {
    if (!local || !api?.browserLoginStatus) return;
    void api.browserLoginStatus(sessionId, id).then((current) => {
      if (!mounted.current || !current || current.state === 'unavailable') return;
      if (current.state === 'open') follow(api.browserLoginOpen?.(sessionId, id));
      else setStatus(current);
    });
  }, [local, sessionId, id]);

  const state = status.state;
  const cancel: LoginRow = { label: t('Cancel'), action: 'cancel' };
  let rows: LoginRow[] = [];
  if (local && !settled && (state === 'idle' || state === 'closed')) {
    let first: LoginRow = { label: state === 'closed' ? t('Sign in again…') : t('Sign in…'), action: 'open' };
    if (!controlReady) first = { label: t('Stopping the agent…'), action: 'wait' };
    rows = [first, cancel];
  } else if (local && !settled && state === 'refused') {
    rows = [{ label: t('Import again from Chrome'), action: 'reimport' }, cancel];
  }
  let title = t('{{site}} sign-in required', { site });
  let metaText = headAgent;
  let text = '';
  if (!local) {
    title = t('Sign in on your PC');
    metaText = '';
    text = t('The agent continues once you finish signing in.');
  } else if (state === 'done' || settled?.approved) {
    title = t('Signed in');
    metaText = site;
  } else if (state === 'closed') {
    title = t('Not signed in');
  } else if (state === 'refused') {
    title = t('{{site}} does not allow sign-in in this window', { site: status.provider || site });
    metaText = '';
    text = t('You can import the account signed in to Chrome.');
  }
  const done = local && (state === 'done' || Boolean(settled?.approved));
  const closable = local && !done && state !== 'open';

  const activate = (row: LoginRow) => {
    if (row.action === 'wait' || resolving || settled) return;
    lastDecisionAt = Date.now();
    if (row.action === 'open') {
      follow(api?.browserLoginOpen?.(sessionId, id));
      return;
    }
    if (row.action === 'reimport') {
      requestBrowserImport(browserSessionId);
      return;
    }
    setResolving(true);
    setError('');
    void resolve({ approved: false }).then(
      (accepted) => {
        if (typeof accepted === 'boolean' || !mounted.current) return;
        setResolving(false);
        setError(t('Mixdog could not record this decision. Please try again.'));
      },
      (reason) => {
        if (!mounted.current) return;
        setResolving(false);
        setError(
          t('Mixdog could not record this decision: {{detail}}', {
            detail: reason instanceof Error ? reason.message : String(reason || ''),
          })
        );
      }
    );
  };
  const decideLater = () => {
    laterIds.add(id);
    setLater(true);
  };
  const live = useRef({ activate, decideLater, rows, closable });
  live.current = { activate, decideLater, rows, closable };
  useEffect(() => {
    if (!later && !done && cardRef.current) focusCardWhenIdle(cardRef.current);
  }, [later, done]);
  useEffect(() => {
    const card = cardRef.current;
    if (!card || later || done) return;
    return bindCardKeys(card, (event) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === 'Escape' && live.current.closable) {
        event.preventDefault();
        event.stopPropagation();
        live.current.decideLater();
        return;
      }
      const row = /^[1-9]$/.test(event.key) ? live.current.rows[Number(event.key) - 1] : undefined;
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() - Math.max(mountedAt.current, lastDecisionAt) < KEY_SETTLE_MS) return;
      live.current.activate(row);
    });
  }, [later, done]);

  if (later && closable) {
    const reopen = () => {
      laterIds.delete(id);
      setLater(false);
    };
    return <ApprovalPendingChip label={title} agentMode={agentMode} onOpen={reopen} />;
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <article> must keep its tag; role="group" names the approval region
    <article
      ref={cardRef}
      tabIndex={-1}
      className="question-card"
      role="group"
      aria-label={title}
      data-approval="login"
      data-login={local ? state : 'remote'}
      data-agent-mode={agentMode || undefined}
      data-settled={done || undefined}
    >
      <div className="question-head">
        <span className="question-icon" data-tone={done ? 'done' : 'need'} aria-hidden="true">
          {done ? '✓' : <NeedGlyph />}
        </span>
        <span className="question-title">
          <strong>{title}</strong>
          {metaText && <span className="question-meta">{metaText}</span>}
        </span>
        {!local && <ProgressSpinner size={14} aria-hidden="true" />}
        {closable && (
          <button
            type="button"
            className="question-close"
            aria-label={t('Decide later')}
            title={t('Decide later')}
            onClick={decideLater}
          >
            ✕
          </button>
        )}
      </div>
      {text && <div className="question-text">{text}</div>}
      {rows.length > 0 && (
        <div className="question-options">
          {rows.map((row, index) => (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder
              key={index}
              type="button"
              className="question-option"
              disabled={resolving || row.action === 'wait'}
              data-waiting={row.action === 'wait' || undefined}
              onClick={() => activate(row)}
            >
              <span className="question-box" data-kind="radio" aria-hidden="true" />
              <span className="question-option-text">
                <span className="question-option-label">{row.label}</span>
              </span>
              <span className="question-key">{index + 1}</span>
            </button>
          ))}
        </div>
      )}
      {error && <ErrorNotice error={error} />}
    </article>
  );
}

function ToolApprovalCard({ approval, resolve, agentMode = false, settled = null, meta }: ApprovalCardProps) {
  const id = String(approval.id ?? '');
  const model = approvalCardModel(approval);
  // The transcript's session: its pane takes the Chrome import ('' off-transcript).
  const browserSessionId = useContext(MarkdownSessionContext);
  const { agentName, headAgent } = useRequester(approval, agentMode);
  const args = asRecord(approval.args);
  const action = String(args?.action || '').toLowerCase();
  const transaction = asRecord(args?.transaction);
  const diff = asRecord(transaction?.diff);
  const summary = asRecord(diff?.summary);
  const preview = asRecord(args?.preview);
  const visualDiff = asRecord(preview?.visualDiff);
  const previewImages = [
    ...(Array.isArray(preview?.images) ? preview.images : []),
    ...(Array.isArray(visualDiff?.images) ? visualDiff.images : []),
  ]
    .map(asRecord)
    .filter((image): image is Record<string, unknown> => Boolean(image?.path))
    .slice(0, 4);
  let officeLabel = t('Discard recovery');
  if (action === 'commit') officeLabel = t('Commit changes');
  else if (action === 'rollback') officeLabel = t('Roll back');
  const [later, setLater] = useState(() => laterIds.has(id));
  const [takingOver, setTakingOver] = useState(() => takingOverIds.has(id));
  const takeoverSessionId = String(approval.sessionId || browserSessionId || '');
  const controlReady = useControlReady(id, takeoverSessionId, model.kind === 'takeover' && !settled);
  const [text, setText] = useState(model.payload);
  const [secret, setSecret] = useState('');
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
  const resolvingRef = useRef(false);
  const cardRef = useRef<HTMLElement | null>(null);
  const secretRef = useRef<HTMLInputElement | null>(null);
  const mountedAt = useRef(Date.now());
  const edited = model.editable.length > 0 && text !== model.payload;
  const rows = approvalCardRows(model, {
    agentName,
    takingOver,
    officeLabel,
    reimport: Boolean(browserSessionId && window.mixdogDesktop?.browserProfileImportSources),
    controlReady,
  });
  const disabled = resolving || Boolean(settled);

  const decide = async (decision: ToolApprovalDecision) => {
    if (resolvingRef.current || settled) return;
    resolvingRef.current = true;
    lastDecisionAt = Date.now();
    setError('');
    setResolving(true);
    try {
      const accepted = await resolve(decision);
      // Recorded, or refused because another device answered first: the rows
      // stay disabled until the request leaves the snapshot.
      if (typeof accepted === 'boolean') return;
      setError(t('Mixdog could not record this decision. Please try again.'));
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason || '');
      setError(
        detail
          ? t('Mixdog could not record this decision: {{detail}}', { detail })
          : t('Mixdog could not record this decision. Please try again.')
      );
    }
    resolvingRef.current = false;
    setResolving(false);
  };
  const activate = (row: CardRow) => {
    if (row.decision === 'wait') return;
    if (row.decision === 'reimport') {
      requestBrowserImport(browserSessionId);
      return;
    }
    if (row.decision === 'takeover') {
      takingOverIds.add(id);
      setTakingOver(true);
      return;
    }
    if (row.decision === 'secret') {
      const value = secret;
      if (!value) return void secretRef.current?.focus();
      setSecret('');
      void (async () => {
        const held = await window.mixdogDesktop?.provideSecretInput?.(model.secretId, value);
        await decide(held ? { approved: true, response: 'provide-secret' } : { approved: false, response: 'skip' });
      })();
      return;
    }
    const decision = row.decision;
    void decide(
      row.edits && edited
        ? { ...decision, response: 'edit-and-approve', editedArgs: { [model.editable[0]]: text } }
        : decision
    );
  };
  const decideLater = () => {
    laterIds.add(id);
    setLater(true);
  };
  const live = useRef({ activate, decideLater, rows });
  live.current = { activate, decideLater, rows };

  useEffect(() => {
    if (!later && !settled && cardRef.current) focusCardWhenIdle(cardRef.current);
  }, [later, settled]);
  useEffect(() => {
    const card = cardRef.current;
    if (!card || later || settled) return;
    return bindCardKeys(card, (event) => {
      if (isTypingTarget(event.target)) return;
      const handled = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (event.key === 'Escape') {
        handled();
        live.current.decideLater();
        return;
      }
      if (!/^[1-9]$/.test(event.key)) return;
      const row = live.current.rows[Number(event.key) - 1];
      if (!row) return;
      handled();
      if (Date.now() - Math.max(mountedAt.current, lastDecisionAt) < KEY_SETTLE_MS) return;
      live.current.activate(row);
    });
  }, [later, settled]);

  if (later && !settled) {
    const reopen = () => {
      laterIds.delete(id);
      setLater(false);
    };
    return <ApprovalPendingChip label={model.title} agentMode={agentMode} onOpen={reopen} />;
  }
  const metaText = meta ?? [headAgent, model.tool].filter(Boolean).join(' · ');
  let hint = t('1–{{n}} choose · Esc later', { n: rows.length });
  if (settled) {
    hint = settled.approved
      ? t('Allowed from {{device}}', { device: settled.device })
      : t('Denied from {{device}}', { device: settled.device });
  }
  const spends = model.action === 'payment' || model.action === 'delete';
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <article> must keep its tag; role="group" names the approval region
    <article
      ref={cardRef}
      tabIndex={-1}
      className="question-card"
      role="group"
      aria-label={model.title}
      data-approval={model.kind}
      data-agent-mode={agentMode || undefined}
      data-settled={settled ? true : undefined}
    >
      <div className="question-head">
        <span className="question-icon" data-tone={settled ? 'done' : 'need'} aria-hidden="true">
          {settled ? '✓' : <NeedGlyph />}
        </span>
        <span className="question-title">
          <strong>{model.title}</strong>
          {metaText && <span className="question-meta">{metaText}</span>}
        </span>
        <button
          type="button"
          className="question-close"
          aria-label={t('Decide later')}
          title={t('Decide later')}
          disabled={Boolean(settled)}
          onClick={decideLater}
        >
          ✕
        </button>
      </div>
      <div className="question-text">{model.text}</div>
      {model.action === 'email' ? (
        <div className="question-target">
          <span className="question-target-main">{t('Sent as {{account}}', { account: model.account })}</span>
        </div>
      ) : (
        model.target && (
          <div className="question-target">
            {model.action === 'trash' && model.details.messages ? (
              <>
                {model.details.messages.split('\n').map((line) => (
                  <span key={line} className="question-target-main">
                    {line}
                  </span>
                ))}
                {model.details.more && (
                  <span className="question-option-desc">{t('and {{n}} more', { n: model.details.more })}</span>
                )}
              </>
            ) : (
              <span className="question-target-main">{model.target}</span>
            )}
            {model.account && model.action === 'trash' && (
              <span className="question-option-desc">{t('Mail in {{account}}', { account: model.account })}</span>
            )}
            {model.account && !['payment', 'delete', 'trash'].includes(model.action) && (
              <span className="question-option-desc">{t('Sent as {{account}}', { account: model.account })}</span>
            )}
          </div>
        )
      )}
      {model.action === 'email' && (
        <dl className="question-fields">
          {(
            [
              [t('To'), model.details.to],
              [t('Cc'), model.details.cc],
              [t('Subject'), model.details.subject],
            ] as const
          )
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
        </dl>
      )}
      {model.editable.length > 0 && (
        <>
          <label className="question-other" data-preview data-typed={edited || undefined}>
            <textarea
              value={text}
              maxLength={40_000}
              rows={1}
              disabled={disabled}
              aria-label={t('Text to send, editable')}
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <div className="question-edit-row">
            <span className="question-hint" data-edited={edited || undefined}>
              {edited ? t('Edited · the edited text is sent') : t('Click the text to edit it')}
            </span>
            {edited && (
              <button
                type="button"
                className="turn-changes-action question-btn"
                disabled={disabled}
                onClick={() => setText(model.payload)}
              >
                {t('Back to original')}
              </button>
            )}
          </div>
        </>
      )}
      {model.action === 'payment' && (
        <div className="question-amount">
          <b>{amountText(model.details)}</b>
          <span className="question-option-desc">
            {[model.details.currency, model.details.recurrence].filter(Boolean).join(' · ')}
          </span>
        </div>
      )}
      {model.action === 'delete' && (
        <div className="question-amount">
          <b>
            {[t('{{n}} items', { n: model.details.count || '1' }), sizeText(model.details.size)]
              .filter(Boolean)
              .join(' · ')}
          </b>
          <span className="question-option-desc">{t('Skips the trash and cannot be undone')}</span>
        </div>
      )}
      {spends && <div className="question-note">{t('This always asks, so there is no “Don’t ask again”.')}</div>}
      {model.detail && <pre className="approval-detail question-detail">{model.detail}</pre>}
      {model.kind === 'secret' && (
        <label className="question-other">
          <input
            ref={secretRef}
            type="password"
            value={secret}
            maxLength={4_096}
            disabled={disabled}
            aria-label={t('Secret value')}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setSecret(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              event.preventDefault();
              activate(rows[0]);
            }}
          />
        </label>
      )}
      {model.office && (
        <dl className="question-fields">
          {Boolean(args?.document) && (
            <>
              <dt>{t('Document')}</dt>
              <dd>
                <code>{String(args?.document)}</code>
              </dd>
            </>
          )}
          {Boolean(transaction?.id) && (
            <>
              <dt>{t('Transaction')}</dt>
              <dd>
                <code>{String(transaction?.id)}</code>
              </dd>
            </>
          )}
          {summary && (
            <>
              <dt>{t('Changes')}</dt>
              <dd>
                {t('{{total}} paths · +{{added}} −{{removed}} ~{{modified}}', {
                  total: Number(summary.total || 0),
                  added: Number(summary.added || 0),
                  removed: Number(summary.removed || 0),
                  modified: Number(summary.modified || 0),
                })}
              </dd>
            </>
          )}
          {Boolean(preview?.output) && (
            <>
              <dt>{t('Preview')}</dt>
              <dd>
                <code>{String(preview?.output)}</code>
              </dd>
            </>
          )}
          {visualDiff?.available === true && (
            <>
              <dt>{t('Visual diff')}</dt>
              <dd>{t('{{percent}}% changed pixels', { percent: Number(visualDiff.changedPercent || 0) })}</dd>
            </>
          )}
        </dl>
      )}
      {model.office && previewImages.length > 0 && (
        // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the preview strip is a plain container labelled for assistive tech
        <div className="office-approval-preview" aria-label={t('Document preview')}>
          {previewImages.map((image, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: preview pages are positional and never reorder
            <figure key={`${String(image.path)}:${index}`}>
              <ApprovalPreviewImage
                path={image.path}
                alt={
                  image.kind === 'visual-diff'
                    ? t('Visual diff page {{page}}', { page: Number(image.page || index + 1) })
                    : t('Preview page {{page}}', { page: Number(image.page || index + 1) })
                }
              />
              <figcaption>{image.kind === 'visual-diff' ? t('Visual diff') : t('Preview')}</figcaption>
            </figure>
          ))}
        </div>
      )}
      <div className="question-options">
        {rows.map((row, index) => (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder
            key={index}
            type="button"
            className="question-option"
            disabled={disabled || row.decision === 'wait'}
            data-waiting={row.decision === 'wait' || undefined}
            onClick={() => activate(row)}
          >
            <span className="question-box" data-kind="radio" aria-hidden="true" />
            <span className="question-option-text">
              <span className="question-option-label">{row.label}</span>
              {row.desc && <span className="question-option-desc">{row.desc}</span>}
            </span>
            {index < 9 && <span className="question-key">{index + 1}</span>}
          </button>
        ))}
      </div>
      {error && <ErrorNotice error={error} />}
      <div className="question-foot" data-status={settled ? true : undefined}>
        <span className="question-hint">{hint}</span>
      </div>
    </article>
  );
}

// Held requests: which pending home-thread rows already settled. The row that
// settles one arrives later in the same thread; the conversation publishes the
// settled ids per session so the earlier row's card can fold away.
const heldSettled = new Map<string, Map<string, string>>();
const heldListeners = new Set<() => void>();
const subscribeHeld = (listener: () => void) => {
  heldListeners.add(listener);
  return () => heldListeners.delete(listener);
};

/** Record the settled held requests of `sessionId`'s transcript (`status|device`). */
export function publishHeldSettlements(sessionId: string, items: readonly TranscriptItem[]): void {
  const next = new Map<string, string>();
  for (const item of items) {
    const held = asRecord(item.heldRequest);
    if (held?.id && held.status !== 'pending') next.set(String(held.id), `${held.status}|${String(held.device || '')}`);
  }
  const previous = heldSettled.get(sessionId);
  if (previous && previous.size === next.size && [...next].every(([key, value]) => previous.get(key) === value)) return;
  if (next.size) heldSettled.set(sessionId, next);
  else heldSettled.delete(sessionId);
  for (const listener of heldListeners) listener();
}

function heldApproval(held: Record<string, unknown>): Approval {
  const action = String(held.action || '');
  return {
    id: String(held.id),
    name: String(held.tool || ''),
    kind: held.kind === 'outbound' ? 'outbound' : 'approval',
    reason: String(held.reason || ''),
    agentId: String(held.agentId || ''),
    remember: Array.isArray(held.remember) ? held.remember : ['once'],
    ...(held.kind === 'outbound'
      ? {
          outbound: {
            category: action,
            target: held.target,
            account: held.account,
            payload: held.payload || '',
            editable: held.editable || [],
            details: held.details || {},
          },
        }
      : { args: held.target ? { url: held.target } : {} }),
  };
}

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** A held request of an unattended run, in its owner's home thread: the same
 *  card with "<routine> 실행 · m:ss 남음" while it waits. */
export function HeldRequestCard({ held, sessionId }: { held: Record<string, unknown>; sessionId: string }) {
  const id = String(held.id || '');
  const settledKey = useSyncExternalStore(
    subscribeHeld,
    () => heldSettled.get(sessionId)?.get(id) ?? '',
    () => ''
  );
  const expiresAt = Number(held.expiresAt || 0);
  const [now, setNow] = useState(() => Date.now());
  // Settled while this card was showing: it stays a moment, disabled, saying who answered.
  const [shownSettled, setShownSettled] = useState<{ approved: boolean; device: string } | null>(null);
  const wasPending = useRef(!settledKey);
  const decidedHere = useRef(false);
  const pending = !settledKey && held.status === 'pending' && (!expiresAt || expiresAt > now);
  useEffect(() => {
    if (!pending || !expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [pending, expiresAt]);
  useLayoutEffect(() => {
    if (!settledKey || !wasPending.current) return;
    wasPending.current = false;
    const [status, device] = settledKey.split('|');
    if (!device || decidedHere.current) return;
    setShownSettled({ approved: status === 'approved', device });
    const timer = window.setTimeout(() => setShownSettled(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [settledKey]);
  if (!pending && !shownSettled) return null;
  const run = asRecord(held.run);
  const routine = String(run?.name || '') || (run?.kind === 'webhook' ? t('Webhook') : t('Schedule'));
  return (
    <ApprovalCard
      approval={heldApproval(held)}
      agentMode
      settled={shownSettled}
      meta={
        expiresAt
          ? t('{{routine}} run · {{left}} left', { routine, left: clock(expiresAt - now) })
          : t('{{routine}} run', { routine })
      }
      resolve={async (decision) => {
        decidedHere.current = true;
        const accepted = await window.mixdogDesktop.resolveToolApprovalForSession(sessionId, id, decision);
        if (accepted !== true) decidedHere.current = false;
        return accepted;
      }}
    />
  );
}
