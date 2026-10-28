// Gmail with a Google app password instead of the Google sign-in: a small MCP
// server answered in-process at a reserved address (connector-catalog.mjs
// GMAIL_APP_PASSWORD; RFC 2606 .invalid, so no request can leave for it),
// like the built-in Google connectors (google-mcp.mjs). It speaks IMAP
// (imap.gmail.com:993, TLS) and SMTP (smtp.gmail.com:465, TLS) as the account
// named in the server's header, with the app password read from the keychain
// for each call. The password is checked with Gmail before it is saved, and
// never appears in a config, log, error or tool result.
import { createHash } from 'node:crypto';
import keychain from '../../lib/keychain-cjs.cjs';
import { GMAIL_APP_PASSWORD, gmailAddress } from '../shared/connector-catalog.mjs';
import { connectorAccountsInstructions } from '../shared/connector-accounts.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const GMAIL_IMAP = Object.freeze({ host: 'imap.gmail.com', port: 993, secure: true });
const GMAIL_SMTP = Object.freeze({ host: 'smtp.gmail.com', port: 465, secure: true });
const TIMEOUTS = { connectionTimeout: 20_000, greetingTimeout: 15_000, socketTimeout: 60_000 };
const SEARCH_DEFAULT = 10;
const SEARCH_MAX = 25;
const SNIPPET_BYTES = 2048;
const SNIPPET_CHARS = 200;
const LINE_CHARS = 300;
const READ_BYTES = 262_144;
const READ_CHARS = 50_000;

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const clip = (value, max) => (value.length > max ? `${value.slice(0, max)}…` : value);

class ToolInputError extends Error {}

function requireText(args, key) {
  const value = text(args?.[key]);
  if (!value) throw new ToolInputError(`${key} is required`);
  return value;
}

// ── Errors: one fixed sentence per cause, never the password ────────────────
const MESSAGES = {
  REJECTED: 'Google did not accept this address and app password.',
  UNAVAILABLE:
    'Google refused app-password access for this account: app passwords need 2-Step Verification, and a Workspace admin can block them or IMAP.',
  NETWORK: "Couldn't reach Gmail. Check the network connection.",
  MISSING: 'No Gmail app password is saved on this computer. Connect Gmail again with an app password.',
  FAILED: 'Gmail refused the request.',
};

/** `GMAIL_APP_PASSWORD_<CODE>: <sentence>` — the code is what Desktop shows
 *  in the user's language. */
class GmailAppPasswordError extends Error {
  constructor(code, detail = '') {
    super(`GMAIL_APP_PASSWORD_${code}: ${MESSAGES[code]}${detail ? ` (${detail})` : ''}`);
    this.code = code;
  }
}

const redact = (value, password) => (password ? String(value).split(password).join('[redacted]') : String(value));

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  'NoConnection',
  // nodemailer
  'ESOCKET',
  'ECONNECTION',
  'EDNS',
]);
// Gmail's answers when an app password cannot be used here: the account's own
// password was typed (2-Step Verification on), a browser sign-in is demanded,
// or a Workspace admin turned IMAP or app passwords off.
const UNAVAILABLE =
  /application-specific password|web ?login required|WEBALERT|IMAP access is disabled|not enabled for IMAP|domain administrator|5\.7\.9|5\.7\.14/i;
const REJECTED = /AUTHENTICATIONFAILED|Invalid credentials|Username and Password not accepted|5\.7\.8/i;

/** An IMAP/SMTP failure as a GmailAppPasswordError. */
function gmailError(error, password) {
  if (error instanceof GmailAppPasswordError || error instanceof ToolInputError) return error;
  const detail = redact([error?.response, error?.responseText, error?.message].filter(Boolean).join(' '), password);
  const code = String(error?.code || '');
  if (UNAVAILABLE.test(detail) || error?.responseCode === 534) return new GmailAppPasswordError('UNAVAILABLE');
  if (
    error?.authenticationFailed === true ||
    code === 'EAUTH' ||
    error?.responseCode === 535 ||
    REJECTED.test(detail)
  ) {
    return new GmailAppPasswordError('REJECTED');
  }
  if (NETWORK_CODES.has(code)) return new GmailAppPasswordError('NETWORK');
  return new GmailAppPasswordError('FAILED', clip(detail.replace(/\s+/g, ' ').trim(), 200));
}

// ── Clients (tests pass fakes with the same surface) ────────────────────────
const gmailClients = {
  async imap({ email, password }) {
    const { ImapFlow } = await import('imapflow');
    const client = new ImapFlow({
      ...GMAIL_IMAP,
      auth: { user: email, pass: password },
      logger: false,
      disableAutoIdle: true,
      ...TIMEOUTS,
    });
    // A socket failure rejects the pending command; it must never surface as
    // an unhandled 'error' event in the runtime.
    client.on('error', () => {});
    return client;
  },
  async smtp({ email, password }) {
    const { default: nodemailer } = await import('nodemailer');
    return nodemailer.createTransport({
      ...GMAIL_SMTP,
      auth: { user: email, pass: password },
      logger: false,
      debug: false,
      ...TIMEOUTS,
    });
  },
};

/** Runs `work` on a logged-in IMAP connection, closed afterwards. */
async function withImap(ctx, work) {
  const client = await ctx.clients.imap(ctx);
  try {
    await client.connect();
  } catch (error) {
    throw gmailError(error, ctx.password);
  }
  try {
    return await work(client);
  } catch (error) {
    throw gmailError(error, ctx.password);
  } finally {
    await client.logout().catch(() => client.close?.());
  }
}

/** Throws a GmailAppPasswordError unless Gmail accepts the app password over
 *  both IMAP and SMTP. */
export async function verifyGmailAppPassword({ email, password }, clients = gmailClients) {
  const ctx = { email, password, clients };
  await withImap(ctx, async () => {});
  const transport = await clients.smtp(ctx);
  try {
    await transport.verify();
  } catch (error) {
    throw gmailError(error, password);
  } finally {
    transport.close();
  }
}

/** The keychain account of the app password of Gmail address `email`. */
export function gmailAppPasswordSecretAccount(email) {
  return `gmail-app-password.${createHash('sha256').update(gmailAddress(email)).digest('hex')}`;
}

/** Checks the app password with Gmail, then keeps it in the keychain only. */
export async function saveGmailAppPassword(
  email,
  password,
  { clients = gmailClients, credentialStore = keychain } = {}
) {
  await verifyGmailAppPassword({ email, password }, clients);
  await credentialStore.setSecretAsync(gmailAppPasswordSecretAccount(email), password);
}

/** Deletes the stored app password of `email`. */
export async function forgetGmailAppPassword(email, { credentialStore = keychain } = {}) {
  await credentialStore.deleteSecretAsync(gmailAppPasswordSecretAccount(email));
}

// ── Messages ────────────────────────────────────────────────────────────────
const addresses = (list) =>
  (Array.isArray(list) ? list : [])
    .map((entry) => (entry?.name ? `${entry.name} <${entry.address || ''}>` : entry?.address || ''))
    .filter(Boolean)
    .join(', ');
/** The From mailboxes as Gmail parsed them, one entry each; a group shows as
 *  its name with an empty address (imapflow parseEnvelope). */
const mailboxes = (list) =>
  (Array.isArray(list) ? list : []).map((entry) => ({
    name: String(entry?.name || ''),
    address: String(entry?.address || ''),
  }));

const stripComments = (text) => {
  let out = text;
  for (let previous = ''; previous !== out; ) {
    previous = out;
    out = out.replace(/\([^()]*\)/g, ' ');
  }
  return out;
};

/** Gmail's own verdict on the sender, read from the topmost
 *  Authentication-Results only, and only when its authserv-id is Gmail's
 *  (mx.google.com):
 *  - the receiving MTA prepends the field above the trace fields it adds
 *    (RFC 8601 §4, §4.1), so the last receiver's copy is the first one;
 *  - a conforming MTA deletes any copy that arrives bearing its own
 *    authserv-id (RFC 8601 §5), so a sender cannot pass one off as Gmail's;
 *  - Gmail directs other mail clients to this field for its verdict (Gmail
 *    Help, "Check if your Gmail message is authenticated", answer 180707).
 *  A message no MTA delivered — one appended to the mailbox over IMAP — has
 *  only the headers its author wrote; that is the account owner's own mail.
 *  `{ dmarc: { result, from }, dkim: [{ result, domain }] }` (`domain` is a
 *  signature's d= as header.d reports it, RFC 8601 §2.7.1), or null. */
function gmailAuthentication(headers) {
  const unfolded = String(headers || '').replace(/\r?\n[ \t]+/g, ' ');
  const first = /^authentication-results:(.*)$/im.exec(unfolded)?.[1];
  if (!first) return null;
  const [server = '', ...results] = stripComments(first).split(';');
  if (server.trim().split(/\s+/)[0].toLowerCase() !== 'mx.google.com') return null;
  const verdict = { dmarc: null, dkim: [] };
  for (const entry of results) {
    const method = /^\s*([a-z0-9-]+)\s*=\s*([a-z]+)/i.exec(entry);
    if (!method) continue;
    const props = Object.fromEntries(
      [...entry.matchAll(/([a-z]+\.[a-z]+)\s*=\s*("[^"]*"|[^\s;]+)/gi)].map(([, name, value]) => [
        name.toLowerCase(),
        value.replace(/^"|"$/g, '').toLowerCase(),
      ])
    );
    const result = method[2].toLowerCase();
    if (method[1].toLowerCase() === 'dmarc' && !verdict.dmarc)
      verdict.dmarc = { result, from: props['header.from'] || '' };
    // Only the signing domain d= counts toward the From domain (RFC 7489
    // §3.1.1); the agent identity i= is not an alignment identifier.
    if (method[1].toLowerCase() === 'dkim' && props['header.d']) {
      verdict.dkim.push({ result, domain: props['header.d'] });
    }
  }
  return verdict;
}

const isoDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
};

/** All Mail (every label; Spam and Trash are not in it), read-only unless
 *  `readOnly` is false. Returns the mailbox list (its special-use folders). */
async function openAllMail(client, { readOnly = true } = {}) {
  const boxes = await client.list();
  const all = boxes.find((box) => box.specialUse === '\\All');
  await client.mailboxOpen(all?.path || '[Gmail]/All Mail', { readOnly });
  return boxes;
}

const MESSAGE_ID = /^\d{1,20}$/;

/** The UID in All Mail of Gmail message id `id` (X-GM-MSGID), or null. */
async function uidOf(client, id) {
  if (!MESSAGE_ID.test(id)) throw new ToolInputError('id must be an id from search_emails');
  const uids = (await client.search({ emailId: id }, { uid: true })) || [];
  return uids[0] ?? null;
}

const isAttachment = (node) =>
  node.disposition === 'attachment' ||
  String(node.type || '').startsWith('message/') ||
  Boolean(node.dispositionParameters?.filename || node.parameters?.name);

/** The first text/plain and the first text/html part of the message that are
 *  not attachments (part numbers), each null without one. */
function textParts(root) {
  const found = { plain: null, html: null };
  const walk = (node) => {
    if (!node || String(node.type || '').startsWith('message/')) return;
    if (node.childNodes?.length) {
      for (const child of node.childNodes) walk(child);
      return;
    }
    if (node.disposition === 'attachment') return;
    const part = node.part || '1';
    if (node.type === 'text/plain' && !found.plain) found.plain = part;
    if (node.type === 'text/html' && !found.html) found.html = part;
  };
  walk(root);
  return found;
}

/** The text/plain part (else text/html) that is the message's body. */
function bodyPart(root) {
  const { plain, html } = textParts(root);
  if (plain) return { part: plain, html: false };
  return html ? { part: html, html: true } : null;
}

/** Attachments by name, type and (decoded, approximate) size only. */
function attachmentsOf(node, out = []) {
  if (!node) return out;
  if (node.childNodes?.length && !String(node.type || '').startsWith('message/')) {
    for (const child of node.childNodes) attachmentsOf(child, out);
    return out;
  }
  if (isAttachment(node)) {
    const size = Number(node.size) || 0;
    out.push({
      name: node.dispositionParameters?.filename || node.parameters?.name || '(unnamed)',
      type: node.type,
      size: String(node.encoding || '').toLowerCase() === 'base64' ? Math.floor((size * 3) / 4) : size,
    });
  }
  return out;
}

const ENTITIES = { nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', '#39': "'" };
const htmlText = (html) =>
  html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(nbsp|lt|gt|quot|apos|amp|#39);/g, (_, name) => ENTITIES[name])
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n\s*/g, '\n')
    .trim();

/** Up to `maxBytes` of part `part`, decoded to UTF-8; `complete` is false when
 *  the part may go on past them. */
async function partText(client, uid, part, maxBytes) {
  const download = await client.download(String(uid), part, {
    uid: true,
    maxBytes,
    chunkSize: Math.min(maxBytes, 65_536),
  });
  if (!download?.content) return { value: '', complete: true };
  const chunks = [];
  let size = 0;
  for await (const chunk of download.content) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= maxBytes) break;
  }
  return { value: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'), complete: size < maxBytes };
}

/** Up to `maxBytes` of the body text, decoded to UTF-8. */
async function bodyText(client, uid, structure, maxBytes) {
  const picked = bodyPart(structure);
  if (!picked) return '';
  const { value } = await partText(client, uid, picked.part, maxBytes);
  return picked.html ? htmlText(value) : value.trim();
}

let domModule;
const loadDom = () => (domModule ||= import('jsdom'));

/** The targets of an HTML part's hyperlinks (`a` and `area` with href, HTML
 *  Standard §4.6 Links) as the HTML parser reads the attribute, character
 *  references decoded. A tag the download cut off is no element (HTML
 *  tokenization: the eof-in-tag error emits no tag). */
async function htmlLinks(html) {
  if (!html) return [];
  const { JSDOM } = await loadDom();
  const dom = new JSDOM(html);
  try {
    return [...dom.window.document.querySelectorAll('a[href], area[href]')].map((node) => node.getAttribute('href'));
  } finally {
    dom.window.close();
  }
}

// An absolute http(s) URI in plain text as RFC 3986 spells one: the scheme,
// then a run of URI characters — unreserved, reserved or percent-encoded
// (§2.1-§2.3). Whitespace, quotes and angle brackets are no URI characters,
// so they end it (Appendix C).
const TEXT_URI = /https?:\/\/(?:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})+/gi;

const isWebUrl = (value) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

/** The message's link targets, exactly as written: the hyperlinks of its
 *  HTML part, then the URIs of its text part (one the download cut off is
 *  left out). Absolute http(s) only, each once. */
function messageLinks(plain, hrefs) {
  const links = [...hrefs];
  if (plain) {
    for (const match of plain.value.matchAll(TEXT_URI)) {
      if (!plain.complete && match.index + match[0].length === plain.value.length) continue;
      links.push(match[0]);
    }
  }
  return [...new Set(links.filter((link) => typeof link === 'string' && isWebUrl(link)))];
}

const references = (headers) =>
  String(headers || '')
    .replace(/\r?\n[ \t]+/g, ' ')
    .match(/<[^<>\s]+>/g) || [];

/** The Message-ID, References and subject a reply to `value` threads on. */
async function threadOf(ctx, value) {
  if (/^<[^<>\s]+>$/.test(value)) return { messageId: value, references: [value], subject: '' };
  return withImap(ctx, async (client) => {
    await openAllMail(client);
    const uid = await uidOf(client, value);
    const [message] = uid
      ? await client.fetchAll(String(uid), { uid: true, envelope: true, headers: ['references'] }, { uid: true })
      : [];
    const messageId = text(message?.envelope?.messageId);
    if (!messageId) throw new ToolInputError(`No email with id ${value}.`);
    return {
      messageId,
      references: [...references(message.headers).filter((ref) => ref !== messageId), messageId],
      subject: text(message.envelope.subject),
    };
  });
}

const NO_HEADER_BREAKS = /[\r\n]/;

// ── Mailbox management ──────────────────────────────────────────────────────
const MANAGE_MAX = 50;
const LABEL_MAX = 225;

/** The distinct message ids of `args.ids` (an array, or one id). */
function messageIds(args) {
  let raw = [];
  if (Array.isArray(args.ids)) raw = args.ids;
  else if (args.ids != null) raw = [args.ids];
  const ids = [...new Set(raw.map((id) => text(id)))];
  if (!ids.length || ids.some((id) => !id)) throw new ToolInputError('ids must list ids from search_emails');
  if (ids.length > MANAGE_MAX) throw new ToolInputError(`At most ${MANAGE_MAX} emails per call; got ${ids.length}.`);
  return ids;
}

/** A user label name: one line, not a system label (`\\Inbox`, …). */
function labelName(args) {
  const label = requireText(args, 'label');
  if (
    label.length > LABEL_MAX ||
    [...label].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    label.startsWith('\\')
  ) {
    throw new ToolInputError('label must be a plain label name');
  }
  return label;
}

/** Runs `act(client, range, boxes)` on the All Mail UIDs of the message ids
 *  (opened read-write); returns the summary line. */
async function manageEmails(ctx, args, verb, act, extra = () => undefined) {
  const ids = messageIds(args);
  const detail = extra(args);
  return withImap(ctx, async (client) => {
    const boxes = await openAllMail(client, { readOnly: false });
    const uids = [];
    const missing = [];
    for (const id of ids) {
      const uid = await uidOf(client, id);
      if (uid) uids.push(uid);
      else missing.push(id);
    }
    if (!uids.length) throw new ToolInputError(`No email with id ${missing.join(', ')}.`);
    await act(client, uids.join(','), boxes, detail);
    const done = `${verb} ${uids.length} email${uids.length === 1 ? '' : 's'}.`;
    return missing.length ? `${done} Not found: ${missing.join(', ')}.` : done;
  });
}

const idsSchema = {
  type: 'array',
  items: { type: 'string' },
  minItems: 1,
  maxItems: MANAGE_MAX,
  description: `Email ids from search_emails (at most ${MANAGE_MAX}).`,
};
const manageTool = (name, description, verb, act, { label = false, destructive = false } = {}) => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties: {
      ids: idsSchema,
      ...(label ? { label: { type: 'string', description: 'A label name; created when new.' } } : {}),
    },
    required: label ? ['ids', 'label'] : ['ids'],
  },
  annotations: { readOnlyHint: false, destructiveHint: destructive, idempotentHint: true, openWorldHint: true },
  run: (ctx, args) => manageEmails(ctx, args, verb, act, label ? labelName : undefined),
});

const byUid = { uid: true };
const flag = (name, add) => (client, range) =>
  add ? client.messageFlagsAdd(range, [name], byUid) : client.messageFlagsRemove(range, [name], byUid);
const gmailLabel = (add) => (client, range, _boxes, label) =>
  add
    ? client.messageFlagsAdd(range, [label], { ...byUid, useLabels: true })
    : client.messageFlagsRemove(range, [label], { ...byUid, useLabels: true });

const MANAGE_TOOLS = [
  manageTool(
    'archive_emails',
    'Archive emails (remove them from the Inbox; they stay in All Mail).',
    'Archived',
    (client, range) => client.messageFlagsRemove(range, ['\\Inbox'], { ...byUid, useLabels: true })
  ),
  manageTool(
    'trash_emails',
    'Move emails to Gmail Trash (recoverable for 30 days; never a permanent delete).',
    'Moved to Trash:',
    async (client, range, boxes) => {
      const trash = boxes.find((box) => box.specialUse === '\\Trash');
      await client.messageMove(range, trash?.path || '[Gmail]/Trash', byUid);
    },
    { destructive: true }
  ),
  manageTool('add_email_label', 'Add a Gmail label to emails.', 'Labeled', gmailLabel(true), { label: true }),
  manageTool('remove_email_label', 'Remove a Gmail label from emails.', 'Unlabeled', gmailLabel(false), {
    label: true,
  }),
  manageTool('mark_emails_read', 'Mark emails as read.', 'Marked read:', flag('\\Seen', true)),
  manageTool('mark_emails_unread', 'Mark emails as unread.', 'Marked unread:', flag('\\Seen', false)),
  manageTool('star_emails', 'Star emails.', 'Starred', flag('\\Flagged', true)),
  manageTool('unstar_emails', 'Remove the star from emails.', 'Unstarred', flag('\\Flagged', false)),
];

const TOOLS = [
  {
    name: 'send_email',
    description: 'Send a plain-text email from the connected Gmail account.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipients, comma-separated.' },
        subject: { type: 'string', description: 'Empty in a reply: "Re: " and the original subject.' },
        body: { type: 'string' },
        cc: { type: 'string' },
        bcc: { type: 'string' },
        inReplyTo: {
          type: 'string',
          description: 'Reply in the thread of this email: an id from search_emails, or a Message-ID like <…>.',
        },
      },
      required: ['to', 'subject', 'body'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async run(ctx, args) {
      const fields = {
        to: requireText(args, 'to'),
        cc: text(args.cc),
        bcc: text(args.bcc),
        subject: text(args.subject),
      };
      for (const [key, value] of Object.entries(fields)) {
        if (value && NO_HEADER_BREAKS.test(value)) throw new ToolInputError(`${key} must be one line`);
      }
      const message = { from: ctx.email, to: fields.to, subject: fields.subject, text: String(args.body ?? '') };
      if (fields.cc) message.cc = fields.cc;
      if (fields.bcc) message.bcc = fields.bcc;
      const replyTo = text(args.inReplyTo);
      if (replyTo) {
        const original = await threadOf(ctx, replyTo);
        message.inReplyTo = original.messageId;
        message.references = original.references;
        if (!message.subject && original.subject) {
          message.subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
        }
      }
      const transport = await ctx.clients.smtp(ctx);
      try {
        const sent = await transport.sendMail(message);
        return `Sent (message ${sent?.messageId || 'accepted'}).`;
      } catch (error) {
        throw gmailError(error, ctx.password);
      } finally {
        transport.close();
      }
    },
  },
  {
    name: 'search_emails',
    description:
      'Search the Gmail account with Gmail search syntax (from:, subject:, newer_than:7d, has:attachment, label:…), newest first. Spam and Trash are not searched.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search; default in:inbox.' },
        maxResults: { type: 'number', description: `1-${SEARCH_MAX}, default ${SEARCH_DEFAULT}.` },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(ctx, args) {
      const query = text(args.query) || 'in:inbox';
      const limit = Math.min(SEARCH_MAX, Math.max(1, Math.trunc(Number(args.maxResults)) || SEARCH_DEFAULT));
      return withImap(ctx, async (client) => {
        await openAllMail(client);
        const found = (await client.search({ gmraw: query }, { uid: true })) || [];
        const uids = [...found].sort((a, b) => b - a).slice(0, limit);
        if (!uids.length) return 'No emails.';
        const messages = await client.fetchAll(
          uids.join(','),
          { uid: true, envelope: true, internalDate: true, bodyStructure: true, threadId: true },
          { uid: true }
        );
        messages.sort((a, b) => b.uid - a.uid);
        const lines = [];
        for (const message of messages) {
          const snippet = (await bodyText(client, message.uid, message.bodyStructure, SNIPPET_BYTES)).replace(
            /\s+/g,
            ' '
          );
          lines.push(
            JSON.stringify({
              id: message.emailId,
              threadId: message.threadId,
              from: clip(addresses(message.envelope?.from), LINE_CHARS),
              subject: clip(text(message.envelope?.subject), LINE_CHARS),
              date: isoDate(message.envelope?.date || message.internalDate),
              snippet: clip(snippet.trim(), SNIPPET_CHARS),
            })
          );
        }
        if (found.length > uids.length)
          lines.push(`(${uids.length} of ${found.length} shown; narrow the query for others)`);
        return lines.join('\n');
      });
    },
  },
  {
    name: 'read_email',
    description:
      'Read one email by its id from search_emails: headers, text body, link targets, and attachment names and sizes.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(ctx, args) {
      const id = requireText(args, 'id');
      return withImap(ctx, async (client) => {
        await openAllMail(client);
        const uid = await uidOf(client, id);
        const [message] = uid
          ? await client.fetchAll(
              String(uid),
              {
                uid: true,
                envelope: true,
                internalDate: true,
                bodyStructure: true,
                threadId: true,
                headers: ['authentication-results'],
              },
              { uid: true }
            )
          : [];
        if (!message) throw new ToolInputError(`No email with id ${id}.`);
        const { envelope = {} } = message;
        const parts = textParts(message.bodyStructure);
        const plain = parts.plain ? await partText(client, message.uid, parts.plain, READ_BYTES) : null;
        const html = parts.html ? await partText(client, message.uid, parts.html, READ_BYTES) : null;
        let body = '';
        if (plain) body = plain.value.trim();
        else if (html) body = htmlText(html.value);
        const links = messageLinks(plain, await htmlLinks(html?.value));
        const head = {
          id: message.emailId || id,
          threadId: message.threadId,
          messageId: envelope.messageId,
          from: addresses(envelope.from),
          fromAddresses: mailboxes(envelope.from),
          authentication: gmailAuthentication(message.headers),
          to: addresses(envelope.to),
          cc: addresses(envelope.cc) || undefined,
          date: isoDate(envelope.date || message.internalDate),
          subject: text(envelope.subject),
          links,
          attachments: attachmentsOf(message.bodyStructure),
        };
        const clipped = body.length > READ_CHARS ? `${body.slice(0, READ_CHARS)}\n[truncated]` : body;
        return `${JSON.stringify(head)}\n\n${clipped || '(no text body)'}`;
      });
    },
  },
  {
    name: 'describe_emails',
    description:
      'The connected account and the sender, subject and date of emails by id (what an approval card shows). Without ids, only the account.',
    // Callable by the approval gate only: not in tools/list, so never in the model's tool surface.
    hidden: true,
    inputSchema: { type: 'object', properties: { ids: idsSchema } },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(ctx, args) {
      const ids = args.ids == null ? [] : messageIds(args);
      const emails = [];
      if (ids.length) {
        await withImap(ctx, async (client) => {
          await openAllMail(client);
          for (const id of ids) {
            const uid = await uidOf(client, id);
            const [message] = uid
              ? await client.fetchAll(String(uid), { uid: true, envelope: true, internalDate: true }, { uid: true })
              : [];
            if (!message) continue;
            emails.push({
              id,
              from: clip(addresses(message.envelope?.from), LINE_CHARS),
              subject: clip(text(message.envelope?.subject), LINE_CHARS),
              date: isoDate(message.envelope?.date || message.internalDate),
            });
          }
        });
      }
      return JSON.stringify({ account: ctx.email, emails });
    },
  },
  ...MANAGE_TOOLS,
];

/** The tool definitions (name, description, schema, annotations) the server
 *  lists: never the ones only the approval gate calls. */
export function gmailAppPasswordTools() {
  return TOOLS.filter((tool) => !tool.hidden).map(({ run, hidden: _hidden, ...tool }) => tool);
}

// ── The MCP server at the reserved address ──────────────────────────────────
const GMAIL_HOST = new URL(GMAIL_APP_PASSWORD.url).host;

/** The URL when it addresses the Gmail app-password server, else null. */
export function gmailAppPasswordService(input) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    return null;
  }
  return url.protocol === 'https:' && url.host === GMAIL_HOST ? url : null;
}

const textResult = (value) => ({ content: [{ type: 'text', text: value }] });
const errorResult = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

async function rpc(session, message) {
  const { id, method, params } = message || {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') {
    if (!(await session.password())) {
      return { jsonrpc: '2.0', id, error: { code: -32001, message: new GmailAppPasswordError('MISSING').message } };
    }
    return reply({
      protocolVersion: text(params?.protocolVersion) || PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'mixdog-gmail-app-password', version: '1.0.0' },
      instructions: connectorAccountsInstructions([{ email: session.email }]),
    });
  }
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: gmailAppPasswordTools() });
  if (method === 'tools/call') {
    const tool = TOOLS.find((candidate) => candidate.name === params?.name);
    if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } };
    const password = await session.password();
    if (!password) return reply(errorResult(new GmailAppPasswordError('MISSING').message));
    const ctx = { email: session.email, password, clients: session.clients };
    try {
      return reply(textResult(redact(await tool.run(ctx, params?.arguments || {}), password)));
    } catch (error) {
      return reply(errorResult(redact(error?.message || String(error), password)));
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

async function answer(url, init, { credentialStore, clients }) {
  if (url.pathname !== '/mcp') return json(404, { error: 'not_found' });
  if (String(init?.method || 'GET').toUpperCase() !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }
  let message;
  try {
    message = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body));
  } catch {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const email = gmailAddress(new Headers(init?.headers).get(GMAIL_APP_PASSWORD.accountHeader));
  let stored;
  const session = {
    email,
    clients,
    password: () => {
      stored ??= email
        ? credentialStore.getSecretAsync(gmailAppPasswordSecretAccount(email)).then((value) => value || '')
        : Promise.resolve('');
      return stored;
    },
  };
  const batch = Array.isArray(message) ? message : [message];
  const replies = (await Promise.all(batch.map((one) => (one?.id === undefined ? null : rpc(session, one))))).filter(
    Boolean
  );
  if (!replies.length) return new Response(null, { status: 202 });
  return json(200, Array.isArray(message) ? replies : replies[0]);
}

/** A `fetch` that answers the Gmail app-password server in-process and sends
 *  every other request to `next`. */
export function withGmailAppPasswordMcp({ credentialStore = keychain, clients = gmailClients } = {}, next = fetch) {
  return (input, init) => {
    const url = gmailAppPasswordService(input instanceof Request ? input.url : input);
    return url
      ? answer(
          url,
          input instanceof Request ? { method: input.method, headers: input.headers, body: init?.body } : init,
          { credentialStore, clients }
        )
      : next(input, init);
  };
}
