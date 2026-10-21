// session/human-gate/requests.mjs
// The data model of a human-in-the-loop prompt. A request has one `kind`:
//   approval   — allow or deny one tool call;
//   outbound   — a call that posts, sends, pays or deletes outside (its action
//                kind, target, account, the exact payload text, which fields
//                the card may edit, and the mail/payment/delete detail lines);
//   secret     — the user types a value into a target field; the request names
//                the target and the field label, never a value;
//   takeover   — the user does a step themselves and says "done";
//   permission — the user picks one of the offered scopes.
// A response is one of HUMAN_RESPONSES plus a `remember` scope; a policy lists
// the scopes it allows and can leave out `always`. Nothing here ever carries a
// secret value: a decision that names one is stripped to its verdict.

export const HUMAN_REQUEST_KINDS = Object.freeze(['approval', 'outbound', 'secret', 'takeover', 'permission']);
export const HUMAN_RESPONSES = Object.freeze(['approve', 'deny', 'edit-and-approve', 'provide-secret', 'skip', 'done']);
export const REMEMBER_SCOPES = Object.freeze(['once', 'agent', 'always']);
export const SECRET_REQUEST_TIMEOUT_MS = 120_000;

const RESPONSES_BY_KIND = Object.freeze({
  approval: ['approve', 'deny'],
  outbound: ['approve', 'edit-and-approve', 'deny'],
  secret: ['provide-secret', 'skip'],
  takeover: ['done', 'deny'],
  permission: ['approve', 'deny'],
});
const GRANTING_RESPONSES = new Set(['approve', 'edit-and-approve', 'provide-secret', 'done']);
const TEXT_LIMIT = 200;
/** An outbound card's extra lines: mail headers, the payment, the delete, the
 *  trash card's message list (gate.mjs describeEmails) and its remainder. */
const DETAIL_FIELDS = [
  'to',
  'cc',
  'subject',
  'merchant',
  'amount',
  'currency',
  'recurrence',
  'count',
  'size',
  'messages',
  'more',
];
const DETAIL_LIMITS = { messages: 1_000 };
const PAYLOAD_LIMIT = 40_000;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = TEXT_LIMIT) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');

/** The human kind of a request; anything else (ask_user's 'question', a
 *  hook's bare ask) is an ordinary approval for responses. */
export function humanRequestKind(request) {
  return HUMAN_REQUEST_KINDS.includes(request?.kind) ? request.kind : 'approval';
}

/** A login takeover's sign-in page: https, or http on loopback only (a local
 *  site); never embedded credentials. `{ url, origin }`, or null. */
export function loginPageUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return null;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback =
    host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return null;
  if (parsed.username || parsed.password) return null;
  return { url: parsed.href, origin: parsed.origin };
}

function rememberScopes(value) {
  const listed = Array.isArray(value) ? value.filter((scope) => REMEMBER_SCOPES.includes(scope)) : [];
  return ['once', ...new Set(listed.filter((scope) => scope !== 'once'))];
}

/** The kind-specific fields of a request, whitelisted. Spread onto the
 *  presented request; `args` is replaced for a secret so no value rides it. */
export function humanRequestFields(input = {}) {
  const kind = input?.kind;
  if (!HUMAN_REQUEST_KINDS.includes(kind)) return {};
  const fields = { remember: rememberScopes(input.remember) };
  // The agent the request acts for (its name on the card and the remembered grant).
  if (text(input.agentId)) fields.agentId = text(input.agentId);
  // The one session a remembering answer may come from (gate.mjs rememberSurfaceOf).
  if (text(input.rememberAt)) fields.rememberAt = text(input.rememberAt);
  if (kind === 'outbound' && isRecord(input.outbound)) {
    const outbound = input.outbound;
    const details = isRecord(outbound.details) ? outbound.details : {};
    fields.outbound = {
      category: text(outbound.category),
      target: text(outbound.target),
      account: text(outbound.account),
      payload: typeof outbound.payload === 'string' ? outbound.payload.slice(0, PAYLOAD_LIMIT) : '',
      editable: Array.isArray(outbound.editable) ? outbound.editable.filter((name) => typeof name === 'string') : [],
      details: Object.fromEntries(
        DETAIL_FIELDS.filter((name) => text(details[name])).map((name) => [
          name,
          text(details[name], DETAIL_LIMITS[name]),
        ])
      ),
    };
  }
  if (kind === 'secret') {
    const secret = isRecord(input.secret) ? input.secret : {};
    fields.secret = {
      requestId: text(secret.requestId),
      surface: secret.surface === 'computer' ? 'computer' : 'browser',
      target: text(secret.target),
      field: text(secret.field),
    };
    fields.args = { surface: fields.secret.surface, target: fields.secret.target, field: fields.secret.field };
    fields.remember = ['once'];
  }
  if (kind === 'takeover') {
    const takeover = isRecord(input.takeover) ? input.takeover : {};
    const surface = takeover.surface === 'computer' ? 'computer' : 'browser';
    // The window it is about (ask-user-tool-defs.mjs handoffIdentity): a
    // browser page ID, or a computer window id and app, so the card can bring
    // exactly that window forward on the user's click.
    const token = (value, limit) => (/^[\w.:#@-]+$/.test(text(value, limit)) ? text(value, limit) : '');
    const tab = token(takeover.tab, 64);
    const windowId = token(takeover.windowId, 128);
    const app = text(takeover.app, 120);
    const identity = {};
    if (surface === 'browser') {
      if (tab) identity.tab = tab;
    } else {
      if (windowId) identity.windowId = windowId;
      if (app) identity.app = app;
    }
    // A login takeover (purpose 'login') opens the desktop's sign-in window on
    // its validated page instead of handing over the side panel.
    const login = surface === 'browser' && takeover.purpose === 'login' ? loginPageUrl(takeover.url) : null;
    fields.takeover = {
      surface,
      instructions: text(takeover.instructions, 2_000),
      ...(text(takeover.target) ? { target: text(takeover.target) } : {}),
      ...identity,
      ...(login ? { purpose: 'login', url: login.url, origin: login.origin } : {}),
    };
    fields.remember = ['once'];
  }
  if (kind === 'permission') {
    const scopes = Array.isArray(input.permission?.scopes) ? input.permission.scopes : [];
    fields.permission = {
      scopes: scopes
        .filter((scope) => isRecord(scope) && text(scope.id))
        .map((scope) => ({
          id: text(scope.id),
          label: text(scope.label) || text(scope.id),
          // The option's kind (allow_always / allow_once / reject, as an ACP or
          // MCP permission request names them); the card maps buttons by it.
          ...(text(scope.kind) ? { kind: text(scope.kind) } : {}),
        })),
    };
  }
  return fields;
}

/** Only `editable` string fields of `editedArgs`; {} when nothing applies. */
function editableArgs(editedArgs, editable) {
  if (!isRecord(editedArgs)) return {};
  const out = {};
  for (const name of editable || []) {
    if (typeof editedArgs[name] === 'string') out[name] = editedArgs[name].slice(0, PAYLOAD_LIMIT);
  }
  return out;
}

/**
 * The canonical response to `request` from a decision: `approved` (the card's
 * polarity) plus optional `{ response, editedArgs, remember, scope }`. An
 * unknown or contradicting response falls back to the polarity's default;
 * edits survive only on an outbound request and only for its editable fields;
 * `remember` only when the request allows it and the call was granted.
 */
export function normalizeHumanResponse(request, approved, extra = {}) {
  const kind = humanRequestKind(request);
  const allowed = RESPONSES_BY_KIND[kind];
  const polarity = approved === true;
  const fallback = polarity ? allowed[0] : allowed[allowed.length - 1];
  const asked = isRecord(extra) && allowed.includes(extra.response) ? extra.response : '';
  let response = asked && GRANTING_RESPONSES.has(asked) === polarity ? asked : fallback;
  const result = { approved: polarity, response };
  if (response === 'edit-and-approve') {
    const edits = editableArgs(extra.editedArgs, request?.outbound?.editable);
    if (Object.keys(edits).length) result.editedArgs = edits;
    else response = result.response = 'approve';
  }
  const scopes = Array.isArray(request?.remember) ? request.remember : ['once'];
  result.remember = polarity && scopes.includes(extra?.remember) ? extra.remember : 'once';
  if (kind === 'permission' && polarity) {
    const ids = (request?.permission?.scopes || []).map((scope) => scope.id);
    if (ids.includes(extra?.scope)) result.scope = extra.scope;
  }
  return result;
}

/** `args` with the card's edited fields in place of the model's. */
export function applyEditedArgs(args, editedArgs, editable) {
  const edits = editableArgs(editedArgs, editable);
  if (!Object.keys(edits).length) return args;
  return { ...(isRecord(args) ? args : {}), ...edits };
}
