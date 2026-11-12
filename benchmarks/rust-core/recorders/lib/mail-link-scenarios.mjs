// The cases of src/runtime/browser-bridge/mail-links.test.mjs and apps/desktop/src/main/browser/mail-link-navigation.test.mjs
// (b6f10295a), as functions of the modules they drive (the recorder passes the Node tree's). Each case is a list of operations in
// the order Node ran them, with Node's answer to each: `record` (a read_email result handed to recordMailLinks), `dispatch` (a
// tool call through dispatchToolCall to a registered server), `probe` (mailLinkFor) and `navigate` (the browser tool's navigate
// through executeBrowserTool to the desktop bridge, with the command the bridge received). The read_email results are the text
// Node's own Gmail connector (connectors/gmail-app-password.mjs) answered for each scripted message, recorded whole as inputs.
// The test's token is a JWT; the recording keeps the same shape of link (a `token` query value, which the desktop refuses) without
// a secret-shaped string in the set.
const JWT = 'dG9rZW4tdmFsdWUtZm9yLXRoZS1yZWNvcmRpbmc-0123456789';
const LINK = `https://alternativeto.net/api/auth/verify-email?token=${JWT}&callbackURL=https%3A%2F%2Falternativeto.net%2F`;
// The text part as the site's template escaped it.
const ESCAPED = LINK.replaceAll('&', '&amp;').replaceAll('=', '&#x3D;');

// ENVELOPE address fields as an IMAP server sends them ([name, adl, mailbox, host]).
const atom = (value) => (value == null ? null : { value });
const box = (name, mailbox, host) => [atom(name), null, atom(mailbox), atom(host)];
const SITE = box('AlternativeTo', 'support', 'alternativeto.net');
const SITE_AUTH =
  'Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@alternativeto.net header.s=s1 header.b=AbCd;\r\n' +
  '       spf=pass (google.com: domain of b@em.alternativeto.net designates 192.0.2.1 as permitted sender) smtp.mailfrom=b@em.alternativeto.net;\r\n' +
  '       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=alternativeto.net\r\n';
const SITE_PARTS = {
  text: `Confirm your e-mail:\n${ESCAPED}\n\nThanks.`,
  html: `<p>Confirm your e-mail:</p><p><a href="${ESCAPED}" class="button">Confirm</a></p>`,
};

export function mailLinkScenarios({ Readable, parseEnvelope, withGmailAppPasswordMcp, GMAIL_APP_PASSWORD, recordMailLinks, mailLinkFor, MAIL_LINK_WINDOW_MS, registerServer, disconnectAll, dispatchToolCall, withBridge }) {
  /** The result the built-in connector's read_email gives for one message with From `from`, the header block `authentication` and body `parts`. */
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
      envelope: parseEnvelope([atom('Sun, 25 Oct 2026 18:00:00 +0000'), atom('Confirm your e-mail'), from, null, null, [box(null, 'dev', 'tribgames.com')], null, null, null, atom('<m1@alternativeto.net>')]),
      bodyStructure: { type: 'multipart/alternative', childNodes: leaves.map(({ type, part }) => ({ type, part })) },
      headers: Buffer.from(authentication),
    };
    const imap = async () => ({
      connect: async () => {},
      list: async () => [{ path: '[Gmail]/All Mail', specialUse: '\\All' }],
      mailboxOpen: async () => {},
      search: async () => [1],
      fetchAll: async () => [message],
      download: async (_uid, part, { maxBytes }) => ({ content: Readable.from([Buffer.from(leaves.find((leaf) => leaf.part === part).body).subarray(0, maxBytes)]) }),
      logout: async () => {},
    });
    const fetchImpl = withGmailAppPasswordMcp({ credentialStore: { getSecretAsync: async () => 'abcdwxyzabcdwxyz' }, clients: { imap } }, () => {
      throw new Error('nothing leaves for the network');
    });
    const response = await fetchImpl(GMAIL_APP_PASSWORD.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [GMAIL_APP_PASSWORD.accountHeader]: 'dev@tribgames.com' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_email', arguments: { id: '9001' } } }),
    });
    const { result } = await response.json();
    if (result.isError !== undefined) throw new Error(`recorder: read_email failed: ${result.content[0].text}`);
    return result.content[0].text;
  }

  const log = () => {
    const ops = [];
    return {
      ops,
      record(session, mail, at = Date.now()) {
        recordMailLinks(session, mail, at);
        ops.push({ op: 'record', session, mail, at });
      },
      probe(session, url, why) {
        const link = mailLinkFor(session, url);
        ops.push({ op: 'probe', session, url, at: Date.now(), why, link });
        return link;
      },
    };
  };
  const JWT_LINK = (host) => `https://${host}/verify?token=${JWT}`;

  return {
    "only the built-in Gmail connector's read_email records a mail's links, for the session that read it": async () => {
      const SITE_MAIL = await readEmail([SITE], SITE_AUTH);
      const scopeId = 'mail-links-dispatch';
      const callTool = async () => ({ content: [{ type: 'text', text: SITE_MAIL }] });
      const servers = {
        gmail: { type: 'http', url: GMAIL_APP_PASSWORD.url, headers: { [GMAIL_APP_PASSWORD.accountHeader]: 'dev@tribgames.com' }, connector: 'gmail' },
        // Another server answering the same text, even one marked as the Gmail connector.
        webmail: { type: 'http', url: 'https://mail.example.test/mcp', connector: 'gmail' },
      };
      registerServer(scopeId, 'gmail', [{ name: 'read_email' }, { name: 'search_emails' }], { cfg: servers.gmail, callTool });
      registerServer(scopeId, 'webmail', [{ name: 'read_email' }], { cfg: servers.webmail, callTool });
      const { ops, probe } = log();
      try {
        for (const [name, session] of [['mcp__webmail__read_email', 'sess-webmail'], ['mcp__gmail__search_emails', 'sess-search'], ['mcp__gmail__read_email', 'sess-reader']]) {
          const returned = await dispatchToolCall({ name, args: { id: '9001' } }, { callerSessionId: session, sessionRef: { mcpScopeId: scopeId }, executeOpts: {} });
          ops.push({ op: 'dispatch', name, session, result: returned, at: Date.now() });
          probe(session, LINK, 'after the call');
        }
        probe('sess-other', LINK, 'another session never has it');
        probe('sess-reader', `${LINK}&next=%2Fadmin`, 'only the exact link');
        probe('sess-reader', LINK.slice(0, -3), 'nor a shortened one');
      } finally {
        await disconnectAll({ scopeId });
      }
      return { servers, ops };
    },

    'the links are the exact targets the mail writes: HTML hyperlinks and RFC 3986 URIs in text': async () => {
      const { ops, record, probe } = log();
      const SITE_MAIL = await readEmail([SITE], SITE_AUTH);
      const connectorLinks = [JSON.parse(SITE_MAIL.split('\n\n')[0]).links];
      const text = `Confirm here: ${LINK}.\nOr <${LINK}&step=2> or "${LINK}&step=3"`;
      const html = '<a href="/relative">x</a><a href="mailto:a@b.example">y</a><a href=\'http://alternativeto.net/x\'>z</a>';
      const mail = await readEmail([SITE], SITE_AUTH, { text, html });
      connectorLinks.push(JSON.parse(mail.split('\n\n')[0]).links);
      record('sess-exact', mail);
      probe('sess-exact', LINK, 'the text wrote it with the period');
      probe('sess-exact', `${LINK}.`, 'with the period');
      probe('sess-exact', `${LINK}&step=2`, 'angle brackets end a URI');
      probe('sess-exact', 'http://alternativeto.net/x', 'http is never offered');
      probe('sess-exact', `  ${LINK}.\n`, 'the URL is trimmed');
      probe('sess-exact', `HTTPS://AlternativeTo.net${LINK.slice('https://alternativeto.net'.length)}.`, 'the URL is normalized');
      // A URI the download cut off is not the mail's link.
      const cut = `https://alternativeto.net/api/auth/verify-email?token=${JWT}`;
      const long = await readEmail([SITE], SITE_AUTH, `${'x'.repeat(262_144 - 40)} ${cut}`);
      connectorLinks.push(JSON.parse(long.split('\n\n')[0]).links);
      record('sess-cut', long);
      probe('sess-cut', cut, 'a cut-off URI is not the mail\'s link');
      // The same link read again is one entry, read again.
      record('sess-again', SITE_MAIL, Date.now() - 1000);
      record('sess-again', SITE_MAIL);
      probe('sess-again', LINK, 'read again');
      return { connectorLinks, ops };
    },

    'a link is offered only while recent and over https': async () => {
      const { ops, record, probe } = log();
      const SITE_MAIL = await readEmail([SITE], SITE_AUTH);
      record('sess-old', SITE_MAIL, Date.now() - MAIL_LINK_WINDOW_MS - 1_000);
      probe('sess-old', LINK, 'past the window');
      record('sess-edge', SITE_MAIL, Date.now() - MAIL_LINK_WINDOW_MS);
      probe('sess-edge', LINK, 'at the edge of the window');
      const plain = LINK.replace('https:', 'http:');
      record('sess-http', await readEmail([SITE], SITE_AUTH, `Open ${plain}`));
      probe('sess-http', plain, 'http');
      const credentials = LINK.replace('https://', 'https://user:pw@');
      record('sess-credentials', await readEmail([SITE], SITE_AUTH, `Open ${credentials}`));
      probe('sess-credentials', credentials, 'a link with credentials');
      const bare = box(null, 'support', 'alternativeto.net');
      record('sess-bare', await readEmail([bare], SITE_AUTH, `Confirm here:\n${LINK}\n`));
      probe('sess-bare', LINK, 'a bare address');
      record('', SITE_MAIL);
      probe('', LINK, 'no session');
      record('sess-nomail', 'not a mail');
      record('sess-nohead', `{"links": ["${LINK}"]}\n\nbody`);
      probe('sess-nohead', LINK, 'a head with no sender');
      return { ops };
    },

    'only a single From mailbox that Gmail authenticated counts, however the header is written': async () => {
      const { ops, record, probe } = log();
      const VICTIM_LINK = JWT_LINK('victim.example');
      const victim = box('Victim', 'support', 'victim.example');
      const attacker = box(null, 'attacker', 'evil.example');
      const ar = (results) => `Authentication-Results: mx.google.com;\r\n       ${results}\r\n`;
      const victimDmarc = ar('dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=victim.example');
      const linkOf = async (session, why, from, authentication, link = VICTIM_LINK, body = `Verify: ${VICTIM_LINK}`) => {
        record(session, await readEmail(from, authentication, body));
        return probe(session, link, why);
      };
      await linkOf('sess-dmarc', 'DMARC pass for the From domain', [victim], victimDmarc);
      await linkOf('sess-dkim', 'DKIM d= on its Organizational Domain (relaxed alignment)', [victim], ar('dkim=pass header.d=mail.victim.example header.s=s1; spf=softfail smtp.mailfrom=x@relay.example'));
      // A display name encoded to read like the site's address is only a name.
      const disguised = [atom(`=?UTF-8?B?${Buffer.from('support@victim.example').toString('base64')}?=`), null, atom('attacker'), atom('evil.example')];
      const evilAuth = ar('dkim=pass header.i=@evil.example; dmarc=pass header.from=evil.example');
      await linkOf('sess-disguised', 'the address, not the name', [disguised], evilAuth);
      const refused = [
        ['a bare then a named address', [attacker, victim], victimDmarc],
        ['a named then a bare address', [victim, attacker], victimDmarc],
        ['a group', [[null, null, atom('Victim'), null], box(null, 'support', 'victim.example'), [null, null, null, null]], victimDmarc],
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
      for (const [index, [why, from, authentication]] of refused.entries()) await linkOf(`sess-refused-${index}`, why, from, authentication);
      // Organizational Domains by the public suffix list, private suffixes included: a.github.io is not b.github.io.
      const alignment = [
        ['DKIM across two github.io users', 'a.github.io', 'b.github.io'],
        ['DKIM on the same github.io user', 'a.github.io', 'www.a.github.io'],
        ['DKIM across co.uk registrants', 'a.co.uk', 'b.co.uk'],
        ['DKIM inside one co.uk registrant', 'a.co.uk', 'mail.a.co.uk'],
        ['DKIM from a bare public suffix', 'a.co.uk', 'co.uk'],
        ['DKIM across wildcard-suffix registrants', 'a.kobe.jp', 'b.kobe.jp'],
        ['DKIM under a wildcard-suffix exception', 'city.kobe.jp', 'www.city.kobe.jp'],
        ['DKIM under an unlisted suffix', 'a.zzzz', 'mail.a.zzzz'],
        ['DKIM on an IDN', 'bücher.example', 'mail.xn--bcher-kva.example'],
        ['DKIM on an IP address host', '192.0.2.1', '192.0.2.1'],
      ];
      for (const [index, [why, fromHost, signer]] of alignment.entries()) {
        const link = JWT_LINK(fromHost);
        await linkOf(`sess-site-${index}`, why, [box(null, 'x', fromHost)], ar(`dkim=pass header.d=${signer} header.s=s1`), link, `Verify: ${link}`);
      }
      return { ops };
    },

    // What tldts does to a host before and around the suffix match (its hostname validation, case, IP literals, IDN, length limits,
    // private versus ICANN suffixes, wildcard and exception rules), through the sender, the signing domain and the link host.
    'the hostnames the sender, the signing domain and the link may spell: tldts validates them before it matches a suffix': async () => {
      const { ops, record, probe } = log();
      const ar = (results) => `Authentication-Results: mx.google.com;\r\n       ${results}\r\n`;
      const dkim = (signer) => ar(`dkim=pass header.d=${signer} header.s=s1`);
      const dmarc = (from) => ar(`dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=${from}`);
      const label = (length) => 'a'.repeat(length);
      let n = 0;
      const attempt = async (why, senderHost, authentication, link = JWT_LINK(senderHost)) => {
        const session = `sess-host-${n++}`;
        record(session, await readEmail([box(null, 'x', senderHost)], authentication, `Verify: ${link}`));
        return probe(session, link, why);
      };
      // The signing domain.
      for (const [why, signer] of [
        ['a signing label starting with a hyphen', '-mail.victim.example'],
        ['a signing label ending with a hyphen', 'mail-.victim.example'],
        ['a signing label with a hyphen inside', 'ma--il.victim.example'],
        ['a signing label of 64 bytes', `${label(64)}.victim.example`],
        ['a signing label of 63 bytes', `${label(63)}.victim.example`],
        ['a signing domain of 256 bytes', `${[label(63), label(63), label(63), label(49)].join('.')}.victim.example`],
        ['a signing domain of 255 bytes', `${[label(63), label(63), label(63), label(48)].join('.')}.victim.example`],
        ['a signing domain in capitals', 'MAIL.VICTIM.EXAMPLE'],
        ['a signing domain with a trailing dot', 'mail.victim.example.'],
        ['a signing domain with an empty label', 'mail..victim.example'],
        ['a signing label with an underscore', '_dkim.victim.example'],
        ['a signing domain with an invalid punycode label', 'xn--.victim.example'],
        ['a signing domain of a single label', 'example'],
        ['a signing domain that is an address', '0x7f.1'],
      ]) await attempt(why, 'victim.example', dkim(signer));
      // The sender: DMARC for the very domain takes it as written; the DKIM route needs a valid host.
      for (const [why, senderHost] of [
        ['a sender label starting with a hyphen', '-victim.example'],
        ['a sender label ending with a hyphen', 'victim-.example'],
        ['a sender label of 64 bytes', `${label(64)}.example`],
        ['a sender of 256 bytes', `${[label(63), label(63), label(63), label(49)].join('.')}.victim.example`],
        ['a sender of 255 bytes', `${[label(63), label(63), label(63), label(48)].join('.')}.victim.example`],
        ['a sender in capitals', 'VICTIM.Example'],
        ['a sender with a trailing dot', 'victim.example.'],
        ['a sender with an empty label', 'victim..example'],
        ['a sender label with an underscore', '_victim.example'],
      ]) {
        await attempt(`${why}, DMARC pass`, senderHost, dmarc(senderHost));
        await attempt(`${why}, DKIM pass`, senderHost, dkim(senderHost));
      }
      // IP literals: URL parsing turns a spelled address into dotted decimal, which is a host, and never a registrable domain.
      await attempt('a hex-spelled address sender, DMARC for its dotted form', '0x7f.1', dmarc('127.0.0.1'));
      await attempt('a dotted sender, DMARC for its hex spelling', '127.0.0.1', dmarc('0x7f.1'));
      await attempt('an address sender, DKIM for the same address', '192.0.2.1', dkim('192.0.2.1'));
      await attempt('an address sender, DKIM for its decimal spelling', '192.0.2.1', dkim('3221225985.1'));
      await attempt('an address-looking name, DKIM on its own domain', '1.2.3.example', dkim('1.2.3.example'));
      // Internationalized names are compared in punycode.
      await attempt('an IDN sender, DKIM in capitals', 'xn--bcher-kva.example', dkim('MAIL.BÜCHER.EXAMPLE'));
      await attempt('an IDN sender, DKIM in unicode', 'xn--bcher-kva.example', dkim('mail.bücher.example'));
      await attempt('an IDN sender, DKIM in punycode', 'xn--bcher-kva.example', dkim('mail.xn--bcher-kva.example'));
      await attempt('an IDN sender, DKIM on an invalid punycode label', 'xn--bcher-kva.example', dkim('xn--bcher-kva.xn--.example'));
      await attempt('an IDN public suffix, one registrant', 'a.xn--55qx5d.cn', dkim('mail.a.公司.cn'));
      await attempt('an IDN public suffix, two registrants', 'a.xn--55qx5d.cn', dkim('b.xn--55qx5d.cn'));
      // Private versus ICANN suffixes, wildcard and exception rules.
      await attempt('a private suffix, two registrants', 'a.blogspot.com', dkim('b.blogspot.com'));
      await attempt('a private suffix, one registrant', 'a.blogspot.com', dkim('www.a.blogspot.com'));
      await attempt('a wildcard suffix, two registrants', 'x.foo.ck', dkim('y.foo.ck'));
      await attempt('a wildcard suffix, one registrant', 'x.foo.ck', dkim('www.x.foo.ck'));
      await attempt('a wildcard exception, one registrant', 'a.www.ck', dkim('b.www.ck'));
      await attempt('a wildcard exception, another registrant', 'a.www.ck', dkim('b.example.ck'));
      await attempt('the exception name itself', 'www.ck', dkim('mail.www.ck'));
      await attempt('a bare public suffix as the sender', 'co.uk', dkim('co.uk'));
      // The link host: the provenance belongs to the mail, whatever host its link names.
      for (const [why, link] of [
        ['a link in capitals', 'https://VICTIM.Example/verify?token=abc'],
        ['a link with a trailing dot', 'https://victim.example./verify?token=abc'],
        ['a link on a hex-spelled address', 'https://0x7f.1/verify?token=abc'],
        ['a link on a hyphen-edged host', 'https://-victim.example/verify?token=abc'],
        ['a link on a 64-byte label', `https://${label(64)}.example/verify?token=abc`],
        ['a link on an IDN', 'https://bücher.example/verify?token=abc'],
        ['a link on a private-suffix host', 'https://a.blogspot.com/verify?token=abc'],
        ['a link on a host with a port', 'https://victim.example:8443/verify?token=abc'],
      ]) await attempt(why, 'victim.example', dmarc('victim.example'), link);
      return { ops };
    },

    'a link the runtime read in a mail opens; the same URL anywhere else stays refused (the runtime leg)': async () => {
      const { ops, record, probe } = log();
      const mail = (address, link) => `${JSON.stringify({ id: '9001', from: address, fromAddresses: [{ name: '', address }], authentication: { dmarc: { result: 'pass', from: address.split('@')[1] }, dkim: [] }, subject: 'Confirm your e-mail', links: [link] })}\n\nConfirm: ${link}`;
      const bridge = await withBridge();
      try {
        const navigate = async (session, input, why) => {
          const before = bridge.seen.length;
          const answer = await bridge.navigate(session, input);
          ops.push({ op: 'navigate', session, input, why, command: bridge.seen.length > before ? bridge.seen.at(-1) : null, ...answer });
        };
        record('sess-signup', mail('support@alternativeto.net', LINK));
        await navigate('sess-signup', { url: LINK }, 'the link the runtime read');
        await navigate('sess-other', { url: LINK }, 'a link read in another session');
        await navigate('sess-signup', { url: LINK.replace(JWT, `${JWT}x`) }, 'a token URL the model typed without a mail read');
        await navigate('sess-other', { url: LINK, mail_link: { url: LINK, from_domain: 'alternativeto.net', read_at: Date.now() } }, 'the model cannot claim provenance');
        // A mail from another domain (authenticated as that domain) whose link points at the site.
        record('sess-phish', mail('support@evil.example', LINK));
        await navigate('sess-phish', { url: LINK }, 'the runtime offers it, the desktop refuses it');
        probe('sess-phish', LINK, 'the link the runtime holds for the other domain');
        await navigate('sess-signup', { url: `  ${LINK}  ` }, 'the URL is trimmed');
        await navigate('sess-signup', { url: 'https://alternativeto.net/' }, 'a URL no mail names');
      } finally {
        await bridge.stop();
      }
      return { ops };
    },
  };
}
