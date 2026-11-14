// Extension-host worker entry: `node src/ext-host/worker.mjs`. The core's pool spawns W of these;
// frames travel on stdin/stdout, so anything the office stack prints goes to stderr instead.
import { closeOfficeSessions, handlers } from './methods.mjs';
import { runWorker } from './worker-core.mjs';

const writeFrame = process.stdout.write.bind(process.stdout);
process.stdout.write = (...args) => process.stderr.write(...args);

runWorker({
  handlers,
  input: process.stdin,
  write: (bytes) => writeFrame(bytes),
  // The process leaves once its office session hosts have quit the applications they own.
  exit: (code) => closeOfficeSessions().finally(() => process.exit(code)),
});
