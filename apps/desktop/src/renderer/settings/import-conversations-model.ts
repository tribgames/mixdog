// Selection, filter and message logic of the "Import conversations" dialog.
import type {
  ConversationImportJob,
  ConversationImportRow,
  ConversationImportSelection,
} from '../../shared/contract-import';
import { t } from '../i18n';

/** What the selection means: `all` = every selectable row of the current view
 *  except `ids`; otherwise only `ids`. Rows never loaded count too. */
export interface ImportSelectionState {
  all: boolean;
  ids: ReadonlySet<string>;
}

export const EMPTY_IMPORT_SELECTION: ImportSelectionState = { all: false, ids: new Set() };

export type SelectAllState = 'none' | 'mixed' | 'all';

export const isRowSelectable = (row: Pick<ConversationImportRow, 'importedSessionId'>): boolean =>
  row.importedSessionId === null;

export function isRowSelected(selection: ImportSelectionState, row: ConversationImportRow): boolean {
  if (!isRowSelectable(row)) return false;
  return selection.all ? !selection.ids.has(row.id) : selection.ids.has(row.id);
}

/** Flips one row; an already-imported row is never selectable. */
export function toggleImportRow(selection: ImportSelectionState, row: ConversationImportRow): ImportSelectionState {
  if (!isRowSelectable(row)) return selection;
  const ids = new Set(selection.ids);
  if (ids.has(row.id)) ids.delete(row.id);
  else ids.add(row.id);
  return { all: selection.all, ids };
}

export function selectedImportCount(selection: ImportSelectionState, selectableCount: number): number {
  return Math.max(0, selection.all ? selectableCount - selection.ids.size : selection.ids.size);
}

export function selectAllState(selection: ImportSelectionState, selectableCount: number): SelectAllState {
  const count = selectedImportCount(selection, selectableCount);
  if (count === 0) return 'none';
  return count >= selectableCount ? 'all' : 'mixed';
}

/** Checked → clear; unchecked or mixed → every selectable row of the view. */
export function toggleSelectAll(selection: ImportSelectionState, selectableCount: number): ImportSelectionState {
  if (selectAllState(selection, selectableCount) === 'all' || selectableCount === 0) return EMPTY_IMPORT_SELECTION;
  return { all: true, ids: new Set() };
}

export function importSelectionPayload(selection: ImportSelectionState, viewId: string): ConversationImportSelection {
  return selection.all ? { viewId, excludeIds: [...selection.ids] } : { ids: [...selection.ids] };
}

/** One selected row continues straight into the session; more are a batch. */
export function importButtonLabel(count: number, canContinue = count === 1): string {
  if (count <= 0) return t('Import');
  return count === 1 && canContinue ? t('Import and continue') : t('Import {{count}}', { count });
}

export type ImportTimeRange = 'all' | '7' | '30' | '90';

export const IMPORT_TIME_RANGES: ReadonlyArray<{ value: ImportTimeRange; label: () => string }> = [
  { value: 'all', label: () => t('All time') },
  { value: '7', label: () => t('Last 7 days') },
  { value: '30', label: () => t('Last 30 days') },
  { value: '90', label: () => t('Last 90 days') },
];

const DAY_MS = 86_400_000;

/** `modifiedAfter` (inclusive epoch ms) for a range; undefined for all time. */
export function importModifiedAfter(range: ImportTimeRange, now = Date.now()): number | undefined {
  return range === 'all' ? undefined : now - Number(range) * DAY_MS;
}

/** Message for an engine error or warning code. */
export function importCodeMessage(code: string | undefined): string {
  switch (code) {
    case 'unreadable':
      return t('The file could not be read.');
    case 'malformed':
      return t('The file is damaged.');
    case 'empty':
      return t('The conversation has no messages.');
    case 'unsupported':
      return t('The file format is not supported.');
    case 'cwdMissing':
      return t('The original project folder no longer exists.');
    case 'imageOmitted':
      return t('Images were left out.');
    case 'viewExpired':
      return t('The list is out of date. Reopen it and try again.');
    case 'invalidCursor':
      return t('The list could not be continued. Reload it and try again.');
    case 'invalidPath':
      return t('That file path is not valid.');
    case 'jobNotFound':
      return t('That import is no longer available.');
    case 'unknownCandidate':
      return t('That conversation is no longer in the list.');
    case 'noModelRoute':
      return t('Connect a model in Settings > Providers first.');
    case 'tooLarge':
      return t('The conversation is too large to import.');
    case 'internalRecord':
      return t('This is an internal record (a subagent or review), not a conversation.');
    case 'historyPartial':
      return t('Part of this conversation is stored in another file and was left out.');
    case 'historySizeLimit':
      return t('Earlier history was left out because it is over the size limit.');
    case 'historyUnavailable':
      return t('Earlier history was left out because its file is missing or could not be read.');
    case 'needsNewerNode':
      return t('This conversation is stored compressed. Update Node.js to read it.');
    default:
      return t('The conversation could not be imported.');
  }
}

const OMISSION_CODES: ReadonlySet<string> = new Set([
  'historyPartial',
  'historySizeLimit',
  'historyUnavailable',
  'needsNewerNode',
]);

/** Messages of a row's warnings that say content is missing or unreadable, shown on the row itself. */
export const importRowNotices = (row: Pick<ConversationImportRow, 'warnings'>): string[] =>
  row.warnings.filter((code) => OMISSION_CODES.has(code)).map(importCodeMessage);

/** The engine error code a rejected call's message carries, if any. */
export function importCodeFromError(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /\b(viewExpired|invalidCursor|invalidPath|unsupported|unreadable|jobNotFound|empty|malformed|unknownCandidate|importFailed|noModelRoute|cwdMissing|imageOmitted|tooLarge|internalRecord|historyPartial|historySizeLimit|historyUnavailable|needsNewerNode)\b/.exec(
    message
  )?.[1];
}

export interface ImportFailureRecord {
  candidateId: string;
  /** What names the record: its title, else its source file name. */
  label: string;
}

/** Failed records listed per reason before the rest are folded away. */
export const IMPORT_FAILURES_SHOWN = 10;

/**
 * Distinct failure codes of a finished job. `count` is every conversation that
 * hit the code; `records` names at most `IMPORT_FAILURES_SHOWN` of them unless
 * the code is in `expanded`.
 */
export function importFailureSummary(
  job: ConversationImportJob,
  expanded: ReadonlySet<string> = new Set()
): Array<{ code: string; count: number; records: ImportFailureRecord[] }> {
  const groups = new Map<string, { count: number; records: ImportFailureRecord[] }>();
  for (const result of job.results) {
    if (result.status !== 'failed') continue;
    const code = result.errorCode ?? '';
    const group = groups.get(code) ?? { count: 0, records: [] };
    group.count += 1;
    if (expanded.has(code) || group.records.length < IMPORT_FAILURES_SHOWN) {
      group.records.push({
        candidateId: result.candidateId,
        label: result.title || result.sourceName || t('Untitled session'),
      });
    }
    groups.set(code, group);
  }
  return [...groups].map(([code, group]) => ({ code, ...group }));
}

/** Distinct warning codes across a finished job's results. */
export function importWarningCodes(job: ConversationImportJob): string[] {
  return [...new Set(job.results.flatMap((result) => result.warnings))];
}

export const projectLabel = (projectPath: string | null): string => {
  if (!projectPath) return t('No project');
  const parts = projectPath.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? projectPath;
};

const normalizePath = (value: string): string => {
  const slashed = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(slashed) ? slashed.toLowerCase() : slashed;
};

export const isKnownProject = (projects: ReadonlyArray<{ path: string }>, cwd: string): boolean =>
  projects.some((project) => normalizePath(project.path) === normalizePath(cwd));
