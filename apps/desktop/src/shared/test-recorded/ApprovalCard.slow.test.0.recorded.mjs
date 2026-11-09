// Node b6f10295a2f698afc85332467192de28500bd146 src/runtime/agent/orchestrator/session/loop/tool-exec/before-hook.mjs, recorded from apps/desktop/src/renderer/ApprovalCard.slow.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./ApprovalCard.slow.test.0.recorded.json', import.meta.url), 'utf8'));
export const ALLOW_NOT_SAVED_NOTICE = replay(table, "ALLOW_NOT_SAVED_NOTICE");
export const CONNECTOR_APPROVAL_REASON = replay(table, "CONNECTOR_APPROVAL_REASON");
export const applyBeforeToolHook = replay(table, "applyBeforeToolHook");
export const applyConnectorApproval = replay(table, "applyConnectorApproval");
export const applyShellElevationGate = replay(table, "applyShellElevationGate");
