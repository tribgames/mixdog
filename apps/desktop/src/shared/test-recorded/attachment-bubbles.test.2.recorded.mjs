// Node b6f10295a2f698afc85332467192de28500bd146 (tree 332679f9c46ead536c500ab57a7580c0fb28d550) src/runtime/agent/orchestrator/session/transcript-restore/user-text.mjs, recorded from apps/desktop/src/renderer/attachment-bubbles.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./attachment-bubbles.test.2.recorded.json', import.meta.url), 'utf8'));
export const createUserTextRestore = replay(table, "createUserTextRestore");
export const restoredUserImageRefs = replay(table, "restoredUserImageRefs");
export const restoredUserText = replay(table, "restoredUserText");
