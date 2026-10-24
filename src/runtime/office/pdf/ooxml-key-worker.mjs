// The password hash iteration of [MS-OFFCRYPTO] 2.3.4.7 (standard) and 2.3.4.11 (agile), on its own thread so up to
// 10,000,000 hashes never hold the host's event loop; ending the thread cancels it (ooxml-crypto.mjs).
// H0 = H(salt + password as UTF-16LE), Hn = H(iterator + Hn-1) for iterator 0 .. spinCount - 1.
import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';

const { algorithm, salt, password, spinCount } = workerData;
let value = createHash(algorithm).update(salt).update(Buffer.from(password, 'utf16le')).digest();
const iterator = Buffer.alloc(4);
for (let index = 0; index < spinCount; index++) {
  iterator.writeUInt32LE(index, 0);
  value = createHash(algorithm).update(iterator).update(value).digest();
}
parentPort.postMessage(value);
