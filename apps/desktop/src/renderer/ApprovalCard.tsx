// The pending human decision (human-gate/requests.mjs kinds) as the one
// approval surface (approval-prompt.tsx, design/mockups/approval-buttons):
// docked above the composer of the top-level chat, content centred, decided
// with buttons. The login takeover keeps its flow (✕ folds it into a one-line
// chip, the request stays pending). Held requests of unattended runs render as
// the same card from their home-thread row (HeldRequestCard).
import { type ReactNode, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MIXY_AGENT_ID, agentHomeSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import type { DesktopBrowserLoginStatus, ToolApprovalDecision } from '../shared/contract';
import { connectorById } from '../../../../src/runtime/shared/connector-catalog.mjs';
import { loginSiteLabel } from '../shared/login-site';
import { agentHomeTitle } from './agent-contacts-model';
import { requestBrowserImport } from './browser-page-request';
import { MarkdownSessionContext } from './MarkdownLink';
import type { Approval, TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';
import { type ApprovalButton, ApprovalPreviewRow, ApprovalPrompt, noteApprovalDecision } from './approval-prompt';
import { PixelIcon, type PixelIconName } from './pixel-icon';
import { asRecord, textOf } from './text-format';
import { useRemoteHostImageUrl } from './local-image-preview';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { useSidebarReferences } from './sidebar-reference-cache';

function approvalText(value: unknown, preferredKey: string): string {
  const preferred = asRecord(value)?.[preferredKey];
  return approvalReasonText((typeof preferred === 'string' ? preferred : textOf(value)).trim());
}

/** A reason the runtime itself writes (human-gate/gate.mjs constants) in the
 *  UI language; an agent's own words stay as written. */
export function approvalReasonText(text: string): string {
  const known: Record<string, () => string> = {
    'This sends or posts outside Mixdog; it needs your approval.': () =>
      t('This sends or posts outside Mixdog; it needs your approval.'),
    "This agent's permission blocks this action.": () => t("This agent's permission blocks this action."),
    // tool-exec/before-hook.mjs CONNECTOR_APPROVAL_REASON, room-member-gate.mjs ROOM_APPROVAL_REASON.
    'This connector tool is set to ask before it runs for this agent.': () =>
      t('This connector tool is set to ask before it runs for this agent.'),
    'Group-room members need your approval before changing anything.': () =>
      t('Group-room members need your approval before changing anything.'),
    // human-gate/run-policy.mjs AUTOMATION_GRANT_REASON.
    "Approving lets this schedule's or webhook's runs act without asking, within the bot's permissions. Payments and permanent deletes are never done in runs.":
      () =>
        t(
          "Approving lets this schedule's or webhook's runs act without asking, within the bot's permissions. Payments and permanent deletes are never done in runs."
        ),
  };
  return known[text]?.() ?? text;
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
 *  agent the request names is still named. A sub-agent's request names its
 *  chain from the top-level chat down ("사무관 › Worker", "Lead › Reviewer"),
 *  wherever the card shows. */
function useRequester(
  approval: Approval,
  agentMode: boolean
): { agentName: string; headAgent: string; faceAgentId: string } {
  const agentId = String(approval.agentId || '');
  const named = agentMode || (agentId !== '' && agentId !== MIXY_AGENT_ID);
  const name = useAgentName(agentId || MIXY_AGENT_ID);
  // The face is the bot's own; a coding session's Lead shows the LEAD mark.
  const faceAgentId = named ? agentId || MIXY_AGENT_ID : '';
  const requester = named
    ? { agentName: name, headAgent: name, faceAgentId }
    : { agentName: t('Lead'), headAgent: '', faceAgentId };
  const chain = approvalChainLabel(approval.chain);
  return chain ? { ...requester, headAgent: chain } : requester;
}

/** "사무관 › Worker": the runtime's chain of a delegated request (its tokens
 *  'Lead' and 'Task session' in this UI's language), or '' when it has none. */
export function approvalChainLabel(chain: unknown): string {
  const parts = Array.isArray(chain)
    ? chain.filter((part): part is string => typeof part === 'string' && part !== '')
    : [];
  const label = (part: string) => {
    if (part === 'Lead') return t('Lead');
    if (part === 'Task session') return t('Task session');
    return part;
  };
  return parts.length > 1 ? parts.map(label).join(' › ') : '';
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
    browser_submit: t('Submit a form in the browser'),
    browser_post: t('Click a send or post button in the browser'),
    browser_upload: t('Upload files in the browser'),
  };
  return labels[action] || t('Tool approval required');
}

/** A connector tool as the card names it: `send (gmail)` for `mcp__gmail__send`. */
export function connectorToolLabel(name: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? `${match[2]} (${match[1]})` : name;
}

/** The service a tool belongs to as the card names it: a connector's catalog
 *  name ("Gmail" for `mcp__gmail-2__send_email`), else the server's own name;
 *  '' for a tool that is no connector's. */
export function connectorServiceLabel(name: string): string {
  const match = /^mcp__(.+?)__.+$/.exec(name);
  if (!match) return '';
  return connectorById(match[1].replace(/-\d+$/, ''))?.name ?? match[1];
}

/** The card's one-line question for an action kind ("이 메일을 보낼까요?"). */
export function actionQuestion(action: string): string {
  const questions: Record<string, string> = {
    comment: t('Post this comment?'),
    review: t('Post this review?'),
    message: t('Send this message?'),
    email: t('Send this email?'),
    publish: t('Publish this post?'),
    form: t('Submit this form?'),
    payment: t('Make this payment?'),
    delete: t('Delete these permanently?'),
    trash: t('Move these emails to Trash?'),
    browser_submit: t('Submit this form?'),
    browser_post: t('Send or post this?'),
    browser_upload: t('Upload these files?'),
  };
  return questions[action] || actionLabel(action);
}

/** What the scope line says "Always allow" changes. */
export function alwaysAllowScope(agent: string, action: string): string {
  return t("With Always allow, {{agent}}'s {{action}} won't ask again", { agent, action });
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

function mailAccountNote(action: string, account: string | undefined): string | undefined {
  if (!account) return undefined;
  return action === 'trash' ? t('Mail in {{account}}', { account }) : t('Sent as {{account}}', { account });
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
  /** What the row sends; `secret` hands the typed value over,
   *  `reimport` opens the Chrome import and leaves the card open. */
  decision: ToolApprovalDecision | 'secret' | 'reimport' | 'wait';
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

type PermissionScope = { id: string; kind: string; label: string };

// A permission request's options are mapped to buttons by their KIND (never by
// label text); a scope without a `kind` is read by its id. Rule:
//  - 항상 허용 ← the first allow_always / always option;
//  - 이번만 허용 ← the narrowest once-type option: allow_once / once first,
//    else the first session-scoped one (allow_session / session / allow_scoped);
//  - reject / cancel kinds and unknown kinds get no button (취소 is the card's own).
// Ties go to the option listed first. With no always option there is no always button.
const ALWAYS_KINDS = ['allow_always', 'always'];
const ONCE_KINDS = ['allow_once', 'once', 'allow_session', 'session', 'allow_scoped'];

export function permissionChoices(scopes: readonly Record<string, unknown>[]): {
  always: PermissionScope | null;
  once: PermissionScope | null;
} {
  const list = scopes.map((scope) => ({
    id: String(scope.id),
    kind: String(scope.kind || scope.id).toLowerCase(),
    label: String(scope.label || scope.id),
  }));
  const always = list.find((scope) => ALWAYS_KINDS.includes(scope.kind)) ?? null;
  let once: PermissionScope | null = null;
  for (const kind of ONCE_KINDS) {
    once = list.find((scope) => scope.kind === kind) ?? null;
    if (once) break;
  }
  return { always, once };
}

/** The numbered one-click rows of a card, in order (1–n). */
export function approvalCardRows(
  model: CardModel,
  {
    agentName,
    officeLabel,
    reimport = false,
    controlReady = true,
  }: { agentName: string; officeLabel: string; reimport?: boolean; controlReady?: boolean }
): CardRow[] {
  const cancel: CardRow = { label: t('Cancel'), decision: { approved: false } };
  if (model.kind === 'takeover') {
    // The agent is stopped as the card appears; until that has finished
    // (commands refused, in-flight work drained) Done cannot be chosen.
    const first: CardRow = controlReady
      ? { label: t('Done'), decision: { approved: true, response: 'done' } }
      : { label: t('Stopping the agent…'), decision: 'wait' };
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
    const { always, once } = permissionChoices(model.scopes);
    return [
      ...(always ? [{ label: t('Always allow'), decision: { approved: true, scope: always.id } }] : []),
      ...(once ? [{ label: t('Allow once'), decision: { approved: true, scope: once.id } }] : []),
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
      { label: t('Allow payment'), decision: { approved: true } },
      { ...cancel, label: t('Deny') },
    ];
  }
  if (model.action === 'delete') {
    return [
      { label: t('Delete {{n}} permanently', { n: model.details.count || '1' }), decision: { approved: true } },
      { ...cancel, label: t('Deny') },
    ];
  }
  const alwaysAllowTarget = model.action || !model.tool ? actionLabel(model.action) : connectorToolLabel(model.tool);
  return [
    { label: t('Allow just once'), decision: { approved: true }, edits: true },
    ...(model.remember
      ? [
          {
            label: t('Always allow'),
            desc: alwaysAllowScope(agentName, alwaysAllowTarget),
            decision: { approved: true, remember: 'agent' as const },
            edits: true,
          },
        ]
      : []),
    { ...cancel, label: t('Deny') },
  ];
}

// ✕ ("decide later") and a takeover's readiness outlive a remount (a
// virtualized row scrolled away and back) for as long as the request is pending.
const laterIds = new Set<string>();
const controlReadyIds = new Set<string>();

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
  /** The corner text (a held request: its run and the time left). */
  meta?: string;
  /** "1/2" when more requests wait behind this one. */
  queue?: string;
  /** The chat showing the card: no "세션 열기" to the chat it is already in. */
  hostSessionId?: string;
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
  const { headAgent, faceAgentId } = useRequester(approval, agentMode);
  const api = typeof window === 'undefined' ? undefined : window.mixdogDesktop;
  const local = Boolean(sessionId && api?.browserLoginOpen);
  const controlReady = useControlReady(id, sessionId, local && !settled);
  const [status, setStatus] = useState<DesktopBrowserLoginStatus>(() => loginStatuses.get(id) ?? { state: 'idle' });
  const [later, setLater] = useState(() => laterIds.has(id));
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
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
  if (!local) {
    title = t('Sign in on your PC');
    metaText = '';
  } else if (state === 'done' || settled?.approved) {
    title = t('Signed in');
    metaText = site;
  } else if (state === 'closed') {
    title = t('Not signed in');
  } else if (state === 'refused') {
    title = t('{{site}} does not allow sign-in in this window', { site: status.provider || site });
    metaText = '';
  }
  const done = local && (state === 'done' || Boolean(settled?.approved));
  const closable = local && !done && state !== 'open';

  const activate = (row: LoginRow) => {
    if (row.action === 'wait' || resolving || settled) return;
    noteApprovalDecision();
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
  if (later && closable) {
    const reopen = () => {
      laterIds.delete(id);
      setLater(false);
    };
    return <ApprovalPendingChip label={title} agentMode={agentMode} onOpen={reopen} />;
  }
  // Cancel on the left, the step forward (sign in, import) as the primary.
  const buttons: ApprovalButton[] = [...rows].reverse().map((row) => ({
    label: row.label,
    tone: row.action === 'cancel' ? undefined : 'primary',
    disabled: row.action === 'wait',
    onClick: () => activate(row),
  }));
  return (
    <ApprovalPrompt
      title={title}
      faceAgentId={faceAgentId}
      tone={done ? 'done' : 'need'}
      requester={metaText || headAgent}
      service={site}
      buttons={buttons}
      focus="primary"
      enterAllows
      onClose={closable ? decideLater : undefined}
      status={done ? site : undefined}
      error={error}
      busy={resolving}
      kind="login"
      agentMode={agentMode}
      data={{ 'data-login': local ? state : 'remote' }}
    >
      {!local && <ProgressSpinner size={14} aria-hidden="true" />}
    </ApprovalPrompt>
  );
}

/** The preview row's pixel icon for an action kind. */
function actionIcon(action: string, outbound: boolean): PixelIconName {
  if (['email', 'message', 'trash'].includes(action)) return 'mail';
  if (action === 'payment') return 'card';
  if (action === 'delete') return 'alert';
  return outbound && action !== 'form' ? 'globe' : 'form';
}

type ApprovalModel = ReturnType<typeof approvalCardModel>;

/** The settled line once another device answered; undefined while unanswered. */
function approvalSettledStatus(kind: ApprovalModel['kind'], settled: ApprovalCardProps['settled']): string | undefined {
  if (!settled) return undefined;
  const device = settled.device;
  if (kind === 'takeover') {
    return settled.approved ? t('Done on {{device}}', { device }) : t('Cancelled on {{device}}', { device });
  }
  return settled.approved ? t('Allowed from {{device}}', { device }) : t('Denied from {{device}}', { device });
}

/** What the action is about: a payment's amount, a deletion's size, the mails
 *  a trash moves, an email's fields, else the target; null when none applies. */
function approvalActionBody(model: ApprovalModel, icon: ReactNode): ReactNode {
  if (model.action === 'payment') {
    return (
      <div className="approval-amount">
        <b>{amountText(model.details)}</b>
        <small>{[model.target, model.details.currency, model.details.recurrence].filter(Boolean).join(' · ')}</small>
      </div>
    );
  }
  if (model.action === 'delete') {
    return (
      <div className="approval-amount">
        <b>
          {[t('{{n}} items', { n: model.details.count || '1' }), sizeText(model.details.size)]
            .filter(Boolean)
            .join(' · ')}
        </b>
        <small>{[model.target, t('Skips the trash and cannot be undone')].filter(Boolean).join(' · ')}</small>
      </div>
    );
  }
  if (model.action === 'trash' && model.details.messages) {
    return (
      <>
        {model.details.messages.split('\n').map((line) => (
          <ApprovalPreviewRow key={line} icon={icon} main={line} />
        ))}
        {model.details.more && (
          <small className="approval-preview-more">{t('and {{n}} more', { n: model.details.more })}</small>
        )}
        {model.account && (
          <small className="approval-preview-more">{t('Mail in {{account}}', { account: model.account })}</small>
        )}
      </>
    );
  }
  if (model.action === 'email') {
    return (
      <>
        <ApprovalPreviewRow
          icon={icon}
          main={model.details.to || model.target}
          sub={model.account ? t('Sent as {{account}}', { account: model.account }) : undefined}
        />
        <dl className="approval-fields">
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
      </>
    );
  }
  if (model.target) {
    return <ApprovalPreviewRow icon={icon} main={model.target} sub={mailAccountNote(model.action, model.account)} />;
  }
  return null;
}

/** The editable text an outbound action sends, with the way back to the original. */
function ApprovalTextEditor({
  text,
  payload,
  disabled,
  onChange,
}: {
  text: string;
  payload: string;
  disabled: boolean;
  onChange(text: string): void;
}) {
  const edited = text !== payload;
  return (
    <div className="approval-edit" data-edited={edited || undefined}>
      <textarea
        value={text}
        maxLength={40_000}
        rows={2}
        disabled={disabled}
        aria-label={t('Text to send, editable')}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="approval-edit-row">
        <span className="approval-hint">
          {edited ? t('Edited · the edited text is sent') : t('Click the text to edit it')}
        </span>
        {edited && (
          <button type="button" className="approval-link" disabled={disabled} onClick={() => onChange(payload)}>
            {t('Back to original')}
          </button>
        )}
      </div>
    </div>
  );
}

/** An office transaction's fields (document, transaction, change counts,
 *  preview output, visual diff) and up to four preview pages. */
function OfficeApprovalDetails({ args }: { args: Record<string, unknown> | null | undefined }) {
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
  return (
    <>
      <dl className="approval-fields">
        {Boolean(args?.document) && (
          <div>
            <dt>{t('Document')}</dt>
            <dd>
              <code>{String(args?.document)}</code>
            </dd>
          </div>
        )}
        {Boolean(transaction?.id) && (
          <div>
            <dt>{t('Transaction')}</dt>
            <dd>
              <code>{String(transaction?.id)}</code>
            </dd>
          </div>
        )}
        {summary && (
          <div>
            <dt>{t('Changes')}</dt>
            <dd>
              {t('{{total}} paths · +{{added}} −{{removed}} ~{{modified}}', {
                total: Number(summary.total || 0),
                added: Number(summary.added || 0),
                removed: Number(summary.removed || 0),
                modified: Number(summary.modified || 0),
              })}
            </dd>
          </div>
        )}
        {Boolean(preview?.output) && (
          <div>
            <dt>{t('Preview')}</dt>
            <dd>
              <code>{String(preview?.output)}</code>
            </dd>
          </div>
        )}
        {visualDiff?.available === true && (
          <div>
            <dt>{t('Visual diff')}</dt>
            <dd>{t('{{percent}}% changed pixels', { percent: Number(visualDiff.changedPercent || 0) })}</dd>
          </div>
        )}
      </dl>
      {previewImages.length > 0 && (
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
    </>
  );
}

function ToolApprovalCard({
  approval,
  resolve,
  agentMode = false,
  settled = null,
  meta,
  queue,
  hostSessionId = '',
}: ApprovalCardProps) {
  const id = String(approval.id ?? '');
  const model = approvalCardModel(approval);
  // The transcript's session: its pane takes the Chrome import ('' off-transcript).
  const browserSessionId = useContext(MarkdownSessionContext);
  const { agentName, headAgent, faceAgentId } = useRequester(approval, agentMode);
  const args = asRecord(approval.args);
  const action = String(args?.action || '').toLowerCase();
  let officeLabel = t('Discard recovery');
  if (action === 'commit') officeLabel = t('Commit changes');
  else if (action === 'rollback') officeLabel = t('Roll back');
  const takeoverSessionId = String(approval.sessionId || browserSessionId || '');
  const controlReady = useControlReady(id, takeoverSessionId, model.kind === 'takeover' && !settled);
  const [text, setText] = useState(model.payload);
  const [secret, setSecret] = useState('');
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
  const resolvingRef = useRef(false);
  const secretRef = useRef<HTMLInputElement | null>(null);
  const edited = model.editable.length > 0 && text !== model.payload;
  const rows = approvalCardRows(model, {
    agentName,
    officeLabel,
    reimport: Boolean(browserSessionId && window.mixdogDesktop?.browserProfileImportSources),
    controlReady,
  });
  const disabled = resolving || Boolean(settled);

  const decide = async (decision: ToolApprovalDecision) => {
    if (resolvingRef.current || settled) return;
    resolvingRef.current = true;
    noteApprovalDecision();
    setError('');
    setResolving(true);
    try {
      const accepted = await resolve(decision);
      // Recorded, or refused because another device answered first: the
      // buttons stay disabled until the request leaves the snapshot.
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

  // Deny (the plain "no" row) on the left, the first row as the primary on
  // the right, anything else between.
  const denyRow = rows.find(
    (row) => typeof row.decision === 'object' && row.decision.approved === false && !row.decision.response
  );
  const danger = model.action === 'payment' || model.action === 'delete';
  const [primary, ...others] = rows;
  // A row's own description (what "Always allow" changes) is its tooltip; a
  // danger allow's says it takes a click.
  const toButton = (row: CardRow, tone?: ApprovalButton['tone']): ApprovalButton => ({
    label: row.label,
    tone,
    disabled: row.decision === 'wait',
    hint: row.desc,
    onClick: () => activate(row),
  });
  const denyButton = denyRow && denyRow !== primary ? [{ ...toButton(denyRow), deny: true }] : [];
  const primaryButton: ApprovalButton = danger
    ? { ...toButton(primary, 'danger'), hint: t('Allowing takes a click; Enter does not allow.') }
    : toButton(primary, 'primary');
  const choices = others.filter((row) => row !== denyRow).map((row) => toButton(row));
  // A permission request reads primary, the narrower choice, then Cancel last;
  // every other card keeps deny, the choices, then the primary.
  const buttons: ApprovalButton[] =
    model.kind === 'permission'
      ? [primaryButton, ...choices, ...denyButton]
      : [...denyButton, ...choices, primaryButton];
  const denyDecision = denyRow?.decision;
  let onDeny: ((reason: string) => void) | undefined;
  if (denyDecision && typeof denyDecision === 'object') {
    onDeny = (reason) => void decide(reason ? { ...denyDecision, reason } : denyDecision);
  }
  const status = approvalSettledStatus(model.kind, settled);
  // The friendly service name; the raw tool id stays as its tooltip.
  const rawTool = model.tool || (model.kind === 'outbound' ? String(approval.name || '') : '');
  const service = connectorServiceLabel(rawTool) || rawTool;
  // A sub-agent's request shown in the top-level chat links to its own session.
  const ownSession = String(approval.sessionId || '');
  const surface = String(approval.surfaceSessionId || '');
  const sessionLink =
    ownSession && surface && ownSession !== surface && ownSession !== hostSessionId
      ? { sessionId: ownSession, label: t('Open session') }
      : null;
  const icon = <PixelIcon name={actionIcon(model.action, model.kind === 'outbound')} />;

  const body = approvalActionBody(model, icon);
  const editor = model.editable.length > 0 && (
    <ApprovalTextEditor text={text} payload={model.payload} disabled={disabled} onChange={setText} />
  );
  const office = model.office && <OfficeApprovalDetails args={args} />;
  // What the agent asked in its own words, where the request is not outbound.
  const ownText = model.kind !== 'outbound' && model.text;
  const permission = permissionChoices(model.kind === 'permission' ? model.scopes : []);
  const previewNode =
    body || editor || office || ownText || model.detail || model.kind === 'secret' ? (
      <>
        {ownText && (
          <p className="approval-text" data-centered={model.kind === 'permission' || undefined}>
            {model.text}
          </p>
        )}
        {model.kind === 'permission' &&
          [
            [t('Always allow'), permission.always],
            [t('Allow once'), permission.once],
          ].map(([label, scope]) => {
            const shown = scope as PermissionScope | undefined;
            if (!shown || shown.label === shown.id) return null;
            return (
              <small key={String(label)} className="approval-preview-more" data-centered>
                {String(label)} · {shown.label}
              </small>
            );
          })}
        {body}
        {editor}
        {model.detail && <pre className="approval-detail">{model.detail}</pre>}
        {office}
        {model.kind === 'secret' && (
          <input
            ref={secretRef}
            className="approval-secret"
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
        )}
      </>
    ) : null;
  return (
    <ApprovalPrompt
      title={model.kind === 'outbound' ? actionQuestion(model.action) : model.title}
      faceAgentId={faceAgentId}
      tone={danger ? 'danger' : 'need'}
      requester={headAgent}
      service={service}
      serviceTitle={rawTool !== service ? rawTool : undefined}
      sessionLink={sessionLink}
      queue={queue}
      corner={meta}
      preview={previewNode}
      buttons={buttons}
      focus={danger ? 'deny' : 'primary'}
      enterAllows={!danger}
      onDeny={onDeny}
      status={status}
      error={error}
      busy={disabled}
      kind={model.kind}
      agentMode={agentMode}
    />
  );
}

/** What an approval decided, named for the one line that reports it after
 *  another device answered ("Send an email"). */
export function approvalRecordLabel(approval: Approval): string {
  const model = approvalCardModel(approval);
  return model.kind === 'outbound' ? actionLabel(model.action) : model.title;
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
  const urlArgs = held.target ? { url: held.target } : {};
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
      : { args: urlArgs }),
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
