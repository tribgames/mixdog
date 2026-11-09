// Node b6f10295a src/runtime/shared/session-sidebar-host.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./session-sidebar-actions.test.0.recorded.json', import.meta.url), 'utf8'));
export const applySessionSidebarChange = replay(table, "applySessionSidebarChange");
export const readSessionSidebarState = replay(table, "readSessionSidebarState");
export const registerSessionSidebarHost = replay(table, "registerSessionSidebarHost");
