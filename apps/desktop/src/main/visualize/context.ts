/**
 * The visualize service's shared context: the per-service state and the
 * collaborator groups every handler group is built from. Each group factory
 * takes the `Pick` of the fields it reads, and reads late-bound groups through
 * the context only when called, so groups may depend on each other.
 */
import type { LeaseGuard } from './lease-guard';
import type { OpenActions } from './open-actions';
import type { ExportActions } from './export-actions';
import type { Panes } from './panes';
import type { ProblemTracker } from './problem-tracker';
import type { Reloads } from './reloads';
import type { VisualizeServiceDeps } from './service';
import type { SessionViews } from './session-views';
import type { SessionState } from './tab-state';
import type { TabLifecycle } from './tabs';
import type { TabVersionRecords } from './tab-versions';
import type { Thumbnails } from './thumbnails';
import type { VersionRestore } from './version-restore';
import type { VersionSelection } from './version-select';
import type { VisualizeVersionStore } from './versions';

/** How long a newly shown tab gets to mount and load. */
export const ACTIVATE_SETTLE_MS = 500;

export type TabVersions = TabVersionRecords & VersionSelection & VersionRestore;

export interface VisualizeServiceContext {
  deps: VisualizeServiceDeps;
  sessions: Map<string, SessionState>;
  /** The session's state, created empty on first use. */
  sessionOf(sessionId: string): SessionState;
  delay(ms: number): Promise<void>;
  /** Version history of file tabs; null when history is off. */
  versions: VisualizeVersionStore | null;
  /** The working directory each session last opened files in (reopen from a
   *  chat card). */
  sessionCwds: Map<string, string>;
  /** Each scheduled file-change reload, from its debounce until it finished
   *  (or was superseded/cancelled), and each thumbnail job: what `settled()`
   *  waits for. */
  pendingReloads: Set<Promise<void>>;
  /** The next start order of an open or file reload (`TabState.loadedStamp`). */
  nextLoadStamp(): number;
  /** Push the session's state to the renderer and the remote mirror;
   *  `revealTab`: an agent open or a content update of that tab, which the
   *  renderer brings up by the panel's open policy (visualize-store). */
  publish(sessionId: string, revealTab?: string): void;
  views: SessionViews;
  thumbnails: Thumbnails;
  problems: ProblemTracker;
  leases: LeaseGuard;
  panes: Panes;
  tabVersions: TabVersions;
  reloads: Reloads;
  tabs: TabLifecycle;
  opens: OpenActions;
  exports: ExportActions;
}
