// Raised by the import dialog once a single import finished; App refreshes the
// session catalog and opens the session through its normal navigation.
export const OPEN_IMPORTED_SESSION_EVENT = 'mixdog:open-imported-session';

/** Raised by the batch-import summary's "View chats"; App shows the Sessions list. */
export const SHOW_IMPORTED_CHATS_EVENT = 'mixdog:show-imported-chats';

/** Raised once imported projects are registered; App refreshes its session and project catalogs. */
export const IMPORT_CATALOGS_CHANGED_EVENT = 'mixdog:import-catalogs-changed';

export interface OpenImportedSessionDetail {
  sessionId: string;
}
