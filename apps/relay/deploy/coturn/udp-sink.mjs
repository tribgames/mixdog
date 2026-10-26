#!/usr/bin/env node
// A UDP listener that counts, and echoes, what it receives: the "peer" behind a
// TURN relay for verify-turn.sh. It prints `ready` once bound and, on SIGTERM,
// `received=<count>`, so the script can tell whether the relay delivered.
//   node udp-sink.mjs <address> <port>
import { createSocket } from 'node:dgram';

const [address, port] = process.argv.slice(2);
if (!address || !/^\d+$/u.test(port ?? '')) {
  console.error('usage: node udp-sink.mjs <address> <port>');
  process.exit(2);
}
const socket = createSocket('udp4');
let received = 0;
socket.on('message', (message, remote) => {
  received += 1;
  socket.send(message, remote.port, remote.address);
});
socket.once('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
socket.bind(Number(port), address, () => console.log('ready'));
process.once('SIGTERM', () => {
  console.log(`received=${received}`);
  process.exit(0);
});
