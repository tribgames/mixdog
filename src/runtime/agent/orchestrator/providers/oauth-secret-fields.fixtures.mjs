// The authorization code a test login sends: redacted by value, since `code`
// alone is also an error/status field.
export const AUTH_CODE = 'SECRET-CODE';

// Every secret field a token endpoint might echo, each with a distinct value
// that a test can search for in pages, errors and logs.
export const SECRET_FIELDS = {
  access_token: 'SECRET-ACCESS',
  refresh_token: 'SECRET-REFRESH',
  id_token: 'SECRET-ID',
  client_secret: 'SECRET-CLIENT',
  code: AUTH_CODE,
  code_verifier: 'SECRET-VERIFIER',
  code_challenge: 'SECRET-CHALLENGE',
  device_code: 'SECRET-DEVICE',
  accessToken: 'SECRET-CAMEL-ACCESS',
  refreshToken: 'SECRET-CAMEL-REFRESH',
  idToken: 'SECRET-CAMEL-ID',
  clientSecret: 'SECRET-CAMEL-CLIENT',
  token: 'SECRET-TOKEN',
};

export const SECRET_RE = /SECRET-/;

/** Valid JSON whose secret keys are written with escapes, nested in objects and arrays. */
export const ESCAPED_SECRET_BODY = String.raw`{"error":{"code":400,"details":[{"client\u005fsecret":"SECRET-ESC-CLIENT","Refresh\u005FToken":"SECRET-ESC-REFRESH"},["x",{"\u0069d_token":"SECRET-ESC-ID"}]],"meta":{"api\u005Fkey":"SECRET-ESC-KEY","acc\u0065ss\u005ftoken":"SECRET-ESC-ACCESS"}}}`;

/** Valid JSON whose secrets sit inside string values: form-encoded, a query string, nested JSON. */
export const STRING_SECRET_BODY = JSON.stringify({
  error: 'invalid_request',
  detail: 'access_token=SECRET-FORM-ACCESS&client_secret=SECRET-FORM-CLIENT',
  error_uri: 'https://auth.example/cb?client_secret=SECRET-QUERY-CLIENT&state=ok',
  nested: JSON.stringify({ refresh_token: 'SECRET-NESTED', inner: String.raw`{"client\u005fsecret":"SECRET-DEEP"}` }),
});

/** Token-endpoint failure bodies carrying every secret field (JSON, escaped JSON, strings, form-encoded). */
export const SECRET_BODIES = [
  JSON.stringify({ error: 'invalid_grant', ...SECRET_FIELDS }),
  ESCAPED_SECRET_BODY,
  STRING_SECRET_BODY,
  new URLSearchParams({ error: 'invalid_grant', ...SECRET_FIELDS }).toString(),
];

/** A 200 body that is not JSON but carries tokens (the parser would quote it). */
export const MALFORMED_TOKEN_BODY = '{"access_token":"SECRET-ACCESS","refresh_token":"SECRET-REFRESH" oops';
