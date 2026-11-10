// A fetch bound to one gateway origin: anything outside `origin` is refused
// before the credential leaves the process, and redirects are never followed
// (any 3xx is an error), so a gateway credential can only reach its gateway.
export function originBoundFetch(origin, fetchImpl, label) {
  return async (input, init) => {
    const url = new URL(String(input?.url ?? input));
    if (url.origin !== origin) {
      throw new Error(`[${label}] refusing to send the API key to ${url.host}`);
    }
    const res = await (fetchImpl || globalThis.fetch)(input, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`[${label}] refusing to follow a redirect from ${url.host}`);
    }
    return res;
  };
}
