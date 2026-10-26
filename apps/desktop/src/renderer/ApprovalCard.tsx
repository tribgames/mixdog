// The pending human decision (human-gate/requests.mjs kinds) as the one
// approval surface (approval-prompt.tsx, design/mockups/approval-buttons):
// docked above the composer of the top-level chat, content centred, decided
// with buttons. The login takeover keeps its flow (✕ folds it into a one-line
// chip, the request stays pending). Held requests of unattended runs render as
// the same card from their home-thread row (HeldRequestCard).
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { MIXY_AGENT_ID, agentHomeSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import type { DesktopBrowserLoginStatus, ToolApprovalDecision } from '../shared/contract';
import { connectorById } from '../../../../src/runtime/shared/connector-catalog.mjs';
import { loginSiteLabel } from '../shared/login-site';
import { SECRET_SAVE_SUFFIX, SECRET_USERNAME_SUFFIX } from '../shared/secret-slots';
import { agentHomeTitle } from './agent-contacts-model';
import { browserPageRequestsAvailable, requestBrowserImport, revealBrowserPane } from './browser-page-request';
import { showBrowserPage } from './browser-page-view';
import { holdBrowserTakeover } from './browser-takeover-input';
import { MarkdownSessionContext } from './MarkdownLink';
import type { Approval, TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { ProgressSpinner } from './ProgressSpinner';
import { reportRendererFailure } from './RendererRecovery';
import { type ApprovalButton, ApprovalPreviewRow, ApprovalPrompt, noteApprovalDecision } from './approval-prompt';
import { PixelIcon, type PixelIconName } from './pixel-icon';
import { asRecord, textOf } from './text-format';
import { useRemoteHostImageUrl } from './local-image-preview';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { useSidebarReferences } from './sidebar-reference-cache';
import { useSessionTitle } from './session-glance-store';
import {
  approvalAllowIsPointerOnly,
  approveClickDecision,
  type PermissionScope,
  permissionAllowDecision,
  permissionChoices,
} from '../shared/approval-enter-rule';

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
    // tool-exec/before-hook.mjs CONNECTOR_APPROVAL_REASON.
    'This connector tool is set to ask before it runs for this agent.': () =>
      t('This connector tool is set to ask before it runs for this agent.'),
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

/** The "save sign-ins typed in chat" setting (`saveChatLogins`, on unless
 *  set off): the default of a sign-in card's save box. It is off until the
 *  stored value has loaded; a failed read is reported and stays off. */
function useSaveChatLogins(enabled: boolean): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void Promise.resolve(window.mixdogDesktop?.readSettings?.()).then(
      (settings) => {
        if (live && settings) setOn(settings.saveChatLogins !== false);
      },
      (error: unknown) => reportRendererFailure('unhandled-rejection', error)
    );
    return () => {
      live = false;
    };
  }, [enabled]);
  return on;
}

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

/** The session a chat handed work to, when this card shows its request in
 *  that chat (the runtime's `handoff`, tool-approval.mjs): its id, the name
 *  the chat gave it and the bot whose own chat it is ('' for a session). Null
 *  for any other request, and in that session's own pane. */
export function approvalHandoffTarget(
  approval: Approval,
  hostSessionId: string
): { sessionId: string; title: string; agentId: string } | null {
  const handoff = asRecord(approval.handoff);
  const sessionId = String(approval.sessionId || '');
  if (!handoff || !sessionId || sessionId === hostSessionId) return null;
  return { sessionId, title: String(handoff.title || ''), agentId: String(handoff.agentId || '') };
}

/** The amber chip of a hand-off target: a bot's chat by that bot, any other
 *  session by its current title (the name the chat gave it until the catalog
 *  has it), as the chat's hand-off line names it. */
function useHandoffChip(target: ReturnType<typeof approvalHandoffTarget>): { name: string; agentId?: string } | null {
  const title = useSessionTitle(target?.sessionId ?? '', target?.title || t('Session'));
  const bot = useAgentName(target?.agentId ?? '');
  if (!target) return null;
  return target.agentId ? { name: bot, agentId: target.agentId } : { name: title };
}

/** The one who-line chip of a secret or sign-in card: the asking session's
 *  name (a bot's face and name, a sub-agent's chain, else its title), only
 *  where the card shows in another conversation (a copy in the chat that
 *  delegated the work); null in its own conversation, where the line is omitted. */
export function useOwnerChip(
  approval: Approval,
  hostSessionId: string,
  chain: string
): { name: string; agentId?: string } | null {
  const sessionId = String(approval.sessionId || '');
  const shownIn = hostSessionId || String(approval.surfaceSessionId || '') || sessionId;
  const differs = Boolean(sessionId) && shownIn !== sessionId;
  const handoffChip = useHandoffChip(differs ? approvalHandoffTarget(approval, shownIn) : null);
  const title = useSessionTitle(differs ? sessionId : '', t('Session'));
  if (!differs) return null;
  return handoffChip ?? { name: chain || title };
}

/** How long a takeover waits before it expires (main/takeover-gate.ts
 *  TAKEOVER_EXPIRY_MS, which settles it 'expired'). */
const TAKEOVER_EXPIRY_MS = 15 * 60_000;

/** When a secret or takeover card lapses: its own expiry, else a takeover's
 *  15 minutes from when it was asked; undefined when unknown. */
export function approvalDeadline(approval: Approval): number | undefined {
  const expiresAt = Number(approval.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0) return expiresAt;
  const requestedAt = Number(approval.requestedAt);
  if (approval.kind === 'takeover' && Number.isFinite(requestedAt) && requestedAt > 0) {
    return requestedAt + TAKEOVER_EXPIRY_MS;
  }
  return undefined;
}

/** "사무관 › Worker": the runtime's chain of a delegated request (its tokens
 *  'Lead' in this UI's language), or '' when it has none. */
export function approvalChainLabel(chain: unknown): string {
  const parts = Array.isArray(chain)
    ? chain.filter((part): part is string => typeof part === 'string' && part !== '')
    : [];
  const label = (part: string) => (part === 'Lead' ? t('Lead') : part);
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

/** What a built-in tool does, in a few words ("Run a command"); '' for any other tool. */
export function toolActionNoun(name: string): string {
  const tool = name.toLowerCase();
  if (['shell', 'bash', 'powershell', 'exec', 'run_command'].includes(tool)) return t('Run a command');
  if (['edit', 'write', 'multi_edit', 'apply_patch', 'patch', 'notebook_edit'].includes(tool)) return t('Edit files');
  if (['web_fetch', 'web_search', 'fetch', 'http'].includes(tool)) return t('Network request');
  return '';
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
  decision: ToolApprovalDecision | 'secret' | 'reimport' | 'wait' | 'open';
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
    const form = String(secret?.form || '');
    const origin = String(secret?.origin || '');
    const site = origin ? loginSiteLabel(origin) : '';
    const digits = Number(secret?.length) || 6;
    if (form === 'login' && site) {
      title = t('{{site}} sign-in details', { site });
      text = '';
    } else if (form === 'otp') {
      title = site
        ? t('{{site}} verification code, {{n}} digits', { site, n: digits })
        : t('Verification code, {{n}} digits', { n: digits });
      text = t('Enter the code you received.');
    } else {
      title = t('Enter a secret');
      text = t('Type the value for {{field}}. It goes straight into the field and the agent never sees it.', {
        field: String(secret?.field || secret?.target || ''),
      });
    }
  } else if (kind === 'permission') {
    title = t('Permission request');
  } else if (kind === 'approval') {
    const noun = toolActionNoun(String(approval.name || ''));
    if (noun) title = t('Approval: {{action}}', { action: noun });
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
    // A secret's site is its title; its target is never repeated under it.
    target: String(outbound?.target || ''),
    account: String(outbound?.account || ''),
    payload: String(outbound?.payload || ''),
    editable: Array.isArray(outbound?.editable) ? outbound.editable.map(String) : [],
    details,
    remember: Array.isArray(approval.remember) && approval.remember.includes('agent'),
    secretId: String(secret?.requestId || ''),
    /** The bound field (requests.mjs SECRET_FORMS): 아이디 + 비밀번호 for a
     *  sign-in, the code boxes for a one-time code ('' = one password box). */
    secretForm: kind === 'secret' ? String(secret?.form || '') : '',
    secretLength: Math.min(10, Math.max(4, Number(secret?.length) || 6)),
    /** A login takeover's saved logins for its origin (masked labels). */
    accounts: (Array.isArray(takeover?.accounts) ? takeover.accounts : [])
      .map(asRecord)
      .filter((account): account is Record<string, unknown> => Boolean(account?.id && account.label))
      .map((account) => ({ id: String(account.id), label: String(account.label) })),
    /** The page those logins may go into, bound when the takeover was made. */
    fillId: String(takeover?.fillId || ''),
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
    officeLabel,
    reimport = false,
    controlReady = true,
    secretEntry = true,
    openPage = false,
  }: {
    agentName: string;
    officeLabel: string;
    reimport?: boolean;
    controlReady?: boolean;
    secretEntry?: boolean;
    /** A browser panel can show the takeover's page ("Open"). */
    openPage?: boolean;
  }
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
      // The page the takeover is about, in this device's browser panel.
      ...(openPage && model.surface === 'browser' ? [{ label: t('Open'), decision: 'open' as const }] : []),
      // An expired sign-in can also come back from Chrome (the existing importer).
      ...(reimport && model.surface === 'browser'
        ? [{ label: t('Import again from Chrome'), decision: 'reimport' as const }]
        : []),
      cancel,
    ];
  }
  if (model.kind === 'secret') {
    // A client that cannot hand a value to this PC (a paired phone) never
    // takes one: the value is typed on the PC, and Cancel answers here.
    if (!secretEntry) return [{ label: t('Cancel'), decision: { approved: false, response: 'skip' } }];
    if (model.secretForm === 'otp') {
      return [
        { label: t('Enter'), decision: 'secret' },
        { label: t('Do it yourself'), decision: { approved: false, response: 'skip', reason: 'self' } },
        { label: t('Cancel'), decision: { approved: false, response: 'skip' } },
      ];
    }
    return [
      { label: t('Enter'), decision: 'secret' },
      { label: t('Skip'), decision: { approved: false, response: 'skip' } },
    ];
  }
  if (model.kind === 'permission') {
    const { always, once } = permissionChoices(model.scopes);
    return [
      ...(once ? [{ label: t('Allow just once'), decision: permissionAllowDecision(once) }] : []),
      ...(always ? [{ label: t('Always allow'), decision: permissionAllowDecision(always) }] : []),
      { ...cancel, label: t('Deny') },
    ];
  }
  if (model.office) {
    return [
      // response 'approve': this card's own click (remote-session-methods.ts
      // refuses a bare Allow for a click-only approval).
      { label: officeLabel, decision: approveClickDecision() },
      { label: t('Keep editing'), decision: { approved: false } },
    ];
  }
  if (model.action === 'payment') {
    return [
      { label: t('Allow payment'), decision: approveClickDecision() },
      { ...cancel, label: t('Deny') },
    ];
  }
  if (model.action === 'delete') {
    return [
      {
        label: t('Delete {{n}} permanently', { n: model.details.count || '1' }),
        decision: approveClickDecision(),
      },
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

type LoginRow = { label: string; action: 'open' | 'fill' | 'wait' | 'reimport' | 'cancel' };

/** The login takeover's card (design/mockups/browser-login, side-panel-audit
 *  §1): one head line "<site> 로그인이 필요합니다". With saved logins for the
 *  page's origin it lists them (masked) to pick from: 지금 안 함 / 직접 로그인 /
 *  이 계정으로 로그인, the last filling the picked one through the saved-login
 *  path (profile-import.ts useCredential) and settling the takeover. 직접
 *  로그인 (or 로그인하기 without saved logins) opens this PC's sign-in window
 *  (main/browser/login-popup.ts); closing it without 완료 leaves "로그인하지
 *  않았습니다 · 다시 로그인하기"; a provider that refuses embedded sign-in
 *  offers the Chrome import; 완료 shows "로그인됨" while the agent continues.
 *  A phone cannot open the window: it says so and can cancel. */
function BrowserLoginCard({
  approval,
  resolve,
  agentMode = false,
  settled = null,
  site,
  hostSessionId = '',
}: ApprovalCardProps & { site: string }) {
  const id = String(approval.id ?? '');
  const browserSessionId = useContext(MarkdownSessionContext);
  const sessionId = String(approval.sessionId || browserSessionId || '');
  const { faceAgentId } = useRequester(approval, agentMode);
  const owner = useOwnerChip(approval, hostSessionId, approvalChainLabel(approval.chain));
  const model = approvalCardModel(approval);
  // Saved logins are offered only with the page they may be filled into.
  const accounts = model.fillId ? model.accounts : [];
  // The picked saved login ('' = 다른 계정 입력: sign in by hand).
  const [picked, setPicked] = useState(() => accounts[0]?.id ?? '');
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
  const choosing = local && !settled && (state === 'idle' || state === 'closed') && accounts.length > 0;
  const cancel: LoginRow = { label: choosing ? t('Not now') : t('Cancel'), action: 'cancel' };
  let rows: LoginRow[] = [];
  if (!local) {
    // A phone: the sign-in happens on the PC, but the takeover can end here.
    rows = settled ? [] : [cancel];
  } else if (choosing) {
    const yourself: LoginRow = { label: t('Sign in yourself'), action: 'open' };
    rows = picked ? [{ label: t('Sign in with this account'), action: 'fill' }, yourself, cancel] : [yourself, cancel];
    if (!controlReady) rows = [{ label: t('Stopping the agent…'), action: 'wait' }, cancel];
  } else if (!settled && (state === 'idle' || state === 'closed')) {
    let first: LoginRow = { label: state === 'closed' ? t('Sign in again…') : t('Sign in…'), action: 'open' };
    if (!controlReady) first = { label: t('Stopping the agent…'), action: 'wait' };
    rows = [first, cancel];
  } else if (!settled && state === 'refused') {
    rows = [{ label: t('Import again from Chrome'), action: 'reimport' }, cancel];
  }
  let title = t('{{site}} sign-in required', { site });
  if (!local) {
    title = t('Sign in on your PC');
  } else if (state === 'done' || settled?.approved) {
    title = t('Signed in');
  } else if (state === 'closed') {
    title = t('Not signed in');
  } else if (state === 'refused') {
    title = t('{{site}} does not allow sign-in in this window', { site: status.provider || site });
  }
  const done = local && (state === 'done' || Boolean(settled?.approved));
  const closable = local && !done && state !== 'open';

  const settle = (decision: ToolApprovalDecision) =>
    resolve(decision).then(
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
    if (row.action === 'fill') {
      // The saved login goes only into the page this takeover was bound to,
      // while it is still on the takeover's origin (host-agent.ts fillBoundLogin).
      // A refusal is worded here, never the raw (English) IPC error: the page
      // moved off the takeover's page or origin, or it could not take the login.
      const refused = (pageChanged: boolean) => {
        if (!mounted.current) return;
        setResolving(false);
        setError(
          pageChanged
            ? t('The sign-in page changed, so the saved login was not filled.')
            : t('The saved login could not be filled on this page.')
        );
      };
      void Promise.resolve(api?.browserCredentialFill?.(sessionId, picked, model.fillId)).then(
        (filled) => {
          if (filled?.passwordFilled) return void settle({ approved: true, response: 'done', reason: 'saved_login' });
          // A two-step sign-in's username step: the username is in, the
          // takeover stays open for the user to advance and pick the login again.
          if (filled?.usernameFilled) return void (mounted.current && setResolving(false));
          refused(filled?.reason === 'page-changed');
        },
        () => refused(false)
      );
      return;
    }
    void settle({ approved: false });
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
  // Cancel on the left, the step forward (fill, sign in, import) as the primary.
  const buttons: ApprovalButton[] = [...rows].reverse().map((row) => ({
    label: row.label,
    tone: row === rows[0] && row.action !== 'cancel' ? 'primary' : undefined,
    disabled: row.action === 'wait',
    onClick: () => activate(row),
  }));
  const radioName = `approval-account-${id}`;
  const preview = choosing ? (
    <>
      <div className="approval-accounts" role="radiogroup" aria-label={t('Saved logins')}>
        {[...accounts, { id: '', label: t('Use another account') }].map((account) => (
          <label
            key={account.id || 'other'}
            className="approval-account"
            data-selected={picked === account.id || undefined}
          >
            <input
              type="radio"
              name={radioName}
              value={account.id}
              checked={picked === account.id}
              disabled={resolving}
              onChange={() => setPicked(account.id)}
            />
            <span className="approval-account-label">{account.label}</span>
          </label>
        ))}
      </div>
      <small className="approval-lock-line">{t('The agent never sees the password.')}</small>
    </>
  ) : undefined;
  return (
    <ApprovalPrompt
      title={title}
      faceAgentId={faceAgentId}
      tone={done ? 'done' : 'need'}
      requester=""
      target={owner}
      deadline={done ? undefined : approvalDeadline(approval)}
      preview={preview}
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
      {!local && !settled && <ProgressSpinner size={14} aria-hidden="true" />}
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

/** A secret card's inputs (design/mockups/side-panel-audit §2): a sign-in's
 *  아이디 + 비밀번호 with "save as this site's login" (its default from the
 *  `saveChatLogins` setting), one box per character of a one-time code (3-3 or
 *  4-4, filled whole by a paste and entered once full), else one password box.
 *  Every field is uncontrolled: what is typed lives only in the DOM inputs
 *  until the card reads it at submit (never React state, props or markup). The
 *  code boxes know only how many characters are filled. */
function SecretFields({
  form,
  length,
  filled,
  save,
  disabled,
  secretRef,
  usernameRef,
  onFilled,
  onSave,
  onSubmit,
}: {
  form: string;
  length: number;
  /** How many code characters are typed (a count, no characters). */
  filled: number;
  save: boolean;
  disabled: boolean;
  secretRef: Ref<HTMLInputElement>;
  usernameRef: Ref<HTMLInputElement>;
  onFilled(count: number): void;
  onSave(value: boolean): void;
  /** Enter what the fields hold (read from them by the card). */
  onSubmit(): void;
}) {
  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onSubmit();
  };
  const lock = <small className="approval-lock-line">{t('The agent never sees this.')}</small>;
  if (form === 'otp') {
    // Typing or a paste: the field keeps only the code's characters, the
    // boxes learn how many, and a full code is entered at once.
    const accept = (field: HTMLInputElement) => {
      const code = field.value.replace(/[^0-9A-Za-z]/g, '').slice(0, length);
      if (code !== field.value) field.value = code;
      onFilled(code.length);
      if (code.length === length) onSubmit();
    };
    const current = Math.min(filled, length - 1);
    return (
      <>
        <label className="approval-otp" data-long={length > 6 || undefined}>
          <input
            ref={secretRef}
            className="approval-otp-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={length * 2}
            disabled={disabled}
            aria-label={t('Verification code')}
            spellCheck={false}
            onInput={(event) => accept(event.currentTarget)}
            onKeyDown={submitOnEnter}
          />
          {Array.from({ length }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: one box per position
            <Fragment key={index}>
              {index === Math.ceil(length / 2) && <span className="approval-otp-sep" aria-hidden="true" />}
              <span
                className="approval-otp-box"
                data-filled={index < filled || undefined}
                data-current={index === current || undefined}
                aria-hidden="true"
              />
            </Fragment>
          ))}
        </label>
        {lock}
      </>
    );
  }
  const password = (
    <input
      ref={secretRef}
      className="approval-secret"
      type="password"
      maxLength={4_096}
      disabled={disabled}
      aria-label={form === 'login' ? t('Password') : t('Secret value')}
      autoComplete="off"
      spellCheck={false}
      onKeyDown={submitOnEnter}
    />
  );
  if (form !== 'login') {
    return (
      <>
        {password}
        {lock}
      </>
    );
  }
  return (
    <>
      <label className="approval-field">
        <span className="approval-field-label">{t('Username')}</span>
        <input
          ref={usernameRef}
          className="approval-secret"
          type="text"
          maxLength={4_096}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onKeyDown={submitOnEnter}
        />
      </label>
      <label className="approval-field">
        <span className="approval-field-label">{t('Password')}</span>
        {password}
      </label>
      <label className="approval-check">
        <input type="checkbox" checked={save} disabled={disabled} onChange={(event) => onSave(event.target.checked)} />
        <span>{t("Save as this site's login")}</span>
      </label>
      {lock}
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
  // A session this chat handed work to asks as it does in its own pane (a
  // bot's chat names its bot, a task session is the Lead's), not as this chat.
  const handoff = approvalHandoffTarget(approval, hostSessionId);
  const { agentName, headAgent, faceAgentId } = useRequester(approval, handoff ? Boolean(handoff.agentId) : agentMode);
  const handoffChip = useHandoffChip(handoff);
  const args = asRecord(approval.args);
  const action = String(args?.action || '').toLowerCase();
  let officeLabel = t('Discard recovery');
  if (action === 'commit') officeLabel = t('Commit changes');
  else if (action === 'rollback') officeLabel = t('Roll back');
  const takeoverSessionId = String(approval.sessionId || browserSessionId || '');
  const controlReady = useControlReady(id, takeoverSessionId, model.kind === 'takeover' && !settled);
  // The page's owner and the conversation whose panel shows it (they differ
  // when this chat shows a sub-session's takeover).
  const pageViewer = hostSessionId || browserSessionId || takeoverSessionId;
  const pageOwnerTitle = useSessionTitle(takeoverSessionId !== pageViewer ? takeoverSessionId : '', t('Another session'));
  const browserTakeover = model.kind === 'takeover' && model.surface === 'browser' && !settled;
  // While it waits, a phone tap on the streamed page raises the soft keyboard.
  const takeoverTab = model.takeoverTarget?.tab ?? '';
  useEffect(
    () => (browserTakeover && takeoverSessionId ? holdBrowserTakeover(takeoverSessionId, takeoverTab) : undefined),
    [browserTakeover, takeoverSessionId, takeoverTab]
  );
  const openPage = Boolean(pageViewer && browserPageRequestsAvailable());
  const [text, setText] = useState(model.payload);
  // A secret is never React state: the inputs hold it until submit reads them.
  const secretRef = useRef<HTMLInputElement | null>(null);
  const usernameRef = useRef<HTMLInputElement | null>(null);
  const [codeFilled, setCodeFilled] = useState(0);
  const saveDefault = useSaveChatLogins(model.secretForm === 'login');
  const [saveLogin, setSaveLogin] = useState<boolean | null>(null);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
  const resolvingRef = useRef(false);
  const edited = model.editable.length > 0 && text !== model.payload;
  // A value is only ever handed to this PC; a paired phone has no such path.
  const secretEntry = typeof window !== 'undefined' && typeof window.mixdogDesktop?.provideSecretInput === 'function';
  const owner = useOwnerChip(approval, hostSessionId, approvalChainLabel(approval.chain));
  const handsOver = model.kind === 'secret' || model.kind === 'takeover';
  const rows = approvalCardRows(model, {
    agentName,
    officeLabel,
    reimport: Boolean(browserSessionId && window.mixdogDesktop?.browserProfileImportSources),
    controlReady,
    secretEntry,
    openPage,
  });
  const disabled = resolving || Boolean(settled);

  /** Shows the exact page the takeover is about; no named tab: the panel as it is. */
  const openTakeoverPage = async () => {
    setError('');
    const tabId = model.takeoverTarget?.tab ?? '';
    if (!tabId) return revealBrowserPane(pageViewer);
    const shown = await showBrowserPage({
      viewer: pageViewer,
      owner: takeoverSessionId,
      ownerName: pageOwnerTitle,
      tabId,
    });
    if (shown.status === 'gone') setError(t('This tab is no longer open'));
    else if (shown.status === 'failed') setError(shown.message);
  };

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
    if (row.decision === 'open') {
      void openTakeoverPage();
      return;
    }
    if (row.decision === 'secret') {
      if (resolvingRef.current) return;
      // Read once, here, for the local IPC only; the fields are cleared at once.
      const field = secretRef.current;
      const value = field?.value ?? '';
      const otpShort = model.secretForm === 'otp' && value.length < model.secretLength;
      if (!field || !value || otpShort) return void field?.focus();
      const login = model.secretForm === 'login';
      const name = login ? (usernameRef.current?.value ?? '').trim() : '';
      const save = login && name !== '' && (saveLogin ?? saveDefault);
      field.value = '';
      if (usernameRef.current) usernameRef.current.value = '';
      setCodeFilled(0);
      void (async () => {
        const provide = window.mixdogDesktop?.provideSecretInput;
        // The sign-in's 아이디 and the save choice ride their own slots of
        // the request (main/secret-input.ts); the password is the request's own.
        if (login && name) await provide?.(`${model.secretId}${SECRET_USERNAME_SUFFIX}`, name);
        if (save) await provide?.(`${model.secretId}${SECRET_SAVE_SUFFIX}`, '1');
        const held = await provide?.(model.secretId, value);
        if (held) return void decide({ approved: true, response: 'provide-secret' });
        setError(t('This PC could not take the value. Please try again.'));
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
  // A secret's plain skip (건너뛰기 / 취소) is its Esc button too.
  const denyRow = rows.find(
    (row) =>
      typeof row.decision === 'object' &&
      row.decision.approved === false &&
      (!row.decision.response || (row.decision.response === 'skip' && !row.decision.reason))
  );
  // Payment, permanent delete and an Office rollback or recovery discard are
  // allowed by a click only (shared/approval-enter-rule.ts, as a notification's Allow).
  const clickOnly = approvalAllowIsPointerOnly(approval);
  const permission = permissionChoices(model.kind === 'permission' ? model.scopes : []);
  const [primary, ...others] = rows;
  // "Always allow" is only ever pressed on purpose (a click, or Enter / Space
  // on the button once focus was moved to it): the prompt keeps it out of
  // initial focus and of the card's own Enter.
  const isAlways = (row: CardRow) => {
    const decision = typeof row.decision === 'object' ? row.decision : null;
    return decision?.remember === 'agent' || (Boolean(decision?.scope) && decision?.scope === permission.always?.id);
  };
  // A row's own description (what "Always allow" changes) is its tooltip; a
  // click-only allow's says it takes a click.
  const toButton = (row: CardRow, tone?: ApprovalButton['tone']): ApprovalButton => ({
    label: row.label,
    tone,
    disabled: row.decision === 'wait',
    hint: row.desc,
    always: isAlways(row) || undefined,
    onClick: () => activate(row),
  });
  const denyButton = denyRow && denyRow !== primary ? [{ ...toButton(denyRow), deny: true }] : [];
  const primaryButton: ApprovalButton = clickOnly
    ? { ...toButton(primary, 'primary'), hint: t('Allowing takes a click; Enter does not allow.') }
    : toButton(primary, 'primary');
  const choices = others.filter((row) => row !== denyRow).map((row) => toButton(row));
  // Every card reads deny, the choices, then the primary.
  const buttons: ApprovalButton[] = [...denyButton, ...choices, primaryButton];
  const denyDecision = denyRow?.decision;
  let onDeny: ((reason: string) => void) | undefined;
  if (denyDecision && typeof denyDecision === 'object') {
    onDeny = (reason) => void decide(reason ? { ...denyDecision, reason } : denyDecision);
  }
  const status = approvalSettledStatus(model.kind, settled);
  // The friendly service name; the raw tool id stays as its tooltip.
  const rawTool = model.tool || (model.kind === 'outbound' ? String(approval.name || '') : '');
  const service = connectorServiceLabel(rawTool) || rawTool;
  // A sub-agent's request shown in the top-level chat links to its own
  // session, as does one of a session this chat handed work to.
  const ownSession = String(approval.sessionId || '');
  const surface = String(approval.surfaceSessionId || '');
  const sessionLink =
    !handsOver && ownSession && surface && ownSession !== surface && ownSession !== hostSessionId
      ? { sessionId: ownSession, label: t('Open session'), handoff: Boolean(handoff) }
      : null;
  // Who asks next to the amber target chip; a bot's chat is named once, by its chip.
  let requester = headAgent;
  if (handoff) requester = handoff.agentId ? '' : headAgent || agentName;
  // A secret or takeover card names only the asking session, and only where
  // that is another conversation than the one showing it.
  if (handsOver) requester = '';
  const icon = <PixelIcon name={actionIcon(model.action, model.kind === 'outbound')} />;

  const body = approvalActionBody(model, icon);
  const editor = model.editable.length > 0 && (
    <ApprovalTextEditor text={text} payload={model.payload} disabled={disabled} onChange={setText} />
  );
  const office = model.office && <OfficeApprovalDetails args={args} />;
  // What the agent asked in its own words, where the request is not outbound.
  const ownText = model.kind !== 'outbound' && !(model.kind === 'secret' && !secretEntry) && model.text;
  const previewNode =
    body || editor || office || ownText || model.detail || (model.kind === 'secret' && secretEntry) ? (
      <>
        {ownText && (
          <p className="approval-text" data-centered={model.kind === 'permission' || undefined}>
            {model.text}
          </p>
        )}
        {model.kind === 'permission' &&
          [
            [t('Always allow'), permission.always],
            [t('Allow just once'), permission.once],
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
        {model.kind === 'secret' && secretEntry && (
          <SecretFields
            form={model.secretForm}
            length={model.secretLength}
            filled={codeFilled}
            save={saveLogin ?? saveDefault}
            disabled={disabled}
            secretRef={secretRef}
            usernameRef={usernameRef}
            onFilled={setCodeFilled}
            onSave={setSaveLogin}
            onSubmit={() => activate(rows[0])}
          />
        )}
      </>
    ) : null;
  let title = model.kind === 'outbound' ? actionQuestion(model.action) : model.title;
  if (model.kind === 'secret' && !secretEntry) title = t('Enter it on your PC');
  return (
    <ApprovalPrompt
      title={title}
      faceAgentId={faceAgentId}
      tone="need"
      requester={requester}
      target={handsOver ? owner : handoffChip}
      deadline={handsOver ? approvalDeadline(approval) : undefined}
      service={handsOver ? undefined : service}
      serviceTitle={rawTool !== service ? rawTool : undefined}
      sessionLink={sessionLink}
      queue={queue}
      corner={meta}
      preview={previewNode}
      buttons={buttons}
      focus={clickOnly ? 'deny' : 'primary'}
      enterAllows={!clickOnly}
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
  if (model.kind === 'outbound') return actionLabel(model.action);
  return (model.kind === 'approval' && toolActionNoun(String(approval.name || ''))) || model.title;
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
