import { listenOnFetchSafePort } from '../../../../shared/fetch-safe-listen.mjs';

// Port 0 takes an OS-assigned port the browser can be redirected to.
export function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const listening = () => {
      server.off('error', reject);
      resolve();
    };
    if (port === 0) listenOnFetchSafePort(server, host, listening);
    else server.listen(port, host, listening);
  });
}
