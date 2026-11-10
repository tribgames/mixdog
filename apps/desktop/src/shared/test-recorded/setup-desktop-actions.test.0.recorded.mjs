// Node b6f10295a2f698afc85332467192de28500bd146 (tree 332679f9c46ead536c500ab57a7580c0fb28d550) src/session-runtime/setup-tool/tool-defs.mjs, recorded from apps/desktop/src/renderer/setup-desktop-actions.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./setup-desktop-actions.test.0.recorded.json', import.meta.url), 'utf8'));
export const SETUP_ACTIONS = replay(table, "SETUP_ACTIONS");
export const SETUP_ACTION_FIELDS = replay(table, "SETUP_ACTION_FIELDS");
export const SETUP_BUILTIN_TOGGLE_FEATURES = replay(table, "SETUP_BUILTIN_TOGGLE_FEATURES");
export const SETUP_OPEN_TARGETS = replay(table, "SETUP_OPEN_TARGETS");
export const SETUP_SECTION_OPEN_TARGETS = replay(table, "SETUP_SECTION_OPEN_TARGETS");
export const SETUP_STATUS_DOMAINS = replay(table, "SETUP_STATUS_DOMAINS");
export const SETUP_TOOL_DEFS = replay(table, "SETUP_TOOL_DEFS");
