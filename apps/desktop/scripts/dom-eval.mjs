// Generic CDP evaluator (diagnosis tooling).
//
//   node scripts/dom-eval.mjs --port=9342 scripts/probes/<name>.js
//
// Reads the expression from a FILE so shell quoting never mangles it, then
// prints the returned value as JSON.
import { readFile } from 'node:fs/promises';

const argumentsList = process.argv.slice(2);
const valueFor = (prefix) => argumentsList
  .find((argument) => argument.startsWith(`${prefix}=`))
  ?.slice(prefix.length + 1);
const port = Number(valueFor('--port') || 9342);
const file = argumentsList.find((argument) => !argument.startsWith('--'));
if (!file) throw new Error('Usage: dom-eval.mjs [--port=9342] <expression-file>');
const expression = await readFile(file, 'utf8');

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const target = targets.find((candidate) => candidate.type === 'page');
if (!target?.webSocketDebuggerUrl) throw new Error('No debuggable page target found.');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', () => reject(new Error('CDP websocket failed.')), { once: true });
});
const result = await new Promise((resolve, reject) => {
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  socket.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true },
  }));
});
if (result.exceptionDetails) {
  console.error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  socket.close();
  process.exit(1);
}
console.log(JSON.stringify(result.result?.value, null, 1));
socket.close();
process.exit(0);
