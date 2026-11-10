import http from 'node:http';

// The one keep-alive window of the daemon's HTTP servers. The servers set it
// and advertise it as `Keep-Alive: timeout=N`.
export const DAEMON_KEEP_ALIVE_MS = 5_000;

// The client agents' idle-socket timeout: a client must drop an idle socket
// strictly before the server closes it, or a request written to it at that
// moment fails ECONNRESET. Node 24.7+ also lowers it from the advertised
// header, but the supported 24.0-24.6 agents have no such buffer, so the gap
// is part of this contract rather than left to the runtime.
export const DAEMON_CLIENT_IDLE_MS = DAEMON_KEEP_ALIVE_MS - 1_000;

export function createDaemonHttpServer(handler) {
  return http.createServer({ keepAliveTimeout: DAEMON_KEEP_ALIVE_MS }, handler);
}
