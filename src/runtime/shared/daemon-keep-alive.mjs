import http from 'node:http';

// The one keep-alive window of the daemon's HTTP servers. The servers set it
// and advertise it as `Keep-Alive: timeout=N`; the client agents use it as the
// ceiling of their idle-socket timeout. Node's agent then lowers each socket's
// idle timeout to the advertised N minus its own agentKeepAliveTimeoutBuffer,
// so the client drops an idle socket before the server's close can race a
// request written to it (ECONNRESET). Nothing here is a separate guessed margin.
export const DAEMON_KEEP_ALIVE_MS = 5_000;

export function createDaemonHttpServer(handler) {
  return http.createServer({ keepAliveTimeout: DAEMON_KEEP_ALIVE_MS }, handler);
}
