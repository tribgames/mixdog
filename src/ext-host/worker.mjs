// Extension-host worker entry: `node src/ext-host/worker.mjs`. The core's pool spawns W of these;
// frames travel on stdin/stdout, so anything the office stack prints goes to stderr instead.
import { handlers } from './methods.mjs';
import { runWorker } from './worker-core.mjs';

const writeFrame = process.stdout.write.bind(process.stdout);
process.stdout.write = (...args) => process.stderr.write(...args);

runWorker({
  handlers,
  input: process.stdin,
  write: (bytes) => writeFrame(bytes),
  exit: (code) => process.exit(code),
});
