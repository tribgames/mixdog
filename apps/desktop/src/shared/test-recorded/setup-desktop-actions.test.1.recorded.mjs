// Node b6f10295a2f698afc85332467192de28500bd146 (tree 332679f9c46ead536c500ab57a7580c0fb28d550) src/standalone/session-protocol.mjs, recorded from apps/desktop/src/renderer/setup-desktop-actions.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./setup-desktop-actions.test.1.recorded.json', import.meta.url), 'utf8'));
export const SESSION_CONFIGURE_ACTIONS = replay(table, "SESSION_CONFIGURE_ACTIONS");
export const SESSION_CONFIGURE_ACTION_SET = replay(table, "SESSION_CONFIGURE_ACTION_SET");
export const SESSION_READ_ACTIONS = replay(table, "SESSION_READ_ACTIONS");
export const SESSION_READ_ACTION_SET = replay(table, "SESSION_READ_ACTION_SET");
export const createSessionProtocolClient = replay(table, "createSessionProtocolClient");
