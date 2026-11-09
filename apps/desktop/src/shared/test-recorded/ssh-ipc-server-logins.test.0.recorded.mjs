// Node b6f10295a src/tui/session/oauth-flows.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./ssh-ipc-server-logins.test.0.recorded.json', import.meta.url), 'utf8'));
export const createSessionOAuthFlowRegistry = replay(table, "createSessionOAuthFlowRegistry");
