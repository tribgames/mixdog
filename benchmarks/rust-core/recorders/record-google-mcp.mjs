#!/usr/bin/env node
// Recording of connectors/google-mcp.test.mjs (b6f10295a): what the built-in Google connectors (Gmail, Google Calendar, Google
// Drive) answer at their reserved address (`https://<service>.mixdog.invalid/mcp`) and which REST calls their tools make.
// Each case is a script of requests to `withGoogleMcp(upstream)` and the replies the stand-in Google gives in order; recorded are
// every reply (status, the headers a client reads, body text) and every call that reached Google (url, method, authorization,
// content-type, body). The address classification of `googleMcpService` is recorded as a table.
//
//   node benchmarks/rust-core/recorders/record-google-mcp.mjs --tree <export of b6f10295a with node_modules>
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'google-mcp-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const { openSet } = await import('./lib/case-set.mjs');

const set = openSet('google-mcp', import.meta.url);
// `new Date()` reads the real clock whatever `Date.now` says: the connector's default `timeMin` is the current time.
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [RealDate.now()]));
  }
};
const { googleMcpService, googleMcpUrl, withGoogleMcp } = await set.load('src/runtime/connectors/google-mcp.mjs');

/** Plays `requests` against the connector with `upstream` (replies in order) standing for Google. */
async function play(requests, upstream) {
  const queue = [...upstream];
  const calls = [];
  const forwarded = [];
  const fetchImpl = withGoogleMcp(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method || 'GET', authorization: init.headers?.authorization ?? null, contentType: init.headers?.['content-type'] ?? null, body: init.body === undefined ? null : String(init.body) });
    const next = queue.shift();
    if (!next) throw new Error(`no stand-in reply for ${url}`);
    return next.status === 204 ? new Response(null, { status: 204 }) : new Response(next.body, { status: next.status });
  });
  const responses = [];
  for (const request of requests) {
    const response = await fetchImpl(request.url, { method: request.method, headers: request.authorization ? { authorization: request.authorization } : {}, ...(request.body === undefined ? {} : { body: request.body }) });
    responses.push({ status: response.status, allow: response.headers.get('allow'), wwwAuthenticate: response.headers.get('www-authenticate'), contentType: response.headers.get('content-type'), body: await response.text() });
  }
  return { responses, calls, unused: queue.length, forwarded };
}

const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const post = (service, body, authorization = 'Bearer t1', query = '') => ({ url: `${googleMcpUrl(service)}${query}`, method: 'POST', authorization, body });
const call = (service, name, args, id = 1) => post(service, rpc(id, 'tools/call', { name, arguments: args }));
const ok = (value) => ({ status: 200, body: JSON.stringify(value) });
const record = (name, requests, upstream) => set.run(name, () => play(requests, upstream), { input: { requests, upstream } });

await set.run('the address classification', () => ({
  urls: [
    googleMcpUrl('gmail'), 'https://evil.mixdog.invalid/mcp', 'https://gmailmcp.googleapis.com/mcp/v1', 'http://gmail.mixdog.invalid/mcp',
    `${googleMcpUrl('gmail')}?account=gmail-2`, 'https://calendar.mixdog.invalid/x', 'https://drive.mixdog.invalid', 'not a url',
  ].map((url) => ({ url, service: googleMcpService(url) ? new URL(url).hostname.split('.')[0] : null })),
}), {});

await record('the address answers like a protected remote MCP server', [
  { url: 'https://gmail.mixdog.invalid/.well-known/oauth-protected-resource/mcp', method: 'GET' },
  { url: 'https://calendar.mixdog.invalid/.well-known/oauth-protected-resource', method: 'GET' },
  { url: googleMcpUrl('gmail'), method: 'POST', body: '{}' },
  { url: googleMcpUrl('gmail'), method: 'POST', authorization: 'Basic abc', body: '{}' },
  { url: googleMcpUrl('gmail'), method: 'GET', authorization: 'Bearer t1' },
  { url: 'https://drive.mixdog.invalid/other', method: 'POST', authorization: 'Bearer t1', body: '{}' },
  post('drive', 'not json'),
  post('drive', rpc(1, 'bogus', {})),
  post('drive', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })),
  post('drive', JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 2, method: 'ping' }])),
  post('drive', rpc(3, 'tools/call', { name: 'nothing', arguments: {} })),
], []);

for (const service of ['gmail', 'calendar', 'drive']) {
  await record(`${service} initializes, lists its tools and pings`, [
    post(service, rpc(1, 'initialize', { protocolVersion: '2025-03-26' })),
    post(service, rpc(2, 'initialize', {})),
    post(service, rpc(3, 'tools/list', {})),
    post(service, rpc(4, 'ping')),
  ], [ok({ email: 'a@x.com' }), ok({}), ]);
}
await record('an account that Google no longer accepts is answered 401', [post('gmail', rpc(1, 'initialize', {}))], [{ status: 400, body: '{}' }]);
await record('a second account has its own URL and tokens', [
  post('gmail', rpc(1, 'initialize', {}), 'Bearer t1'),
  post('gmail', rpc(1, 'initialize', {}), 'Bearer t2', '?account=gmail-2'),
  post('gmail', rpc(2, 'tools/list', {}), 'Bearer t2', '?account=gmail-2'),
], [ok({ email: 'a@x.com' }), ok({ email: 'b@x.com' })]);

await record('Gmail sends through the Gmail API and refuses a header break', [
  call('gmail', 'send_email', { to: 'a@example.com', subject: '안녕', body: 'Hello' }),
  call('gmail', 'send_email', { to: 'a@example.com', cc: 'c@example.com', bcc: 'd@example.com', subject: 's', body: '' }),
  call('gmail', 'send_email', { to: 'a@example.com\r\nBcc: x@example.com', subject: 's', body: 'b' }),
  call('gmail', 'send_email', { to: 'a@example.com', subject: 'line\nbreak', body: 'b' }),
  call('gmail', 'send_email', { subject: 's', body: 'b' }),
  call('gmail', 'send_email', { to: '  a@example.com  ', subject: ' s ', body: 12 }),
], [ok({ id: 'm1' }), ok({ id: 'm2' }), ok({ id: 'm3' })]);

await record('Calendar tools call their REST API with the bearer token', [
  call('calendar', 'list_events', { query: 'standup' }),
  call('calendar', 'list_events', { timeMin: '2026-01-01T00:00:00Z', timeMax: '2026-02-01T00:00:00Z', maxResults: 500 }),
  call('calendar', 'list_events', { maxResults: 0 }),
  call('calendar', 'list_events', {}),
  call('calendar', 'create_event', { summary: 'Lunch', start: '2026-10-20T12:00:00', end: '2026-10-20T13:00:00', timeZone: 'Asia/Seoul', location: 'Cafe', attendees: [' a@x.com ', '', 'b@x.com'], description: 'd' }),
  call('calendar', 'create_event', { summary: 'Holiday', start: '2026-10-21', end: '2026-10-22' }),
  call('calendar', 'create_event', { summary: 'x' }),
  call('calendar', 'update_event', { eventId: 'e/1', summary: 'Renamed' }),
  call('calendar', 'update_event', {}),
  call('calendar', 'delete_event', { eventId: 'e1' }),
], [
  ok({ items: [{ id: 'e1', summary: 'Standup', start: { dateTime: '2026-10-20T09:00:00Z' }, end: { date: '2026-10-21' }, htmlLink: 'https://l', attendees: [{ email: 'z@x.com' }, {}] }] }),
  ok({ items: [] }), ok({}), ok({ items: [{ id: 'e2' }] }),
  ok({ id: 'e3', summary: 'Lunch', start: { dateTime: '2026-10-20T12:00:00' }, end: { dateTime: '2026-10-20T13:00:00' } }),
  ok({ id: 'e4', start: { date: '2026-10-21' } }),
  ok({ id: 'e1', summary: 'Renamed' }),
  { status: 204 },
]);

const doc = { id: 'f1', name: 'Plan', mimeType: 'application/vnd.google-apps.document' };
await record('Drive tools call their REST API with the bearer token', [
  call('drive', 'search_files', { query: "o'neil" }),
  call('drive', 'search_files', { query: 'a\\b', pageSize: 3 }),
  call('drive', 'search_files', {}),
  call('drive', 'read_file', { fileId: 'f1' }),
  call('drive', 'read_file', { fileId: 'sheet' }),
  call('drive', 'read_file', { fileId: 'txt/1' }),
  call('drive', 'read_file', { fileId: 'bin' }),
  call('drive', 'read_file', { fileId: 'long' }),
  call('drive', 'read_file', {}),
  call('drive', 'create_file', { name: 'Notes', content: 'hi' }),
  call('drive', 'create_file', { name: 'Doc', content: 'x', asGoogleDoc: true, folderId: 'fold', mimeType: 'text/markdown' }),
  call('drive', 'create_file', { content: 'x' }),
], [
  ok({ files: [{ id: 'f1', name: 'Plan' }] }), ok({ files: [] }), ok({ files: [{ id: 'f2' }, { id: 'f3' }] }),
  ok(doc), { status: 200, body: 'Plan body' },
  ok({ id: 'sheet', mimeType: 'application/vnd.google-apps.spreadsheet' }), { status: 200, body: 'a,b\n1,2' },
  ok({ id: 'txt', mimeType: 'application/json' }), { status: 200, body: '{"a":1}' },
  ok({ id: 'bin', mimeType: 'image/png' }),
  ok({ id: 'long', mimeType: 'text/plain' }), { status: 200, body: `${'a'.repeat(100_000)}tail` },
  ok({ id: 'f2', name: 'Notes' }), ok({ id: 'f3', name: 'Doc' }),
]);

await record('Google refusing the token, failing or answering badly', [
  call('calendar', 'list_events', {}),
  call('calendar', 'delete_event', { eventId: 'e1' }),
  call('drive', 'search_files', {}),
  call('gmail', 'send_email', { to: 'a@x.com', subject: 's', body: 'b' }),
], [{ status: 401, body: '{}' }, { status: 403, body: JSON.stringify({ error: { message: 'Insufficient Permission' } }) }, { status: 500, body: 'oops' }, { status: 500, body: JSON.stringify({ error: {} }) }]);

await set.finish({
  entry: 'connectors/google-mcp.mjs withGoogleMcp(next) over scripted requests, with `next` standing for Google (replies in order); googleMcpService over a table of addresses',
  replay: { entry: 'google_mcp::answer over the recorded requests with a stand-in GoogleFetch that replays the recorded Google replies in order (now_ms = the recorded clock); compares each reply (status, allow, www-authenticate, content-type, body) and each call that reached Google; google_mcp::service over the address table; one case through HttpTransport', normalised: {} },
  exclusions: { 'the end-to-end sign-in and send (google-mcp.test.mjs :198)': 'the MCP OAuth flow itself is replayed by its own sets; the transport case replays the connector end of it' },
});
process.exit(0);
