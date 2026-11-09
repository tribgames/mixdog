// Node b6f10295a2f698afc85332467192de28500bd146 src/runtime/shared/developer-options.mjs, recorded from apps/desktop/src/renderer/i18n.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./i18n.test.1.recorded.json', import.meta.url), 'utf8'));
export const DEVELOPER_SECTIONS = replay(table, "DEVELOPER_SECTIONS");
export const developerOption = replay(table, "developerOption");
export const developerOptionEnabled = replay(table, "developerOptionEnabled");
export const developerOptionEnabledStrict = replay(table, "developerOptionEnabledStrict");
export const developerOptionForProvider = replay(table, "developerOptionForProvider");
export const developerSettingsView = replay(table, "developerSettingsView");
export const normalizeDeveloperConfig = replay(table, "normalizeDeveloperConfig");
