// Gmail with an app password: the in-process MCP server and its IMAP/SMTP
// tools against scripted clients, the login checks and their error causes,
// and the keychain-only password.
import '../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GMAIL_APP_PASSWORD, gmailAppPasswordServerInput } from '../shared/connector-catalog.mjs';
import {
  forgetGmailAppPassword,
  gmailAppPasswordSecretAccount,
  gmailAppPasswordService,
  saveGmailAppPassword,
  verifyGmailAppPassword,
  withGmailAppPasswordMcp,
} from './gmail-app-password.mjs';

const EMAIL = 'me@gmail.com';
const PASSWORD = 'abcdwxyzabcdwxyz';
const ACCOUNT_HEADERS = { [GMAIL_APP_PASSWORD.accountHeader]: EMAIL };

function memoryStore(entries = []) {
  const values = new Map(entries);
  return {
    values,
    getSecretAsync: async (key) => values.get(key) ?? null,
    setSecretAsync: async (key, value) => {
      values.set(key, value);
    },
    deleteSecretAsync: async (key) => {
      values.delete(key);
    },
  };
}

const storeWithPassword = () => memoryStore([[gmailAppPasswordSecretAccount(EMAIL), PASSWORD]]);

function message(uid, over = {}) {
  return {
    uid,
    emailId: String(9000 + uid),
    threadId: `t${uid}`,
    envelope: {
      from: [{ name: 'Kim', address: 'kim@example.com' }],
      to: [{ address: EMAIL }],
      subject: `Hello ${uid}`,
      date: new Date(Date.UTC(2026, 0, uid)),
      messageId: `<m${uid}@example.com>`,
    },
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain' },
        {
          part: '2',
          type: 'application/pdf',
          disposition: 'attachment',
          dispositionParameters: { filename: 'report.pdf' },
          encoding: 'base64',
          size: 4000,
        },
      ],
    },
    parts: { 1: `Body ${uid} ${'x'.repeat(5000)}`, 2: 'PDF-CONTENT-NEVER-SHOWN' },
    headers: Buffer.from('References: <a@example.com>\r\n <b@example.com>\r\n'),
    ...over,
  };
}

/** A scripted IMAP server: every call it saw, the messages it holds. */
function fakeImap({ messages = [], fail = null } = {}) {
  const seen = { logins: [], searches: [], fetches: [], downloads: [], opened: [], logouts: 0, changes: [] };
  const imap = async (ctx) => {
    seen.logins.push({ email: ctx.email, password: ctx.password });
    return {
      async connect() {
        if (fail) throw fail;
      },
      async list() {
        return [
          { path: 'INBOX' },
          { path: '[Gmail]/전체보관함', specialUse: '\\All' },
          { path: '[Gmail]/휴지통', specialUse: '\\Trash' },
        ];
      },
      async messageFlagsAdd(range, flags, options) {
        seen.changes.push({ op: 'add', range, flags, options });
        return true;
      },
      async messageFlagsRemove(range, flags, options) {
        seen.changes.push({ op: 'remove', range, flags, options });
        return true;
      },
      async messageMove(range, destination, options) {
        seen.changes.push({ op: 'move', range, destination, options });
        return { destination };
      },
      async mailboxOpen(path, options) {
        seen.opened.push([path, options]);
      },
      async search(query, options) {
        seen.searches.push({ query, options });
        const found = query.emailId ? messages.filter((m) => m.emailId === query.emailId) : messages;
        return found.map((m) => m.uid);
      },
      async fetchAll(range, query, options) {
        seen.fetches.push({ range, query, options });
        const uids = String(range).split(',').map(Number);
        return messages.filter((m) => uids.includes(m.uid)).map(({ parts, ...m }) => m);
      },
      async download(uid, part, options) {
        seen.downloads.push({ uid, part, options });
        const body = messages.find((m) => m.uid === Number(uid))?.parts[part] ?? '';
        return { meta: {}, content: Readable.from([Buffer.from(body).subarray(0, options.maxBytes)]) };
      },
      async logout() {
        seen.logouts += 1;
      },
    };
  };
  return { imap, seen };
}

function fakeSmtp({ fail = null } = {}) {
  const seen = { sent: [], verified: 0, closed: 0 };
  const smtp = async () => ({
    async verify() {
      if (fail) throw fail;
      seen.verified += 1;
    },
    async sendMail(mail) {
      if (fail) throw fail;
      seen.sent.push(mail);
      return { messageId: '<sent@gmail.com>' };
    },
    close() {
      seen.closed += 1;
    },
  });
  return { smtp, seen };
}

function server({ messages, imapFail, smtpFail, credentialStore = storeWithPassword() } = {}) {
  const imap = fakeImap({ messages, fail: imapFail });
  const smtp = fakeSmtp({ fail: smtpFail });
  const fetchImpl = withGmailAppPasswordMcp({ credentialStore, clients: { imap: imap.imap, smtp: smtp.smtp } }, () => {
    throw new Error('nothing leaves for the network');
  });
  const call = async (name, args = {}, headers = ACCOUNT_HEADERS) => {
    const response = await fetchImpl(GMAIL_APP_PASSWORD.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const { result } = await response.json();
    return { ...result, text: result.content.map((part) => part.text).join('\n') };
  };
  return { fetchImpl, call, imap: imap.seen, smtp: smtp.seen };
}

test('the reserved address is the only one answered, and the real MCP client connects through it', async (t) => {
  assert.ok(gmailAppPasswordService(GMAIL_APP_PASSWORD.url));
  assert.equal(gmailAppPasswordService('https://gmail.mixdog.invalid/mcp'), null, 'the OAuth Gmail stays separate');
  assert.equal(gmailAppPasswordService('http://gmail-imap.mixdog.invalid/mcp'), null);
  const forwarded = [];
  const fetchImpl = withGmailAppPasswordMcp({ credentialStore: storeWithPassword(), clients: {} }, async (input) => {
    forwarded.push(String(input));
    return new Response('ok');
  });
  await fetchImpl('https://example.com/x');
  assert.deepEqual(forwarded, ['https://example.com/x']);

  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(GMAIL_APP_PASSWORD.url), {
      requestInit: { headers: ACCOUNT_HEADERS },
      fetch: fetchImpl,
    })
  );
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.annotations.readOnlyHint]),
    [
      ['send_email', false],
      ['search_emails', true],
      ['read_email', true],
      ['archive_emails', false],
      ['trash_emails', false],
      ['add_email_label', false],
      ['remove_email_label', false],
      ['mark_emails_read', false],
      ['mark_emails_unread', false],
      ['star_emails', false],
      ['unstar_emails', false],
    ]
  );
});

test('mailbox tools use Gmail IMAP semantics on All Mail, opened read-write', async () => {
  const { call, imap } = server({ messages: [message(1), message(2)] });
  const ids = ['9001', '9002'];
  const last = () => imap.changes.at(-1);

  assert.equal((await call('archive_emails', { ids })).text, 'Archived 2 emails.');
  assert.deepEqual(imap.opened.at(-1), ['[Gmail]/전체보관함', { readOnly: false }]);
  assert.deepEqual(last(), { op: 'remove', range: '1,2', flags: ['\\Inbox'], options: { uid: true, useLabels: true } });

  assert.equal((await call('add_email_label', { ids: ['9001'], label: 'Work/2026' })).text, 'Labeled 1 email.');
  assert.deepEqual(last(), { op: 'add', range: '1', flags: ['Work/2026'], options: { uid: true, useLabels: true } });
  await call('remove_email_label', { ids: '9002', label: 'Work/2026' });
  assert.deepEqual(last(), { op: 'remove', range: '2', flags: ['Work/2026'], options: { uid: true, useLabels: true } });

  await call('mark_emails_read', { ids });
  assert.deepEqual(last(), { op: 'add', range: '1,2', flags: ['\\Seen'], options: { uid: true } });
  await call('mark_emails_unread', { ids });
  assert.deepEqual(last(), { op: 'remove', range: '1,2', flags: ['\\Seen'], options: { uid: true } });
  await call('star_emails', { ids });
  assert.deepEqual(last(), { op: 'add', range: '1,2', flags: ['\\Flagged'], options: { uid: true } });
  await call('unstar_emails', { ids });
  assert.deepEqual(last(), { op: 'remove', range: '1,2', flags: ['\\Flagged'], options: { uid: true } });

  // Trash is the SPECIAL-USE folder (localized name), moved to, never expunged.
  assert.equal((await call('trash_emails', { ids })).text, 'Moved to Trash: 2 emails.');
  assert.deepEqual(last(), { op: 'move', range: '1,2', destination: '[Gmail]/휴지통', options: { uid: true } });
  assert.equal(
    imap.changes.some((change) => change.flags?.includes('\\Deleted')),
    false
  );
});

test('mailbox tools report unknown ids and refuse bad input before connecting', async () => {
  const { call, imap } = server({ messages: [message(1)] });
  const partial = await call('star_emails', { ids: ['9001', '12345'] });
  assert.equal(partial.text, 'Starred 1 email. Not found: 12345.');
  const none = await call('star_emails', { ids: ['12345'] });
  assert.equal(none.isError, true);
  const logins = imap.logins.length;
  for (const args of [
    { ids: [] },
    {},
    { ids: ['abc'] },
    { ids: Array.from({ length: 51 }, (_, index) => String(9000 + index)) },
  ]) {
    const result = await call('mark_emails_read', args);
    assert.equal(result.isError, true, JSON.stringify(args).slice(0, 40));
  }
  for (const label of ['', '\\Inbox', 'a\nb']) {
    assert.equal((await call('add_email_label', { ids: ['9001'], label })).isError, true, JSON.stringify(label));
  }
  assert.ok(imap.logins.length <= logins + 1, 'only the malformed-id lookup may connect');
});

test('without a stored app password the server does not initialize, and no client is made', async () => {
  const { fetchImpl, call, imap } = server({ credentialStore: memoryStore() });
  const response = await fetchImpl(GMAIL_APP_PASSWORD.url, {
    method: 'POST',
    headers: ACCOUNT_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  const { error } = await response.json();
  assert.match(error.message, /^GMAIL_APP_PASSWORD_MISSING: /);
  const result = await call('search_emails', {});
  assert.equal(result.isError, true);
  assert.match(result.text, /GMAIL_APP_PASSWORD_MISSING/);
  assert.equal(imap.logins.length, 0);
});

test('send_email builds the message, threads a reply, and refuses header breaks before SMTP', async () => {
  const { call, smtp, imap } = server({ messages: [message(7)] });
  const sent = await call('send_email', {
    to: 'a@example.com, b@example.com',
    cc: 'c@example.com',
    bcc: 'd@example.com',
    subject: '안녕',
    body: 'Hello\nthere',
  });
  assert.equal(sent.isError, undefined);
  assert.equal(sent.text, 'Sent (message <sent@gmail.com>).');
  assert.deepEqual(smtp.sent[0], {
    from: EMAIL,
    to: 'a@example.com, b@example.com',
    cc: 'c@example.com',
    bcc: 'd@example.com',
    subject: '안녕',
    text: 'Hello\nthere',
  });
  assert.equal(imap.logins.length, 0, 'a plain send never opens IMAP');

  // A reply by search id: the original's Message-ID and References, "Re: …".
  await call('send_email', { to: 'kim@example.com', subject: '', body: 'Thanks', inReplyTo: '9007' });
  const reply = smtp.sent[1];
  assert.equal(reply.inReplyTo, '<m7@example.com>');
  assert.deepEqual(reply.references, ['<a@example.com>', '<b@example.com>', '<m7@example.com>']);
  assert.equal(reply.subject, 'Re: Hello 7');
  assert.deepEqual(imap.searches.at(-1).query, { emailId: '9007' });
  assert.deepEqual(imap.opened.at(-1), ['[Gmail]/전체보관함', { readOnly: true }]);
  // A raw Message-ID threads without IMAP.
  await call('send_email', { to: 'kim@example.com', subject: 'Re: x', body: 'b', inReplyTo: '<raw@example.com>' });
  assert.equal(smtp.sent[2].inReplyTo, '<raw@example.com>');
  assert.deepEqual(smtp.sent[2].references, ['<raw@example.com>']);

  const injected = await call('send_email', { to: 'a@example.com\r\nBcc: x@example.com', subject: 's', body: 'b' });
  assert.equal(injected.isError, true);
  const subjectBreak = await call('send_email', { to: 'a@example.com', subject: 's\nBcc: x', body: 'b' });
  assert.equal(subjectBreak.isError, true);
  assert.equal(smtp.sent.length, 3, 'a header break is refused before Gmail is called');
  const unknown = await call('send_email', { to: 'a@example.com', subject: '', body: 'b', inReplyTo: '1' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /No email with id 1/);
});

test('search_emails runs the Gmail query, bounds the count and the snippets, newest first', async () => {
  const messages = Array.from({ length: 40 }, (_, index) => message(index + 1));
  const { call, imap } = server({ messages });
  const result = await call('search_emails', { query: 'from:kim newer_than:7d', maxResults: 500 });
  assert.equal(result.isError, undefined);
  assert.deepEqual(imap.searches[0], { query: { gmraw: 'from:kim newer_than:7d' }, options: { uid: true } });
  const lines = result.text.split('\n');
  assert.equal(lines.length, 26, 'at most 25 emails and the overflow note');
  assert.equal(lines.at(-1), '(25 of 40 shown; narrow the query for others)');
  const first = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(first), ['id', 'threadId', 'from', 'subject', 'date', 'snippet']);
  assert.equal(first.id, '9040', 'newest first');
  assert.equal(first.from, 'Kim <kim@example.com>');
  assert.equal(first.date, '2026-02-09T00:00:00.000Z');
  assert.ok(first.snippet.startsWith('Body 40 xxx'));
  assert.ok(first.snippet.length <= 201, 'a snippet is bounded');
  assert.ok(imap.downloads.every((download) => download.options.maxBytes === 2048 && download.part === '1'));
  assert.equal(imap.logouts, 1);
  assert.doesNotMatch(result.text, /PDF-CONTENT/);

  const fallback = await call('search_emails', {});
  assert.deepEqual(imap.searches.at(-1).query, { gmraw: 'in:inbox' });
  assert.equal(fallback.text.split('\n').length, 11, 'ten by default, plus the note');
});

test('read_email returns headers, a bounded text body and attachments by name and size only', async () => {
  const long = message(3, { parts: { 1: 'y'.repeat(80_000), 2: 'PDF-CONTENT-NEVER-SHOWN' } });
  const html = message(4, {
    bodyStructure: { type: 'text/html' },
    parts: { 1: '<html><style>p{}</style><p>Hi &amp; bye</p><br><b>Kim</b></html>' },
  });
  const { call, imap } = server({ messages: [long, html] });
  const read = await call('read_email', { id: '9003' });
  assert.equal(read.isError, undefined);
  const [head, ...rest] = read.text.split('\n\n');
  const meta = JSON.parse(head);
  assert.equal(meta.subject, 'Hello 3');
  assert.equal(meta.messageId, '<m3@example.com>');
  assert.deepEqual(meta.attachments, [{ name: 'report.pdf', type: 'application/pdf', size: 3000 }]);
  const body = rest.join('\n\n');
  assert.ok(body.endsWith('\n[truncated]'));
  assert.equal(body.length, 50_000 + '\n[truncated]'.length);
  assert.equal(imap.downloads.at(-1).options.maxBytes, 262_144);
  assert.doesNotMatch(read.text, /PDF-CONTENT/, 'attachment content is never read');

  const htmlRead = await call('read_email', { id: '9004' });
  assert.match(htmlRead.text, /\n\nHi & bye\nKim$/, 'an HTML-only body is read as text');
  assert.equal(imap.downloads.at(-1).part, '1', 'a single-part message is part 1');

  assert.equal((await call('read_email', { id: '42' })).isError, true);
  assert.equal((await call('read_email', { id: 'x OR 1' })).isError, true);
});

test('describe_emails gives the account and each message sender, subject and date; ids unknown to Gmail are skipped', async () => {
  const { call, imap } = server({ messages: [message(1), message(2)] });
  const described = JSON.parse((await call('describe_emails', { ids: ['9001', '9002', '777'] })).text);
  assert.equal(described.account, EMAIL);
  assert.deepEqual(described.emails, [
    { id: '9001', from: 'Kim <kim@example.com>', subject: 'Hello 1', date: '2026-01-01T00:00:00.000Z' },
    { id: '9002', from: 'Kim <kim@example.com>', subject: 'Hello 2', date: '2026-01-02T00:00:00.000Z' },
  ]);
  assert.equal(imap.changes.length, 0, 'it only reads');
  const bare = server({ messages: [] });
  assert.deepEqual(JSON.parse((await bare.call('describe_emails')).text), { account: EMAIL, emails: [] });
  assert.equal(bare.imap.logins.length, 0, 'the account alone needs no Gmail login');
});

test('the app password never appears in a tool result, even when Gmail echoes it', async () => {
  const echo = message(1, {
    envelope: { ...message(1).envelope, subject: `about ${PASSWORD}` },
    parts: { 1: `the password is ${PASSWORD}` },
  });
  const { call } = server({ messages: [echo] });
  for (const result of [await call('search_emails', {}), await call('read_email', { id: '9001' })]) {
    assert.doesNotMatch(result.text, new RegExp(PASSWORD));
    assert.match(result.text, /\[redacted\]/);
  }
  const failing = server({ imapFail: Object.assign(new Error(`weird ${PASSWORD} failure`), { code: 'EWEIRD' }) });
  const failed = await failing.call('search_emails', {});
  assert.equal(failed.isError, true);
  assert.match(failed.text, /^GMAIL_APP_PASSWORD_FAILED: /);
  assert.doesNotMatch(failed.text, new RegExp(PASSWORD));
});

test('a login is checked over IMAP and SMTP, and each failure names its cause', async () => {
  const clients = (imapFail, smtpFail) => ({
    imap: fakeImap({ fail: imapFail }).imap,
    smtp: fakeSmtp({ fail: smtpFail }).smtp,
  });
  const verify = (imapFail, smtpFail) =>
    verifyGmailAppPassword({ email: EMAIL, password: PASSWORD }, clients(imapFail, smtpFail));
  await verify();
  const imapAuth = Object.assign(new Error('Command failed'), {
    authenticationFailed: true,
    response: 'NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)',
  });
  await assert.rejects(verify(imapAuth), /^Error: GMAIL_APP_PASSWORD_REJECTED: /);
  const asp = Object.assign(new Error('Command failed'), {
    authenticationFailed: true,
    response: 'NO [ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833',
  });
  await assert.rejects(verify(asp), /GMAIL_APP_PASSWORD_UNAVAILABLE/);
  const workspace = Object.assign(new Error('Command failed'), {
    response: 'NO [ALERT] IMAP access is disabled for your domain. Please contact your domain administrator.',
  });
  await assert.rejects(verify(workspace), /GMAIL_APP_PASSWORD_UNAVAILABLE/);
  await assert.rejects(
    verify(Object.assign(new Error('getaddrinfo ENOTFOUND imap.gmail.com'), { code: 'ENOTFOUND' })),
    /GMAIL_APP_PASSWORD_NETWORK/
  );
  const smtpAuth = Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), {
    code: 'EAUTH',
    responseCode: 535,
  });
  await assert.rejects(verify(null, smtpAuth), /GMAIL_APP_PASSWORD_REJECTED/);
  await assert.rejects(
    verify(null, Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' })),
    /GMAIL_APP_PASSWORD_NETWORK/
  );
});

test('the app password is stored in the keychain only after Gmail accepted it, and removed on forget', async () => {
  const input = gmailAppPasswordServerInput('gmail', ' Me@Gmail.com ', 'abcd wxyz abcd wxyz');
  assert.deepEqual(input.headers, { [GMAIL_APP_PASSWORD.accountHeader]: EMAIL });
  assert.equal(input.appPassword, PASSWORD, 'spaces are stripped');
  assert.equal(input.connector, 'gmail');
  assert.throws(() => gmailAppPasswordServerInput('gmail', 'nope', PASSWORD), /GMAIL_APP_PASSWORD_ADDRESS/);
  assert.throws(() => gmailAppPasswordServerInput('gmail', EMAIL, 'short'), /GMAIL_APP_PASSWORD_FORMAT/);

  const store = memoryStore();
  const account = gmailAppPasswordSecretAccount(EMAIL);
  assert.match(account, /^gmail-app-password\.[0-9a-f]{64}$/);
  assert.equal(gmailAppPasswordSecretAccount('ME@gmail.com'), account);
  const rejected = Object.assign(new Error('x'), { authenticationFailed: true });
  await assert.rejects(
    saveGmailAppPassword(EMAIL, PASSWORD, {
      credentialStore: store,
      clients: { imap: fakeImap({ fail: rejected }).imap, smtp: fakeSmtp().smtp },
    }),
    /REJECTED/
  );
  assert.equal(store.values.size, 0, 'a rejected password is never stored');
  const smtp = fakeSmtp();
  await saveGmailAppPassword(EMAIL, PASSWORD, {
    credentialStore: store,
    clients: { imap: fakeImap().imap, smtp: smtp.smtp },
  });
  assert.deepEqual([...store.values], [[account, PASSWORD]]);
  assert.equal(smtp.seen.verified, 1);
  assert.equal(smtp.seen.closed, 1);
  await forgetGmailAppPassword(EMAIL, { credentialStore: store });
  assert.equal(store.values.size, 0);
});

test('two Gmail accounts side by side: each server uses its own password and names its account to the model', async () => {
  const OTHER = 'work@gmail.com';
  const OTHER_PASSWORD = 'zyxwabcdzyxwabcd';
  const credentialStore = memoryStore([
    [gmailAppPasswordSecretAccount(EMAIL), PASSWORD],
    [gmailAppPasswordSecretAccount(OTHER), OTHER_PASSWORD],
  ]);
  const { fetchImpl, call, imap } = server({ messages: [message(1)], credentialStore });
  const rpc = async (email, method, params = {}) => {
    const response = await fetchImpl(GMAIL_APP_PASSWORD.url, {
      method: 'POST',
      headers: { [GMAIL_APP_PASSWORD.accountHeader]: email },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await response.json()).result;
  };
  for (const email of [EMAIL, OTHER]) {
    const init = await rpc(email, 'initialize', {});
    assert.match(init.instructions, new RegExp(`^Account: ${email.replace('.', '\\.')}\\. `));
    assert.match(init.instructions, /ask which account/);
    const { tools } = await rpc(email, 'tools/list');
    assert.ok(tools.every((tool) => tool.description.endsWith(`(Gmail account: ${email})`)));
  }
  await call('search_emails', {}, { [GMAIL_APP_PASSWORD.accountHeader]: EMAIL });
  await call('archive_emails', { ids: ['9001'] }, { [GMAIL_APP_PASSWORD.accountHeader]: OTHER });
  assert.deepEqual(imap.logins, [
    { email: EMAIL, password: PASSWORD },
    { email: OTHER, password: OTHER_PASSWORD },
  ]);
});
