// Node b6f10295a2f698afc85332467192de28500bd146 src/session-runtime/setup-tool/settings-contract.mjs, recorded from apps/desktop/src/renderer/setup-desktop-actions.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./setup-desktop-actions.test.2.recorded.json', import.meta.url), 'utf8'));
export const SETUP_ACTIVITY_RAIL_PIN_IDS = replay(table, "SETUP_ACTIVITY_RAIL_PIN_IDS");
export const SETUP_DESKTOP_ACTIONS = replay(table, "SETUP_DESKTOP_ACTIONS");
export const SETUP_DESKTOP_DOMAINS = replay(table, "SETUP_DESKTOP_DOMAINS");
export const SETUP_EXTENDED_ACTION_FIELDS = replay(table, "SETUP_EXTENDED_ACTION_FIELDS");
export const SETUP_EXTENDED_DOMAINS = replay(table, "SETUP_EXTENDED_DOMAINS");
export const SETUP_EXTENDED_PROPERTIES = replay(table, "SETUP_EXTENDED_PROPERTIES");
export const SETUP_HANDOFFS = replay(table, "SETUP_HANDOFFS");
export const SETUP_MCP_SCHEMA = replay(table, "SETUP_MCP_SCHEMA");
