// Node b6f10295a src/runtime/agent/orchestrator/session/loop/tool-exec/before-hook.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./ApprovalCard.slow.test.0.recorded.json', import.meta.url), 'utf8'));
export const ALLOW_NOT_SAVED_NOTICE = replay(table, "ALLOW_NOT_SAVED_NOTICE");
export const CONNECTOR_APPROVAL_REASON = replay(table, "CONNECTOR_APPROVAL_REASON");
export const applyBeforeToolHook = replay(table, "applyBeforeToolHook");
export const applyConnectorApproval = replay(table, "applyConnectorApproval");
export const applyShellElevationGate = replay(table, "applyShellElevationGate");
