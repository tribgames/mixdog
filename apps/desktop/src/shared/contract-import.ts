// "Import conversations from other apps": the runtime capability names, their
// DTOs, and the desktop event that streams job progress.

export const DESKTOP_IMPORT_CAPABILITIES = [
  'listImportableConversations',
  'getConversationImportJobs',
  'registerConversationImportFile',
  'startConversationImport',
  'cancelConversationImport',
] as const;

export const DESKTOP_IMPORT_READ_CAPABILITIES = ['listImportableConversations', 'getConversationImportJobs'] as const;

export type DesktopImportCapability = (typeof DESKTOP_IMPORT_CAPABILITIES)[number];

/** Desktop event (main → renderer) carrying one ImportJob snapshot per change. */
export const CONVERSATION_IMPORT_PROGRESS_EVENT = 'conversation-import-progress';

export type ConversationImportSource = 'codex' | 'claude' | 'devin';

export interface ConversationImportRow {
  /** Opaque backend handle. */
  id: string;
  source: ConversationImportSource;
  title: string | null;
  cwd: string | null;
  modifiedAt: number;
  messageCount: number | null;
  importedSessionId: string | null;
  warnings: string[];
}

export type ConversationImportJobState = 'running' | 'stopping' | 'completed' | 'stopped' | 'failed';

export interface ConversationImportJob {
  jobId: string;
  seq: number;
  state: ConversationImportJobState;
  total: number;
  processed: number;
  imported: number;
  skippedAlreadyImported: number;
  failed: number;
  /** Job-level engine error code (e.g. `noModelRoute`). */
  errorCode?: string;
  /** The conversation being processed right now. */
  current: { candidateId: string; title: string | null } | null;
  byProject: Array<{
    projectPath: string | null;
    imported: number;
    skippedAlreadyImported: number;
    failed: number;
  }>;
  results: Array<{
    candidateId: string;
    status: 'imported' | 'alreadyImported' | 'failed';
    sessionId?: string;
    errorCode?: string;
    warnings: string[];
    /** The conversation's title, when it has one. */
    title?: string | null;
    /** File name of the source record, to tell untitled records apart. */
    sourceName?: string | null;
  }>;
}

export interface ConversationImportListInput {
  source: ConversationImportSource;
  query?: string;
  project?: string;
  /** Epoch ms, inclusive. */
  modifiedAfter?: number;
  /** Epoch ms, exclusive. */
  modifiedBefore?: number;
  cursor?: string;
  /** Default 50, max 100. */
  limit?: number;
}

export interface ConversationImportList {
  searchedRoot: string;
  viewId: string;
  complete: boolean;
  matchedCount: number;
  selectableCount: number;
  projects: Array<{ cwd: string; count: number }>;
  rows: ConversationImportRow[];
  nextCursor: string | null;
}

export type ConversationImportSelection = { ids: string[] } | { viewId: string; excludeIds: string[] };

export interface ConversationImportStartInput {
  requestId: string;
  selection: ConversationImportSelection;
}

export const isConversationImportJobActive = (job: Pick<ConversationImportJob, 'state'>): boolean =>
  job.state === 'running' || job.state === 'stopping';
