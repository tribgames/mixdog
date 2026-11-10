// The account side of an MCP OAuth sign-in: which documented authorization
// parameter makes a provider show its account choice, and who a sign-in
// belongs to, read only from what the authorization server returned.
//
// Parameters are sent only where the provider documents them (keyed by the
// authorization endpoint's host); everywhere else nothing is added:
//   Google  prompt=select_account  developers.google.com/identity/protocols/oauth2/web-server#creatingclient
//   GitHub  prompt=select_account  docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
//   Atlassian (Jira, Confluence, Trello) prompt=consent  developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
//   Linear  prompt=consent         linear.app/developers/oauth-2-0-authentication
//   Dropbox force_reapprove=true   www.dropbox.com/developers/documentation/http/documentation#oauth2-authorize

const SELECT_ACCOUNT = Object.freeze({ prompt: 'select_account' });
// A normal connect shows the chooser only where it is the documented choice.
const CONNECT_PARAMS = Object.freeze({
  'accounts.google.com': SELECT_ACCOUNT,
  'github.com': SELECT_ACCOUNT,
});
// 계정 바꾸기: the provider's documented way to force the choice (or the grant).
const SWITCH_PARAMS = Object.freeze({
  ...CONNECT_PARAMS,
  'auth.atlassian.com': Object.freeze({ prompt: 'consent' }),
  'linear.app': Object.freeze({ prompt: 'consent' }),
  'mcp.linear.app': Object.freeze({ prompt: 'consent' }),
  'www.dropbox.com': Object.freeze({ force_reapprove: 'true' }),
});

const hostOf = (url) => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
};

/** `authorizationUrl` with the account parameters of `mode` (`connect`,
 *  `reauth`, `switch`); a repair (`reauth`) adds nothing. A `prompt` the
 *  request already carries (the SDK's `consent` for offline access) is kept. */
export function withAccountParams(authorizationUrl, mode = 'connect') {
  const target = new URL(authorizationUrl);
  const table = mode === 'switch' ? SWITCH_PARAMS : mode === 'connect' ? CONNECT_PARAMS : {};
  const params = table[target.host.toLowerCase()];
  if (!params) return target;
  for (const [key, value] of Object.entries(params)) {
    if (key !== 'prompt') {
      target.searchParams.set(key, value);
      continue;
    }
    const values = new Set((target.searchParams.get('prompt') || '').split(' ').filter(Boolean));
    values.add(value);
    target.searchParams.set('prompt', [...values].join(' '));
  }
  return target;
}

/** Whether 계정 바꾸기 can make the provider of this authorization endpoint
 *  show its choice (otherwise the user switches at the provider first). */
export function canForceAccountChoice(authorizationEndpoint) {
  return Object.hasOwn(SWITCH_PARAMS, hostOf(authorizationEndpoint));
}

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

function idTokenClaims(idToken) {
  const payload = typeof idToken === 'string' ? idToken.split('.')[1] : '';
  if (!payload) return {};
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? claims : {};
  } catch {
    return {};
  }
}

/** `{ account, workspace }` from a token endpoint response: the OIDC id_token
 *  claims and the identity fields providers return beside the tokens (Notion's
 *  workspace and owner, Slack's team, a `user` / `organization` object). Null
 *  when the response names nobody: an identity is never guessed. */
export function identityFromTokenResponse(body) {
  if (!body || typeof body !== 'object') return null;
  const claims = idTokenClaims(body.id_token);
  const user = body.user && typeof body.user === 'object' ? body.user : {};
  const person = body.owner?.user?.person;
  const account =
    text(claims.email) ||
    text(claims.preferred_username) ||
    text(body.email) ||
    text(user.email) ||
    text(user.login) ||
    text(user.username) ||
    text(person?.email) ||
    text(body.owner?.user?.name);
  const workspace =
    text(body.workspace_name) || text(body.team?.name) || text(body.organization?.name) || text(body.org?.name);
  if (!account && !workspace) return null;
  return { account, workspace };
}
