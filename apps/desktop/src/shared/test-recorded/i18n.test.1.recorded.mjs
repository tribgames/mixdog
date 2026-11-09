// Node b6f10295a src/runtime/shared/developer-options.mjs, recorded from the original test's run; replayed by call.
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
