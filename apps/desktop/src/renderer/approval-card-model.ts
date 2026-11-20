// What an approval request shows, derived from the request alone: its card
// model, the numbered decision rows and the action/scope wording
// (ApprovalCard.tsx renders them).
import type { ToolApprovalDecision } from '../shared/contract';
import { connectorById } from '../shared/core-src/runtime/shared/connector-catalog.mjs';
import { loginSiteLabel } from '../shared/login-site';
import { approveClickDecision, permissionAllowDecision, permissionChoices } from '../shared/approval-enter-rule';
import type { Approval } from './desktop-types';
import { t } from './i18n';
import { asRecord, textOf } from './text-format';

function approvalText(value: unknown, preferredKey: string): string {
  const preferred = asRecord(value)?.[preferredKey];
  return approvalReasonText((typeof preferred === 'string' ? preferred : textOf(value)).trim());
}

/** A reason the runtime itself writes (human-gate/gate.mjs constants) in the
 *  UI language; an agent's own words stay as written. */
export function approvalReasonText(text: string): string {
  const known: Record<string, () => string> = {
    'This sends or posts on your behalf; it needs your approval.': () =>
      t('This sends or posts on your behalf; it needs your approval.'),
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

/** When a secret card lapses (its own expiry); undefined when unknown. A
 *  takeover card shows no deadline. */
export function approvalDeadline(approval: Approval): number | undefined {
  const expiresAt = Number(approval.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : undefined;
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

/** What the scope line says "Allow for this conversation" changes on a browser card. */
export function sessionAllowScope(agent: string, action: string): string {
  return t("In this conversation, {{agent}}'s {{action}} won't ask again, on any site", { agent, action });
}

/** What the scope line says "Allow for this conversation" changes: this one
 *  tool, in this conversation. Closing, deleting or resetting the conversation,
 *  changing its agent and a restart of the background service end it (it is
 *  held in the service's memory). */
function sessionAllowToolScope(tool: string): string {
  return t(
    "{{tool}} won't ask again in this conversation until you close, delete, or reset it, change its agent, or restart the app.",
    { tool }
  );
}

/** What the scope line says "Allow for this agent" changes: this one tool, for
 *  this agent in every conversation, listed (and revocable) in its permissions. */
function agentAllowToolScope(agent: string, tool: string): string {
  return t("{{tool}} won't ask again for {{agent}}, in any conversation", { agent, tool });
}

/** What the scope line says "Always allow" changes: this one tool, for every
 *  agent, listed (and revocable) in each agent's permissions. */
function sharedAllowScope(tool: string): string {
  return t("{{tool}} won't ask again for any agent, in any conversation", { tool });
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

export function mailAccountNote(action: string, account: string | undefined): string | undefined {
  if (!account) return undefined;
  return action === 'trash' ? t('Mail in {{account}}', { account }) : t('Sent as {{account}}', { account });
}

export function amountText(details: Record<string, string>): string {
  const amount = Number(details.amount);
  const currency = details.currency || '';
  if (details.amount && Number.isFinite(amount) && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
    } catch {}
  }
  return [details.amount, currency].filter(Boolean).join(' ');
}

export function sizeText(value: string): string {
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

export type CardRow = {
  label: string;
  desc?: string;
  /** What the row sends; `secret` hands the typed value over,
   *  `reimport` opens the Chrome import and leaves the card open. */
  decision: ToolApprovalDecision | 'secret' | 'reimport' | 'open';
  /** The card's edited text rides this decision (edit-and-approve). */
  edits?: boolean;
  /** Shown but not choosable yet (a takeover's Done until the agent has stopped). */
  disabled?: boolean;
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
  } else if (kind === 'connector') {
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
    /** The tool the call is for, whatever the card (an outbound card shows its action instead of the tool). */
    callName: String(approval.name || ''),
    detail: outbound || office || kind !== 'approval' ? '' : approvalDetail(approval.args),
    // A secret's site is its title; its target is never repeated under it.
    target: String(outbound?.target || ''),
    account: String(outbound?.account || ''),
    /** The connector account a connector tool call runs as (top-level `account`). */
    requestAccount: outbound?.account ? '' : String(approval.account || ''),
    payload: String(outbound?.payload || ''),
    editable: Array.isArray(outbound?.editable) ? outbound.editable.map(String) : [],
    details,
    remember: Array.isArray(approval.remember) && approval.remember.includes('agent'),
    /** "Allow for this conversation" is offered (requests.mjs: only for an action kind that can be remembered). */
    rememberSession: Array.isArray(approval.remember) && approval.remember.includes('session'),
    /** "Always allow" is offered: a saved allow of every agent's (requests.mjs). */
    rememberShared: Array.isArray(approval.remember) && approval.remember.includes('always'),
    /** The tool every remembered choice covers: `tool:<identity>` (requests.mjs). */
    grantAction: typeof approval.grantAction === 'string' ? approval.grantAction : '',
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
    /** A bot's widening of one connector tool (requests.mjs kind `connector`):
     *  the tool, its level now, the level asked for and the levels offered. */
    connector: connectorChange(kind === 'connector' ? asRecord(approval.connector) : null),
  };
}

function connectorChange(connector: Record<string, unknown> | null) {
  if (!connector) return null;
  return {
    server: String(connector.server || ''),
    tool: String(connector.tool || ''),
    from: String(connector.from || ''),
    requested: String(connector.requested || ''),
    choices: (Array.isArray(connector.choices) ? connector.choices : []).map(String),
  };
}

/** A connector tool's permission level as the UI names it. */
function connectorLevelLabel(level: string): string {
  if (level === 'auto') return t('Auto');
  if (level === 'needs_approval') return t('Needs approval');
  return t('Disabled');
}

/** The connector card's sentence: which bot, which connector and tool, the
 *  level now and the one asked for. */
export function connectorChangeText(
  agentName: string,
  change: NonNullable<ReturnType<typeof connectorChange>>
): string {
  return t("{{agent}} wants to change {{service}}'s {{tool}} permission from '{{from}}' to '{{to}}'", {
    agent: agentName,
    service: connectorServiceLabel(`mcp__${change.server}__${change.tool}`) || change.server,
    tool: change.tool,
    from: connectorLevelLabel(change.from),
    to: connectorLevelLabel(change.requested),
  });
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
    openScreen = false,
  }: {
    agentName: string;
    officeLabel: string;
    reimport?: boolean;
    controlReady?: boolean;
    secretEntry?: boolean;
    /** A browser panel can show the takeover's page ("Open"). */
    openPage?: boolean;
    /** This phone can show the PC's whole screen: a computer takeover's "Open". */
    openScreen?: boolean;
  }
): CardRow[] {
  const cancel: CardRow = { label: t('Cancel'), decision: { approved: false } };
  if (model.kind === 'takeover') {
    // The agent is stopped as the card appears; until that has finished
    // (commands refused, in-flight work drained) Done cannot be chosen.
    return [
      { label: t('Done'), decision: { approved: true, response: 'done' }, disabled: !controlReady },
      // The page the takeover is about, in this device's browser panel.
      ...(openPage && model.surface === 'browser' ? [{ label: t('Open'), decision: 'open' as const }] : []),
      // The PC's whole screen, full-screen on a paired phone.
      ...(openScreen && model.surface === 'computer' ? [{ label: t('Open'), decision: 'open' as const }] : []),
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
  if (model.kind === 'connector') {
    // The person picks the level, whatever the bot asked: Allow sets the tool
    // to needs_approval, Always allow to auto (that tool's level, no
    // remembered grant). Each is a click on this card (shared/approval-enter-rule.ts).
    const choices = model.connector?.choices ?? [];
    return [
      ...(choices.includes('needs_approval')
        ? [{ label: t('Allow'), decision: { ...approveClickDecision(), scope: 'needs_approval' } }]
        : []),
      ...(choices.includes('auto')
        ? [{ label: t('Always allow'), decision: { ...approveClickDecision(), scope: 'auto' } }]
        : []),
      { ...cancel, label: t('Deny') },
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
  // Every remembered choice covers the one tool asked about: the request's own
  // grant key (`tool:<identity>`, the same for every account of a connector).
  const grantTool = model.grantAction.startsWith('tool:') ? model.grantAction.slice('tool:'.length) : model.callName;
  const toolName = connectorToolLabel(grantTool);
  return [
    { label: t('Allow just once'), decision: { approved: true }, edits: true },
    ...(model.rememberSession
      ? [
          {
            label: t('Allow for this conversation'),
            desc: sessionAllowToolScope(toolName),
            decision: { approved: true, remember: 'session' as const },
            edits: true,
          },
        ]
      : []),
    ...(model.remember
      ? [
          {
            label: t('Allow for this agent'),
            desc: agentAllowToolScope(agentName, toolName),
            decision: { approved: true, remember: 'agent' as const },
            edits: true,
          },
        ]
      : []),
    ...(model.rememberShared
      ? [
          {
            label: t('Always allow'),
            desc: sharedAllowScope(toolName),
            decision: { approved: true, remember: 'always' as const },
            edits: true,
          },
        ]
      : []),
    { ...cancel, label: t('Deny') },
  ];
}
