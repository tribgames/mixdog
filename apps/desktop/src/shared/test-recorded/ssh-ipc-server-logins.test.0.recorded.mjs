// Node b6f10295a2f698afc85332467192de28500bd146 (tree 332679f9c46ead536c500ab57a7580c0fb28d550) src/tui/session/oauth-flows.mjs, recorded from apps/desktop/src/main/ssh/ssh-ipc-server-logins.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./ssh-ipc-server-logins.test.0.recorded.json', import.meta.url), 'utf8'));
export const createSessionOAuthFlowRegistry = replay(table, "createSessionOAuthFlowRegistry");
