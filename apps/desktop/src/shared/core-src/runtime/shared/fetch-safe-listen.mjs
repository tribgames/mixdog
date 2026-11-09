// Ports the WHATWG Fetch spec blocks ("bad port"): fetch (undici) and Chromium
// refuse to connect to them, so a loopback server that a fetch client or a
// browser context must reach cannot live on one. https://fetch.spec.whatwg.org/#port-blocking
export const FETCH_BLOCKED_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** How many more OS-assigned ports a listener takes after a blocked one. */
export const FETCH_SAFE_ATTEMPTS = 16;

const assignedPort = (server) => {
  const address = server.address();
  return address && typeof address === 'object' ? address.port : 0;
};

/**
 * `server.listen(0, host)` that never settles on a fetch-blocked port: when the
 * OS assigns one, the server is closed and listened again, at most `attempts`
 * more times. `onListening` runs once, on a safe port. When the attempts run
 * out the server is closed and an 'error' is emitted, like a failed listen.
 * `isCurrent` lets a caller that stopped the server meanwhile cancel the retry;
 * `portOf` reads the assigned port.
 */
export function listenOnFetchSafePort(
  server,
  host,
  onListening,
  { attempts = FETCH_SAFE_ATTEMPTS, isCurrent = () => true, portOf = assignedPort } = {}
) {
  let retries = attempts;
  const attempt = () => {
    server.listen(0, host, () => {
      if (!FETCH_BLOCKED_PORTS.has(portOf(server))) {
        onListening();
        return;
      }
      const exhausted = retries <= 0;
      retries -= 1;
      server.close(() => {
        if (!isCurrent()) return;
        if (exhausted) server.emit('error', new Error('no fetch-safe loopback port was assigned'));
        else attempt();
      });
    });
  };
  attempt();
}
