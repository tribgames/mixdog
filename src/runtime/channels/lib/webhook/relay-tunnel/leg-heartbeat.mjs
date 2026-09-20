// NAT paths silently drop idle sockets; protocol pings keep the leg warm and
// detect a half-dead link so the reconnect loop restores it.
import WebSocket from 'ws';
import { HEARTBEAT_MS } from './limits.mjs';

export function armLegHeartbeat(ws) {
  let alive = true;
  ws.on('pong', () => {
    alive = true;
  });
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!alive) {
      try {
        ws.terminate();
      } catch {
        /* close reconnects */
      }
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      /* close reconnects */
    }
  }, HEARTBEAT_MS);
  timer.unref?.();
  return {
    markAlive: () => {
      alive = true;
    },
    stop: () => clearInterval(timer),
  };
}
