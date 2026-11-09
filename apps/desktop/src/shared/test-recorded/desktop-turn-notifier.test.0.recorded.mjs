// Node b6f10295a2f698afc85332467192de28500bd146 src/runtime/agent/orchestrator/session/transcript-restore/restore.mjs, recorded from apps/desktop/src/main/desktop-turn-notifier.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./desktop-turn-notifier.test.0.recorded.json', import.meta.url), 'utf8'));
export const modelSwitchItem = replay(table, "modelSwitchItem");
export const orchestrationModeSwitchItem = replay(table, "orchestrationModeSwitchItem");
export const restoreTranscriptItems = replay(table, "restoreTranscriptItems");
export const sessionContextSnapshotProjection = replay(table, "sessionContextSnapshotProjection");
export const workflowSwitchItem = replay(table, "workflowSwitchItem");
