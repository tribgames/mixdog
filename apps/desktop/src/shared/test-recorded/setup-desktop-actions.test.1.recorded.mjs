// Node b6f10295a src/standalone/session-protocol.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./setup-desktop-actions.test.1.recorded.json', import.meta.url), 'utf8'));
export const SESSION_CONFIGURE_ACTIONS = replay(table, "SESSION_CONFIGURE_ACTIONS");
export const SESSION_CONFIGURE_ACTION_SET = replay(table, "SESSION_CONFIGURE_ACTION_SET");
export const SESSION_READ_ACTIONS = replay(table, "SESSION_READ_ACTIONS");
export const SESSION_READ_ACTION_SET = replay(table, "SESSION_READ_ACTION_SET");
export const createSessionProtocolClient = replay(table, "createSessionProtocolClient");
