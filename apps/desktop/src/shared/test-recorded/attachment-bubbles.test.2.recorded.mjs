// Node b6f10295a src/runtime/agent/orchestrator/session/transcript-restore/user-text.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./attachment-bubbles.test.2.recorded.json', import.meta.url), 'utf8'));
export const createUserTextRestore = replay(table, "createUserTextRestore");
export const restoredUserImageRefs = replay(table, "restoredUserImageRefs");
export const restoredUserText = replay(table, "restoredUserText");
