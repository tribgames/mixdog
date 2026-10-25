// Mixdog's built-in Google connectors (Gmail, Google Calendar, Google Drive):
// a small MCP server answered in-process at a reserved address
// (https://<service>.mixdog.invalid/mcp, RFC 2606: never resolvable, so no
// request or token can leave for it). It is an ordinary remote MCP server to
// the client, so the existing MCP OAuth sign-in applies unchanged: the
// protected-resource metadata names Google as the authorization server, the
// sign-in runs with Mixdog's pre-registered Desktop client (PKCE S256, state,
// loopback redirect, access_type=offline; mcp/oauth-client.mjs), the tokens
// live in the keychain, and each MCP request carries the access token, which
// this server spends on the Gmail / Calendar / Drive REST APIs.

import { connectorAccountsInstructions } from '../shared/connector-accounts.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const ORIGIN_SUFFIX = '.mixdog.invalid';
const GOOGLE_ISSUER = 'https://accounts.google.com';
const READ_CAP = 100_000;

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const textResult = (value) => ({ content: [{ type: 'text', text: value }] });
const errorResult = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

class GoogleUnauthorized extends Error {}
class ToolInputError extends Error {}

function requireText(args, key) {
  const value = text(args?.[key]);
  if (!value) throw new ToolInputError(`${key} is required`);
  return value;
}

/** One Google REST call with the user's access token. */
async function google({ token, fetchImpl }, url, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body && !headers['content-type'] ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: typeof body === 'string' || body == null ? body : JSON.stringify(body),
  });
  if (response.status === 401) throw new GoogleUnauthorized();
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error?.message || `Google answered ${response.status}`);
  }
  if (raw) return response;
  return response.status === 204 ? null : response.json();
}

// ── Gmail (gmail.send) ──────────────────────────────────────────────────────
const NO_HEADER_BREAKS = /[\r\n]/;
const encodedWord = (value) => `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;

function mimeMessage({ to, cc, bcc, subject, body }) {
  for (const [key, value] of Object.entries({ to, cc, bcc, subject })) {
    if (value && NO_HEADER_BREAKS.test(value)) throw new ToolInputError(`${key} must be one line`);
  }
  const lines = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : '',
    bcc ? `Bcc: ${bcc}` : '',
    `Subject: ${encodedWord(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);
  return `${lines.join('\r\n')}\r\n\r\n${Buffer.from(body, 'utf8').toString('base64')}`;
}

const GMAIL_TOOLS = [
  {
    name: 'send_email',
    description: 'Send a plain-text email from the signed-in Gmail account.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipients, comma-separated.' },
        subject: { type: 'string' },
        body: { type: 'string' },
        cc: { type: 'string' },
        bcc: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async run(token, args) {
      const raw = Buffer.from(
        mimeMessage({
          to: requireText(args, 'to'),
          cc: text(args.cc),
          bcc: text(args.bcc),
          subject: text(args.subject),
          body: String(args.body ?? ''),
        })
      ).toString('base64url');
      const sent = await google(token, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        body: { raw },
      });
      return `Sent (message ${sent.id}).`;
    },
  },
];

// ── Google Calendar (calendar.events) ───────────────────────────────────────
const EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function when(value, timeZone) {
  const at = text(value);
  if (!at) return undefined;
  if (DATE_ONLY.test(at)) return { date: at };
  return { dateTime: at, ...(timeZone ? { timeZone } : {}) };
}

function eventBody(args) {
  const timeZone = text(args.timeZone);
  const body = {
    summary: text(args.summary) || undefined,
    description: typeof args.description === 'string' ? args.description : undefined,
    location: text(args.location) || undefined,
    start: when(args.start, timeZone),
    end: when(args.end, timeZone),
    attendees: Array.isArray(args.attendees)
      ? args.attendees.map((email) => ({ email: text(email) })).filter((row) => row.email)
      : undefined,
  };
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

const eventLine = (event) =>
  JSON.stringify({
    id: event.id,
    summary: event.summary,
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    location: event.location,
    attendees: event.attendees?.map((row) => row.email),
    link: event.htmlLink,
  });

const EVENT_FIELDS = {
  summary: { type: 'string' },
  start: { type: 'string', description: 'RFC 3339 date-time, or YYYY-MM-DD for all day.' },
  end: { type: 'string', description: 'RFC 3339 date-time, or YYYY-MM-DD (exclusive) for all day.' },
  timeZone: { type: 'string', description: 'IANA zone, e.g. Asia/Seoul.' },
  description: { type: 'string' },
  location: { type: 'string' },
  attendees: { type: 'array', items: { type: 'string' }, description: 'Guest emails.' },
};

const CALENDAR_TOOLS = [
  {
    name: 'list_events',
    description: 'List or search events on the primary calendar.',
    inputSchema: {
      type: 'object',
      properties: {
        timeMin: { type: 'string', description: 'RFC 3339; default now.' },
        timeMax: { type: 'string', description: 'RFC 3339.' },
        query: { type: 'string', description: 'Free-text search.' },
        maxResults: { type: 'number', description: '1-100, default 25.' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(token, args) {
      const params = new URLSearchParams({
        singleEvents: 'true',
        orderBy: 'startTime',
        timeMin: text(args.timeMin) || new Date().toISOString(),
        maxResults: String(Math.min(100, Math.max(1, Number(args.maxResults) || 25))),
      });
      if (text(args.timeMax)) params.set('timeMax', text(args.timeMax));
      if (text(args.query)) params.set('q', text(args.query));
      const list = await google(token, `${EVENTS}?${params}`);
      const items = list.items || [];
      return items.length ? items.map(eventLine).join('\n') : 'No events.';
    },
  },
  {
    name: 'create_event',
    description: 'Create an event on the primary calendar.',
    inputSchema: { type: 'object', properties: EVENT_FIELDS, required: ['summary', 'start', 'end'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async run(token, args) {
      requireText(args, 'summary');
      requireText(args, 'start');
      requireText(args, 'end');
      return eventLine(await google(token, EVENTS, { method: 'POST', body: eventBody(args) }));
    },
  },
  {
    name: 'update_event',
    description: 'Change fields of an event on the primary calendar.',
    inputSchema: {
      type: 'object',
      properties: { eventId: { type: 'string' }, ...EVENT_FIELDS },
      required: ['eventId'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async run(token, args) {
      const id = encodeURIComponent(requireText(args, 'eventId'));
      return eventLine(await google(token, `${EVENTS}/${id}`, { method: 'PATCH', body: eventBody(args) }));
    },
  },
  {
    name: 'delete_event',
    description: 'Delete an event from the primary calendar.',
    inputSchema: { type: 'object', properties: { eventId: { type: 'string' } }, required: ['eventId'] },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async run(token, args) {
      const id = encodeURIComponent(requireText(args, 'eventId'));
      await google(token, `${EVENTS}/${id}`, { method: 'DELETE' });
      return 'Deleted.';
    },
  },
];

// ── Google Drive (drive.file: files this app created or the user opened with it)
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,webViewLink';
const EXPORT_AS = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};
const TEXT_LIKE = /^text\/|^application\/(?:json|xml|javascript|x-yaml|csv)/;
const quoteQuery = (value) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const DRIVE_TOOLS = [
  {
    name: 'search_files',
    description: 'List or search Drive files Mixdog can see (ones it created or you opened with it).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words in the file name.' },
        pageSize: { type: 'number', description: '1-100, default 25.' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(token, args) {
      const terms = ['trashed = false'];
      if (text(args.query)) terms.push(`name contains '${quoteQuery(text(args.query))}'`);
      const params = new URLSearchParams({
        q: terms.join(' and '),
        fields: `files(${FILE_FIELDS})`,
        orderBy: 'modifiedTime desc',
        pageSize: String(Math.min(100, Math.max(1, Number(args.pageSize) || 25))),
      });
      const list = await google(token, `${DRIVE}?${params}`);
      const files = list.files || [];
      return files.length ? files.map((file) => JSON.stringify(file)).join('\n') : 'No files.';
    },
  },
  {
    name: 'read_file',
    description: 'Read a Drive file as text (Docs, Sheets as CSV, Slides, text files).',
    inputSchema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(token, args) {
      const id = encodeURIComponent(requireText(args, 'fileId'));
      const meta = await google(token, `${DRIVE}/${id}?fields=${FILE_FIELDS}`);
      const exportAs = EXPORT_AS[meta.mimeType];
      let url = '';
      if (exportAs) url = `${DRIVE}/${id}/export?mimeType=${encodeURIComponent(exportAs)}`;
      else if (TEXT_LIKE.test(meta.mimeType || '')) url = `${DRIVE}/${id}?alt=media`;
      if (!url) return `${JSON.stringify(meta)}\n(Not a text file; open it at the link.)`;
      const body = await (await google(token, url, { raw: true })).text();
      const clipped = body.length > READ_CAP ? `${body.slice(0, READ_CAP)}\n[truncated]` : body;
      return `${JSON.stringify(meta)}\n\n${clipped}`;
    },
  },
  {
    name: 'create_file',
    description: 'Create a text file (or a Google Doc) in Drive.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        content: { type: 'string' },
        mimeType: { type: 'string', description: 'Default text/plain.' },
        asGoogleDoc: { type: 'boolean', description: 'Convert to a Google Doc.' },
        folderId: { type: 'string' },
      },
      required: ['name', 'content'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async run(token, args) {
      const metadata = {
        name: requireText(args, 'name'),
        ...(args.asGoogleDoc === true ? { mimeType: 'application/vnd.google-apps.document' } : {}),
        ...(text(args.folderId) ? { parents: [text(args.folderId)] } : {}),
      };
      const boundary = `mixdog-${Date.now().toString(36)}`;
      const body = [
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify(metadata),
        `--${boundary}`,
        `Content-Type: ${text(args.mimeType) || 'text/plain'}; charset=UTF-8`,
        '',
        String(args.content ?? ''),
        `--${boundary}--`,
        '',
      ].join('\r\n');
      const file = await google(
        token,
        `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${FILE_FIELDS}`,
        {
          method: 'POST',
          body,
          headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        }
      );
      return JSON.stringify(file);
    },
  },
];

const SERVICES = {
  gmail: { name: 'Gmail', tools: GMAIL_TOOLS },
  calendar: { name: 'Google Calendar', tools: CALENDAR_TOOLS },
  drive: { name: 'Google Drive', tools: DRIVE_TOOLS },
};

/** The tool definitions (name, description, schema, annotations) of built-in
 *  Google service `service` (`gmail`, `calendar`, `drive`). */
export function googleMcpTools(service) {
  return (SERVICES[service]?.tools || []).map(({ run, ...tool }) => tool);
}

/** The reserved MCP address of built-in Google service `service`. */
export function googleMcpUrl(service) {
  return `https://${service}${ORIGIN_SUFFIX}/mcp`;
}

/** The built-in service a URL addresses, or null. */
export function googleMcpService(input) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith(ORIGIN_SUFFIX)) return null;
  return Object.hasOwn(SERVICES, url.hostname.slice(0, -ORIGIN_SUFFIX.length)) ? url : null;
}

const bearerOf = (headers) => /^Bearer\s+(\S+)$/i.exec(headers.get('authorization') || '')?.[1] || '';

/** `{ ok, email }`: whether Google still accepts `token` (an expired or
 *  revoked one is not), and the account it was issued for ('' when unnamed). */
async function tokenInfo({ token, fetchImpl }) {
  const response = await fetchImpl(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
  if (!response.ok) return { ok: false, email: '' };
  const info = await response.json().catch(() => null);
  return { ok: true, email: text(info?.email) };
}

async function rpc(service, token, message) {
  const { id, method, params } = message || {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') {
    const info = await tokenInfo(token);
    if (!info.ok) throw new GoogleUnauthorized();
    return reply({
      protocolVersion: text(params?.protocolVersion) || PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: `mixdog-${service.key}`, version: '1.0.0' },
      // The one account this sign-in is (the connector's accounts server reads it back).
      instructions: connectorAccountsInstructions([{ email: info.email }]),
    });
  }
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: googleMcpTools(service.key) });
  if (method === 'tools/call') {
    const tool = service.tools.find((candidate) => candidate.name === params?.name);
    if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } };
    try {
      return reply(textResult(await tool.run(token, params?.arguments || {})));
    } catch (error) {
      if (error instanceof GoogleUnauthorized) throw error;
      return reply(errorResult(error?.message || String(error)));
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

/** Answers a request to a built-in Google service like a remote MCP server. */
async function answer(url, init, fetchImpl) {
  const key = url.hostname.slice(0, -ORIGIN_SUFFIX.length);
  const service = { key, ...SERVICES[key] };
  const resource = googleMcpUrl(key);
  const metadataUrl = `https://${url.hostname}/.well-known/oauth-protected-resource/mcp`;
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
    return json(200, { resource, authorization_servers: [GOOGLE_ISSUER], bearer_methods_supported: ['header'] });
  }
  if (url.pathname !== '/mcp') return json(404, { error: 'not_found' });
  const method = String(init?.method || 'GET').toUpperCase();
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  const unauthorized = () =>
    json(401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` });
  const bearer = bearerOf(new Headers(init?.headers));
  if (!bearer) return unauthorized();
  const token = { token: bearer, fetchImpl };
  let message;
  try {
    message = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body));
  } catch {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const batch = Array.isArray(message) ? message : [message];
  try {
    const replies = (
      await Promise.all(batch.map((one) => (one?.id === undefined ? null : rpc(service, token, one))))
    ).filter(Boolean);
    if (!replies.length) return new Response(null, { status: 202 });
    return json(200, Array.isArray(message) ? replies : replies[0]);
  } catch (error) {
    if (error instanceof GoogleUnauthorized) return unauthorized();
    throw error;
  }
}

/** A `fetch` that answers the built-in Google services in-process and sends
 *  every other request (Google's sign-in and token endpoints) to `next`. */
export function withGoogleMcp(next = fetch) {
  return (input, init) => {
    const url = googleMcpService(input instanceof Request ? input.url : input);
    return url
      ? answer(
          url,
          input instanceof Request ? { method: input.method, headers: input.headers, body: init?.body } : init,
          next
        )
      : next(input, init);
  };
}
