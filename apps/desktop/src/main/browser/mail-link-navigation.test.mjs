// The desktop's own check of a link the runtime read in a mail (Node b6f10295a: the runtime recorded the link per session
// and sent `mail_link{url, from_domain, read_at}` with the navigate command; the desktop admits the URL only when the link
// names that very URL and the sender's domain owns the site). The runtime half now belongs to the core.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserUrlAdmission } from './url-admission.ts';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImRldkB0cmliZ2FtZXMuY29tIn0.c2lnbmF0dXJlLW9mLXRoZS1zaXRl';
const LINK = `https://alternativeto.net/api/auth/verify-email?token=${JWT}&callbackURL=https%3A%2F%2Falternativeto.net%2F`;
const REFUSED = /credential-like query values or secret tokens/;

const admission = () =>
  createBrowserUrlAdmission({ policy: {}, lookupAddresses: async () => [{ address: '93.184.216.34' }] });
const mailLink = (overrides = {}) => ({ url: LINK, from_domain: 'alternativeto.net', read_at: Date.now(), ...overrides });

test('a link the runtime read in a mail from the site opens; the same URL without that provenance stays refused', async () => {
  const { validatedAgentUrl } = admission();
  assert.equal(await validatedAgentUrl(LINK, mailLink()), LINK);
  await assert.rejects(validatedAgentUrl(LINK, undefined), REFUSED);
  await assert.rejects(validatedAgentUrl(LINK.replace(JWT, `${JWT}x`), mailLink()), REFUSED, 'a URL the mail did not name');
});

test('the desktop checks the runtime-set link against the URL and the sender itself', async () => {
  const { validatedAgentUrl } = admission();
  await assert.rejects(validatedAgentUrl(LINK, mailLink({ from_domain: 'evil.example' })), REFUSED, 'a sender of another domain');
  await assert.rejects(
    validatedAgentUrl(`https://evil.example/collect?token=${JWT}`, mailLink()),
    REFUSED,
    'a bridge command whose mail link names another URL than the one navigated'
  );
});
