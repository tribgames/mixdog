// Close a dev app gracefully over CDP so Chromium flushes its profile
// (localStorage, window state) before exit. Killing the process loses it.
//
//   node scripts/dev-close.mjs --port=9342
import { optionValue } from './cli-args.mjs';

const port = Number(optionValue('port', process.argv.slice(2)) || 9342);
const version = await fetch(`http://127.0.0.1:${port}/json/version`, {
  signal: AbortSignal.timeout(3000),
}).then((response) => response.json());
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Dev app on port ${port} did not close within 10s.`)), 10_000);
  socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
  socket.addEventListener('close', () => {
    clearTimeout(timer);
    resolve();
  });
  socket.addEventListener('error', () => {
    clearTimeout(timer);
    reject(new Error('CDP websocket failed.'));
  });
});
console.log(`Closed dev app on port ${port}.`);
