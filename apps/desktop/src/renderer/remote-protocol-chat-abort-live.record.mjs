// Records what a RUNNING mixdogd answers to the Stops of remote-protocol-chat-abort.recorded.json (the driver is remote-protocol-chat-abort-live.mjs).
// Usage: MIXDOGD_EXE=<mixdogd.exe> REAL_TURN_HARNESS=<real-turn-harness dir> node remote-protocol-chat-abort-live.record.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAbortLive } from './remote-protocol-chat-abort-live.mjs';

const out = await runAbortLive();
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'remote-protocol-chat-abort-live.recorded.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`recorded ${out.cases.length} abort cases`);
process.exit(0);
