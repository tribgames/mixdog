// Node b6f10295a `SESSION_READ_ACTIONS` / `SESSION_CONFIGURE_ACTIONS` (src/standalone/session-protocol.mjs), recorded.
import { readFileSync } from 'node:fs';

const recorded = JSON.parse(readFileSync(new URL('./session-protocol-actions.recorded.json', import.meta.url), 'utf8'));
export const SESSION_READ_ACTIONS = recorded.SESSION_READ_ACTIONS;
export const SESSION_CONFIGURE_ACTIONS = recorded.SESSION_CONFIGURE_ACTIONS;
