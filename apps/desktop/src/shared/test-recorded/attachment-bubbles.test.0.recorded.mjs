// Node b6f10295a src/tui/session/session-flow/queue/entry-shape.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./attachment-bubbles.test.0.recorded.json', import.meta.url), 'utf8'));
export const makeQueueEntry = replay(table, "makeQueueEntry");
