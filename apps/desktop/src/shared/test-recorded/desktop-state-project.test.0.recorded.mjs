// Node b6f10295a2f698afc85332467192de28500bd146 src/runtime/agent/orchestrator/session/store-summary-index.mjs, recorded from apps/desktop/src/main/desktop-state-project.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./desktop-state-project.test.0.recorded.json', import.meta.url), 'utf8'));
export const SESSION_SUMMARY_INDEX_VERSION = replay(table, "SESSION_SUMMARY_INDEX_VERSION");
export const _cleanPreviewMemoStatsForTest = replay(table, "_cleanPreviewMemoStatsForTest");
export const _flushPendingSummaryOps = replay(table, "_flushPendingSummaryOps");
export const _hasUnsettledSummaryOps = replay(table, "_hasUnsettledSummaryOps");
export const _holdSummaryAppends = replay(table, "_holdSummaryAppends");
export const _moveSessionSummaryFingerprints = replay(table, "_moveSessionSummaryFingerprints");
export const _normalizeSummaryIndex = replay(table, "_normalizeSummaryIndex");
export const _pruneSummaryIndexIds = replay(table, "_pruneSummaryIndexIds");
export const _removeSessionSummary = replay(table, "_removeSessionSummary");
export const _sessionSummary = replay(table, "_sessionSummary");
export const _upsertSessionSummary = replay(table, "_upsertSessionSummary");
export const _upsertSessionSummaryRow = replay(table, "_upsertSessionSummaryRow");
export const _writeSummaryIndex = replay(table, "_writeSummaryIndex");
export const compactSummaryIndex = replay(table, "compactSummaryIndex");
export const pendingSummaryIndexIds = replay(table, "pendingSummaryIndexIds");
export const settleSummaryIndexWrites = replay(table, "settleSummaryIndexWrites");
export const summaryIndexPath = replay(table, "summaryIndexPath");
export const summaryLockFailureStats = replay(table, "summaryLockFailureStats");
export const sweepStaleSummaryTempFiles = replay(table, "sweepStaleSummaryTempFiles");
