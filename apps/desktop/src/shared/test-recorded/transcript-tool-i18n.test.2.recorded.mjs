// Node b6f10295a src/runtime/agent/orchestrator/session/transcript-restore/restore.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./transcript-tool-i18n.test.2.recorded.json', import.meta.url), 'utf8'));
export const modelSwitchItem = replay(table, "modelSwitchItem");
export const orchestrationModeSwitchItem = replay(table, "orchestrationModeSwitchItem");
export const restoreTranscriptItems = replay(table, "restoreTranscriptItems");
export const sessionContextSnapshotProjection = replay(table, "sessionContextSnapshotProjection");
export const workflowSwitchItem = replay(table, "workflowSwitchItem");
