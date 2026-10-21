// session/human-gate/outbound-policy.mjs
// Which calls post, send or spend outside the machine and so need the user's
// approval by default: PR comment and review, issue comment, email or message
// send, social publish, form submit, payment or purchase, and a permanent
// delete. Classified by name against a small explicit list, with the tool's
// annotations: a known send name stays outbound whatever the tool declares;
// any other tool that declares itself read-only is never outbound, and an MCP
// tool may opt in with `outboundHint: true`. Browser form submits are
// confirmed by the desktop browser host itself (main/browser/action-approval.ts),
// so `browser` is not classified here.
//
// The category is the "action kind" a remembered grant is keyed by (agent +
// kind). Payments and permanent deletes are never remembered.

/** Every action kind, in the order the profile's permission table lists them. */
export const ACTION_KINDS = Object.freeze([
  'comment',
  'review',
  'message',
  'email',
  'publish',
  'form',
  'payment',
  'delete',
  'trash',
  // Browser Use gated actions (main/browser/action-approval.ts): a form
  // submit / Enter, a click on a send or post control, and a file upload. They
  // are not classified here (the desktop browser host asks); only their grants
  // live in this store. Operator-confirmed actions
  // (MIXDOG_BROWSER_CONFIRM_ACTIONS) have no kind: they always ask.
  'browser_submit',
  'browser_post',
  'browser_upload',
]);
const UNREMEMBERED_ACTIONS = new Set(['payment', 'delete']);

/** Whether "don't ask again" (an `allow` grant) may exist for `kind`. */
export function isRememberableAction(kind) {
  return ACTION_KINDS.includes(kind) && !UNREMEMBERED_ACTIONS.has(kind);
}

const GITHUB_OUTBOUND = new Map([
  ['issue.comment', 'comment'],
  ['pr.comment', 'comment'],
  ['pr.review', 'review'],
]);

/** Bare MCP tool names (lowercase, `-` → `_`) and what they send. */
const MCP_OUTBOUND = new Map([
  ...[
    'add_issue_comment',
    'create_issue_comment',
    'add_reply_to_pull_request_comment',
    'add_comment_to_pending_review',
    'add_pull_request_review_comment',
  ].map((name) => [name, 'comment']),
  ...['create_pull_request_review', 'create_and_submit_pull_request_review', 'submit_pending_pull_request_review'].map(
    (name) => [name, 'review']
  ),
  ...['send_email', 'send_mail', 'gmail_send', 'gmail_send_email', 'send_gmail_message', 'reply_email'].map((name) => [
    name,
    'email',
  ]),
  ...[
    'send_message',
    'post_message',
    'reply_to_message',
    'slack_post_message',
    'slack_reply_to_thread',
    'chat_post_message',
    'discord_send_message',
    'telegram_send_message',
  ].map((name) => [name, 'message']),
  ...['create_post', 'publish_post', 'create_tweet', 'post_tweet', 'send_tweet'].map((name) => [name, 'publish']),
  ['submit_form', 'form'],
]);

const PAYLOAD_FIELDS = ['body', 'text', 'message', 'content', 'comment', 'subject'];
const TARGET_FIELDS = ['to', 'recipient', 'recipients', 'channel', 'channel_id', 'chat_id', 'thread', 'url', 'page'];

// Name tokens (split on `_`) that make a send, a payment or a permanent delete.
// A name opening with a read verb (list_payments, get_purchase) only reads.
const READ_VERBS = new Set([
  'get',
  'list',
  'search',
  'read',
  'fetch',
  'retrieve',
  'find',
  'view',
  'describe',
  'lookup',
]);
const MAIL_TOKENS = new Set(['mail', 'email', 'gmail', 'outlook', 'smtp']);
const SEND_TOKENS = new Set(['send', 'reply', 'forward']);
const PAYMENT_TOKENS = new Set(['pay', 'payment', 'purchase', 'buy', 'checkout', 'charge']);
const PAYMENT_NAMES = new Set(['place_order', 'send_money', 'transfer_money', 'transfer_funds']);
const PERMANENT_TOKENS = new Set(['permanent', 'permanently', 'hard', 'forever']);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const bareName = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/-/g, '_');
const tokensOf = (value) =>
  bareName(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

function payloadOf(args, fields) {
  const editable = fields.filter((name) => typeof args[name] === 'string');
  return { payload: editable.length ? String(args[editable[0]]) : '', editable };
}

const firstOf = (args, names) => {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (Array.isArray(value) && value.length) return value.map(String).join(', ');
  }
  return '';
};

/** The category a bare MCP tool name (and its server) makes, or ''. */
function categoryByName(bare, server) {
  const tokens = tokensOf(bare);
  const listed = MCP_OUTBOUND.get(bare) || '';
  if (READ_VERBS.has(tokens[0])) return listed;
  const mail = [...tokens, ...tokensOf(server)].some((token) => MAIL_TOKENS.has(token));
  if (mail && tokens.some((token) => SEND_TOKENS.has(token))) return 'email';
  if (listed) return listed;
  if (PAYMENT_NAMES.has(bare) || tokens.some((token) => PAYMENT_TOKENS.has(token))) return 'payment';
  if (bare === 'empty_trash' || tokens.includes('purge')) return 'delete';
  // Recoverable (Gmail Trash): asks, and unlike a permanent delete it may be remembered.
  if (bare === 'trash_emails') return 'trash';
  if (tokens.includes('delete') && tokens.some((token) => PERMANENT_TOKENS.has(token))) return 'delete';
  return '';
}

/** What a card shows besides the payload: mail headers, the payment, the delete (empty lines left out). */
function detailsOf(category, args) {
  return Object.fromEntries(Object.entries(detailLines(category, args)).filter(([, value]) => value));
}

function detailLines(category, args) {
  if (category === 'email') {
    return {
      to: firstOf(args, ['to', 'recipient', 'recipients']),
      cc: firstOf(args, ['cc']),
      subject: firstOf(args, ['subject']),
    };
  }
  if (category === 'payment') {
    return {
      merchant: firstOf(args, ['merchant', 'payee', 'vendor', 'seller', 'recipient', 'to', 'description']),
      amount: firstOf(args, ['amount', 'price', 'total', 'value']),
      currency: firstOf(args, ['currency']).toUpperCase(),
      recurrence: firstOf(args, ['recurrence', 'interval', 'frequency', 'billing_cycle']),
    };
  }
  if (category === 'trash') return { count: String(Array.isArray(args.ids) ? args.ids.length : 1) };
  if (category === 'delete') {
    const listed = ['ids', 'paths', 'files', 'file_ids', 'items'].map((name) => args[name]).find(Array.isArray);
    return {
      count: firstOf(args, ['count']) || String(listed ? listed.length : 1),
      size: firstOf(args, ['size', 'total_size', 'bytes']),
    };
  }
  return {};
}

function mcpTarget(args, server) {
  const repo = [args.owner, args.repo].filter((part) => typeof part === 'string' && part).join('/');
  const number = args.issue_number ?? args.pull_number ?? args.number;
  if (repo) return number != null ? `${repo}#${number}` : repo;
  for (const name of TARGET_FIELDS) {
    const value = args[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length) return value.map(String).join(', ');
  }
  return server;
}

/**
 * `{ category, tool, target, account, payload, editable, details }` for a call
 * that posts, sends, pays or permanently deletes, else null. `category` is the
 * action kind; `tool` the GitHub action or the MCP tool's full name.
 */
export function classifyOutboundCall({ name, args, annotations } = {}) {
  const input = isRecord(args) ? args : {};
  const toolName = String(name || '');
  if (toolName === 'github') {
    const category = GITHUB_OUTBOUND.get(input.action);
    if (!category) return null;
    return {
      category,
      tool: `github:${input.action}`,
      target: `${input.repo || '(current project)'}#${input.number ?? '?'}`,
      account: String(input.hostname || 'github.com'),
      ...payloadOf(input, ['body']),
      details: {},
    };
  }
  if (!toolName.startsWith('mcp__')) return null;
  const [, server = '', ...rest] = toolName.split('__');
  const bare = bareName(annotations?.mcpToolName || rest.join('__'));
  let category = categoryByName(bare, server);
  if (!category && tokensOf(bare).includes('delete') && input.permanent === true) category = 'delete';
  // A known send, payment or delete name stays outbound whatever the tool says.
  if (!category && annotations?.readOnlyHint === true) return null;
  if (!category && annotations?.outboundHint === true) category = 'message';
  if (!category) return null;
  return mcpOutbound(toolName, server, input, category);
}

/** The classification of connector tool `name` as a permanent delete — for a
 *  delete the name-based list above does not know (run-policy.mjs decides which). */
export function classifyAsDelete({ name, args } = {}) {
  const toolName = String(name || '');
  const [, server = ''] = toolName.split('__');
  return mcpOutbound(toolName, server, isRecord(args) ? args : {}, 'delete');
}

function mcpOutbound(toolName, server, input, category) {
  const details = detailsOf(category, input);
  const spends = category === 'payment' || category === 'delete';
  return {
    category,
    tool: toolName,
    target:
      (category === 'payment' && details.merchant) ||
      (category === 'trash' && firstOf(input, ['ids'])) ||
      (category === 'delete' && firstOf(input, ['path', 'name', 'folder', 'paths', 'ids', 'file_ids'])) ||
      mcpTarget(input, server),
    account: (category === 'email' && firstOf(input, ['from', 'account'])) || server,
    ...(spends || category === 'trash' ? { payload: '', editable: [] } : payloadOf(input, PAYLOAD_FIELDS)),
    details,
  };
}
