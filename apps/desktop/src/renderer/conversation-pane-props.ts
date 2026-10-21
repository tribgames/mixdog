import type { ReactNode } from 'react';
import type {
  DesktopModelSelection,
  DesktopOrchestrationMode,
  DesktopProjectSummary,
  DesktopPromptContent,
  DesktopSubmitOptions,
  DesktopWorkflowState,
  SessionSnapshot,
} from '../shared/contract';
import type { Snapshot } from './desktop-types';
import type { CommandSurface as CommandSurfaceName, SettingsSection } from './slash-commands';
import type { TranscriptAssistantRowProps } from './TranscriptAssistantRow';

export type ConversationProps = {
  snapshot: Snapshot;
  routeSnapshot: Snapshot;
  /** Pane ownership resolves to this canonical session address. */
  sessionAddress?: string;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  errors: string[];
  submit: (content: DesktopPromptContent, options?: DesktopSubmitOptions) => Promise<unknown>;
  applySnapshot: (snapshot: SessionSnapshot | null) => void;
  transitioning: boolean;
  composerFocusRequest: number;
  onNewTask: () => void;
  /** Session-pane /clear · /new: close this session's tab and open a New
   *  Task in its place with the session's settings inherited. */
  onClearToNewTask?: (sessionId: string) => void;
  onClearProject: () => void;
  onResumeSession: (id: string) => void;
  onOpenSessions: () => void;
  onOpenProjects: () => void;
  onOpenSettings: (section?: SettingsSection | null) => void;
  projects: DesktopProjectSummary[];
  showProjectSelector: boolean;
  activeProjectPath: string;
  activeProjectLabel: string;
  onSelectProject: (path: string) => void;
  draftMode?: boolean;
  /** Distinct New Task pane identity: pressing New task mints a new one, so
   *  the composer opens clean instead of inheriting the previous draft. */
  draftId?: string;
  draftModelSelection?: DesktopModelSelection | null;
  draftWorkflow?: DesktopWorkflowState | null;
  draftOrchestrationMode?: DesktopOrchestrationMode | null;
  onDraftModelSelection?: (selection: DesktopModelSelection) => void;
  onRoutePreferenceApplied?: (selection: DesktopModelSelection, options?: { modelChoice?: boolean }) => void;
  onDraftWorkflow?: (workflow: DesktopWorkflowState) => void;
  onDraftOrchestrationMode?: (mode: DesktopOrchestrationMode) => void;
  onOpenCommandSurface: (surface: CommandSurfaceName) => void;
  /** Context card → Inherit session and /inherit, run in place (user: 팝업 안
   *  뜨고 바로 진행되게). The pane holds the source session and its route; the
   *  host creates the heir and opens its tab. */
  onInheritSession?: (sourceSessionId: string, route: DesktopModelSelection) => Promise<void>;
  onOpenFile?: (project: string, rel: string, line?: number, accessToken?: string, column?: number) => void;
  /** Reveals a transcript folder link in the pane's side-dock Files tree. */
  onOpenFolder?: (project: string, rel: string) => void;
  /** The island's changed-files segment: opens the pane's side dock on the
   *  session diff; absent where the surface has no dock. */
  onOpenSessionDiff?: () => void;
  /** The island's jobs panel opens an agent's session. */
  onOpenAgentSession?: (sessionId: string, title: string, ownerSessionId: string) => void;
  /** Selector-driven rows retain their component identity through settlement. */
  renderAssistantRow?: (props: TranscriptAssistantRowProps) => ReactNode;
  /** The Goal segment of the composer island. */
  goalIsland?: ReactNode;
  /** Context gauge seated in the composer footer beside the model trigger
   *  on every surface (user: 컨텍스트는 모델 선택기 옆; 모바일도 PC에 맞춰). */
  contextIndicator?: ReactNode;
  /** The last turn's speed and cache hit, on the line under the composer. */
  usageReadout?: ReactNode;
  /** Transcript-only child-agent view: no submit, retry, approval, review, or
   *  other session runtime-mutating controls are mounted. */
  readOnly?: boolean;
  /** Only the focused, visible session performs background review refreshes. */
  reviewActive?: boolean;
  /** The surface is on screen in its pane (focused or not); a parked one
   *  (behind a file or utility tab) docks no approvals, so they float. */
  surfaceVisible?: boolean;
  /** A warm New Task → session commit paints the requested transcript under
   *  the prior watermark for one frame so Chromium uploads its raster before
   *  it becomes visible. Route identity and interaction are already current. */
  warmPaintHandoff?: boolean;
  /** The rich Markdown chunk this session's rows need has not resolved yet.
   *  The timeline stays UNMOUNTED until it has (the surface cover holds the
   *  frame): the timeline mounts once, with the real rows, so the entry
   *  offset is resolved exactly once. */
  transcriptPending?: boolean;
  /** This session's entry settled: populated rows laid out and every
   *  entry-pending chrome (the review bar's first read) either decided or
   *  timed out (ENTRY_CHROME_MAX_MS); late chrome may still land after. */
  onEntryRevealed?: (sessionKey: string) => void;
  /** The transcript is hidden awaiting its reveal. The pane keeps its loading
   *  cover up for as long as this holds. */
  onTranscriptHiddenChange?: (hidden: boolean) => void;
  /** The pane's loading cover, laid over the transcript viewport only: the
   *  composer dock below it stays painted and usable while rows load. */
  transcriptCover?: ReactNode;
};
