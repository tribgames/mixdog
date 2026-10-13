// Remote (SSH) mode switch. With MIXDOG_MODEL_PROXY=client the daemon runs on
// a server that must never hold model credentials: every model call is
// executed by the connected desktop client on the user's PC and streamed back
// (providers/model-proxy-channel.mjs). Read per call so a test or host can
// flip the environment without reloading modules.
export const MODEL_PROXY_ENV = 'MIXDOG_MODEL_PROXY';

export function modelProxyClientMode(env = process.env) {
  return env?.[MODEL_PROXY_ENV] === 'client';
}

/** The refusal every server-side credential refresh raises in this mode. */
export function serverModelCredentialsDisabledError(what = 'model credentials') {
  const error = new Error(
    `${what} are not available on this server: ${MODEL_PROXY_ENV}=client runs every model call on the client PC.`
  );
  error.code = 'MODEL_CREDENTIALS_DISABLED';
  return error;
}
