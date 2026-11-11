// Preloaded into a recorded child process (`node --import <this file> ...`): the random sources the code under test reads
// are counters, so ids it makes from them are the same on every run. Same rule as installDeterminism() in
// session-wire-harness.mjs for crypto.randomUUID / crypto.randomBytes, Date.now() is 1700000000000 and process.pid is 4242.
import crypto from 'node:crypto';
import module from 'node:module';

let uuids = 0;
let bytes = 0;
const realRandomBytes = crypto.randomBytes;
crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, '0')}`;
crypto.randomBytes = (size, callback) => (typeof callback === 'function' ? realRandomBytes(size, callback) : Buffer.from(Array.from({ length: size }, () => ++bytes % 256)));
module.syncBuiltinESMExports();
Date.now = () => 1_700_000_000_000;
Object.defineProperty(process, 'pid', { value: 4242, configurable: true });