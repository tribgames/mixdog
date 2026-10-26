import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { parseEnvelope } from 'imapflow/lib/tools.js';

import { _registerMcpServerForTest, disconnectAll } from '../agent/orchestrator/mcp/client.mjs';
import { dispatchToolCall } from '../agent/orchestrator/session/loop/tool-exec/dispatch.mjs';
import { withGmailAppPasswordMcp } from '../connectors/gmail-app-password.mjs';
import { GMAIL_APP_PASSWORD } from '../shared/connector-catalog.mjs';
import { MAIL_LINK_WINDOW_MS, mailLinkFor, recordMailLinks } from './mail-links.mjs';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImRldkB0cmliZ2FtZXMuY29tIn0.c2lnbmF0dXJlLW9mLXRoZS1zaXRl';
const LINK = `https://alternativeto.net/api/auth/verify-email?token=${JWT}&callbackURL=https%3A%2F%2Falternativeto.net%2F`;
// The text part as the site's template escaped it.
const ESCAPED = LINK.replaceAll('&', '&amp;').replaceAll('=', '&#x3D;');

// ENVELOPE address fields as an IMAP server sends them ([name, adl, mailbox,
// host]); imapflow's own parser makes the envelope the connector reads.
const atom = (value) => (value == null ? null : { value });
const box = (name, mailbox, host) => [atom(name), null, atom(mailbox), atom(host)];
const SITE = box('AlternativeTo', 'support', 'alternativeto.net');
const SITE_AUTH =
  'Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@alternativeto.net header.s=s1 header.b=AbCd;\r\n' +
  '       spf=pass (google.com: domain of b@em.alternativeto.net designates 192.0.2.1 as permitted sender) smtp.mailfrom=b@em.alternativeto.net;\r\n' +
  '       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=alternativeto.net\r\n';

// The site's mail as its template writes it: both parts carry the escaping.
const SITE_PARTS = {
  text: `Confirm your e-mail:\n${ESCAPED}\n\nThanks.`,
  html: `<p>Confirm your e-mail:</p><p><a href="${ESCAPED}" class="button">Confirm</a></p>`,
};

/** The result the built-in connector's read_email gives for one message with
 *  From `from`, the header block `authentication` and body `parts` (a text
 *  part's text, or `{ text?, html? }`). */
async function readEmail(from, authentication, parts = SITE_PARTS) {
  const { text, html } = typeof parts === 'string' ? { text: parts } : parts;
  const leaves = [
    ...(text == null ? [] : [{ type: 'text/plain', part: '1', body: text }]),
    ...(html == null ? [] : [{ type: 'text/html', part: '2', body: html }]),
  ];
  const message = {
    uid: 1,
    emailId: '9001',
    threadId: 't1',
    envelope: parseEnvelope([
      atom('Sun, 25 Oct 2026 18:00:00 +0000'),
      atom('Confirm your e-mail'),
      from,
      null,
      null,
      [box(null, 'dev', 'tribgames.com')],
      null,
      null,
      null,
      atom('<m1@alternativeto.net>'),
    ]),
    bodyStructure: {
      type: 'multipart/alternative',
      childNodes: leaves.map(({ type, part }) => ({ type, part })),
    },
    headers: Buffer.from(authentication),
  };
  const imap = async () => ({
    connect: async () => {},
    list: async () => [{ path: '[Gmail]/All Mail', specialUse: '\\All' }],
    mailboxOpen: async () => {},
    search: async () => [1],
    fetchAll: async () => [message],
    // As the server sends a part: at most maxBytes of it.
    download: async (_uid, part, { maxBytes }) => {
      const body = Buffer.from(leaves.find((leaf) => leaf.part === part).body).subarray(0, maxBytes);
      return { content: Readable.from([body]) };
    },
    logout: async () => {},
  });
  const credentialStore = { getSecretAsync: async () => 'abcdwxyzabcdwxyz' };
  const fetchImpl = withGmailAppPasswordMcp({ credentialStore, clients: { imap } }, () => {
    throw new Error('nothing leaves for the network');
  });
  const response = await fetchImpl(GMAIL_APP_PASSWORD.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [GMAIL_APP_PASSWORD.accountHeader]: 'dev@tribgames.com' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'read_email', arguments: { id: '9001' } },
    }),
  });
  const { result } = await response.json();
  assert.equal(result.isError, undefined, result.content[0].text);
  return result.content[0].text;
}
const SITE_MAIL = await readEmail([SITE], SITE_AUTH);

test("only the built-in Gmail connector's read_email records a mail's links, for the session that read it", async (t) => {
  const scopeId = 'mail-links-dispatch';
  t.after(() => disconnectAll({ scopeId }));
  const callTool = async () => ({ content: [{ type: 'text', text: SITE_MAIL }] });
  _registerMcpServerForTest(scopeId, 'gmail', [{ name: 'read_email' }, { name: 'search_emails' }], {
    cfg: {
      type: 'http',
      url: GMAIL_APP_PASSWORD.url,
      headers: { [GMAIL_APP_PASSWORD.accountHeader]: 'dev@tribgames.com' },
      connector: 'gmail',
    },
    callTool,
  });
  // Another server answering the same text, even one marked as the Gmail connector.
  _registerMcpServerForTest(scopeId, 'webmail', [{ name: 'read_email' }], {
    cfg: { type: 'http', url: 'https://mail.example.test/mcp', connector: 'gmail' },
    callTool,
  });
  const call = (name, session) =>
    dispatchToolCall(
      { name, args: { id: '9001' } },
      { callerSessionId: session, sessionRef: { mcpScopeId: scopeId }, executeOpts: {} }
    );

  assert.equal(await call('mcp__webmail__read_email', 'sess-webmail'), SITE_MAIL);
  assert.equal(mailLinkFor('sess-webmail', LINK), null, "another server's text is never provenance");
  assert.equal(await call('mcp__gmail__search_emails', 'sess-search'), SITE_MAIL);
  assert.equal(mailLinkFor('sess-search', LINK), null, 'a search snippet is not a read mail');

  const before = Date.now();
  assert.equal(await call('mcp__gmail__read_email', 'sess-reader'), SITE_MAIL, 'the result is unchanged');
  const link = mailLinkFor('sess-reader', LINK);
  assert.equal(link?.url, LINK, "the hyperlink's target, as the HTML parser decodes the attribute");
  assert.equal(link.from_domain, 'alternativeto.net');
  assert.ok(link.read_at >= before && link.read_at <= Date.now());
  assert.equal(mailLinkFor('sess-other', LINK), null, 'another session never has it');
  assert.equal(mailLinkFor('sess-reader', `${LINK}&next=%2Fadmin`), null, 'only the exact link');
  assert.equal(mailLinkFor('sess-reader', LINK.slice(0, -3)), null, 'nor a shortened one');
});

test('the links are the exact targets the mail writes: HTML hyperlinks and RFC 3986 URIs in text', async () => {
  const head = JSON.parse(SITE_MAIL.split('\n\n')[0]);
  // The text part's URI runs on through the escaping, which is all URI characters.
  assert.deepEqual(head.links, [LINK, ESCAPED]);

  // A URI in text ends only where URI characters end: sentence punctuation is
  // one of them, a quote or an angle bracket is not.
  const text = `Confirm here: ${LINK}.\nOr <${LINK}&step=2> or "${LINK}&step=3"`;
  const html =
    '<a href="/relative">x</a><a href="mailto:a@b.example">y</a><a href=\'http://alternativeto.net/x\'>z</a>';
  const mail = await readEmail([SITE], SITE_AUTH, { text, html });
  assert.deepEqual(JSON.parse(mail.split('\n\n')[0]).links, [
    'http://alternativeto.net/x',
    `${LINK}.`,
    `${LINK}&step=2`,
    `${LINK}&step=3`,
  ]);
  recordMailLinks('sess-exact', mail);
  assert.equal(mailLinkFor('sess-exact', LINK), null, 'the text wrote it with the period');
  assert.equal(mailLinkFor('sess-exact', `${LINK}.`)?.url, `${LINK}.`);
  assert.equal(mailLinkFor('sess-exact', `${LINK}&step=2`)?.from_domain, 'alternativeto.net');
  assert.equal(mailLinkFor('sess-exact', 'http://alternativeto.net/x'), null, 'http is never offered');

  // A URI the download cut off is not the mail's link.
  const cut = `https://alternativeto.net/api/auth/verify-email?token=${JWT}`;
  const long = await readEmail([SITE], SITE_AUTH, `${'x'.repeat(262_144 - 40)} ${cut}`);
  assert.deepEqual(JSON.parse(long.split('\n\n')[0]).links, []);
});

test('a link is offered only while recent and over https', async () => {
  recordMailLinks('sess-old', SITE_MAIL, Date.now() - MAIL_LINK_WINDOW_MS - 1_000);
  assert.equal(mailLinkFor('sess-old', LINK), null, 'past the window');

  const plain = LINK.replace('https:', 'http:');
  recordMailLinks('sess-http', await readEmail([SITE], SITE_AUTH, `Open ${plain}`));
  assert.equal(mailLinkFor('sess-http', plain), null);

  const bare = box(null, 'support', 'alternativeto.net');
  recordMailLinks('sess-bare', await readEmail([bare], SITE_AUTH, `Confirm here:\n${LINK}\n`));
  assert.equal(mailLinkFor('sess-bare', LINK)?.from_domain, 'alternativeto.net', 'a bare address');
});

test('only a single From mailbox that Gmail authenticated counts, however the header is written', async () => {
  const VICTIM_LINK = `https://victim.example/verify?token=${JWT}`;
  const victim = box('Victim', 'support', 'victim.example');
  const attacker = box(null, 'attacker', 'evil.example');
  const ar = (results) => `Authentication-Results: mx.google.com;\r\n       ${results}\r\n`;
  const victimDmarc = ar('dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=victim.example');
  const linkOf = async (session, from, authentication) => {
    recordMailLinks(session, await readEmail(from, authentication, `Verify: ${VICTIM_LINK}`));
    return mailLinkFor(session, VICTIM_LINK);
  };

  assert.equal((await linkOf('sess-dmarc', [victim], victimDmarc))?.from_domain, 'victim.example');
  const signed = ar('dkim=pass header.d=mail.victim.example header.s=s1; spf=softfail smtp.mailfrom=x@relay.example');
  assert.equal(
    (await linkOf('sess-dkim', [victim], signed))?.from_domain,
    'victim.example',
    'DKIM d= on its Organizational Domain (relaxed alignment)'
  );

  // A display name encoded to read like the site's address is only a name.
  const disguised = [
    atom(`=?UTF-8?B?${Buffer.from('support@victim.example').toString('base64')}?=`),
    null,
    atom('attacker'),
    atom('evil.example'),
  ];
  const evilAuth = ar('dkim=pass header.i=@evil.example; dmarc=pass header.from=evil.example');
  const head = JSON.parse((await readEmail([disguised], evilAuth)).split('\n\n')[0]);
  assert.deepEqual(head.fromAddresses, [{ name: 'support@victim.example', address: 'attacker@evil.example' }]);
  assert.equal((await linkOf('sess-disguised', [disguised], evilAuth))?.from_domain, 'evil.example');

  const refused = [
    ['a bare then a named address', [attacker, victim], victimDmarc],
    ['a named then a bare address', [victim, attacker], victimDmarc],
    [
      'a group',
      [[null, null, atom('Victim'), null], box(null, 'support', 'victim.example'), [null, null, null, null]],
      victimDmarc,
    ],
    ['an encoded name with a verdict for the name', [disguised], victimDmarc],
    ['DMARC fail', [victim], ar('dkim=fail header.d=victim.example; dmarc=fail (p=REJECT) header.from=victim.example')],
    ['DMARC none', [victim], ar('spf=pass smtp.mailfrom=victim.example; dmarc=none header.from=victim.example')],
    ['DKIM d= on another domain', [victim], ar('dkim=pass header.d=evil.example header.i=@evil.example')],
    ['DKIM with only an i= identity', [victim], ar('dkim=pass header.i=@victim.example header.s=s1')],
    ['DKIM on a lookalike suffix', [victim], ar('dkim=pass header.d=victim.example.evil.example')],
    ['no Authentication-Results', [victim], 'References: <a@example.test>\r\n'],
    ['a verdict from another server', [victim], victimDmarc.replace('mx.google.com', 'mx.evil.example')],
    ['a pass below Gmail’s own fail', [victim], ar('dmarc=fail header.from=victim.example') + victimDmarc],
  ];
  for (const [index, [why, from, authentication]] of refused.entries()) {
    assert.equal(await linkOf(`sess-refused-${index}`, from, authentication), null, why);
  }
});
