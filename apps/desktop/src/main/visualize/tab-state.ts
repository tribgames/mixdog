/**
 * The visualize service's tab model: the per-session and per-tab state main
 * keeps, and the pure views of it (the renderer's tab view, tool-result
 * summaries and notes, remote-safe paths and labels).
 */
import { createHash } from 'node:crypto';
import { basename, isAbsolute, relative, sep } from 'node:path';

import type {
  VisualizeInlineContent,
  VisualizeInlineKind,
  VisualizePaneView,
  VisualizeProblem,
  VisualizeTabView,
  VisualizeVersionTurn,
  VisualizeVersionView,
} from '../../shared/visualize';
import type { VisualizeAnnotation } from '../../shared/visualize-annotations';
import type { HistoryEntry } from './history';
import { formatProblemsSection, localizeProblemText } from './page-problems';
import type { VisualizeTarget } from './targets';

export type FileTarget = Exclude<VisualizeTarget, { kind: 'url' }>;

/** A kept version on screen in place of (or beside) the live files. */
export interface ShownVersion {
  n: number;
  /** Each pane file in the version's snapshot folder, rooted in its kept folder. */
  targets: FileTarget[];
  panes: VisualizePaneView[];
  /** Its kept page assets that differ from the current files, by their
   *  root-qualified names (`keptAssetNames`): what the restore confirm lists. */
  restoreAssets: string[];
}

export interface VisualizeTabSummary {
  id: string;
  label: string;
  kind: string;
  target: string;
}

export interface VisualizeResult {
  text: string;
  tabs?: VisualizeTabSummary[];
  path?: string;
  /** The tab's page problems, when it has any (the text already lists them). */
  problems?: VisualizeProblem[];
  /** The conversation whose panel the call acted on, when it ran for another
   *  session's work (a sub-agent, a room member); its chat cards read it. */
  ownerSessionId?: string;
}

export interface TabState {
  id: string;
  label: string;
  /** Identity for reuse: the resolved targets in order. */
  key: string;
  cwd: string;
  /** Start order (`loadStamp`) of the open or reload whose files and `cwd`
   *  the tab holds: an older reload finishing late never overwrites them. */
  loadedStamp?: number;
  revision: number;
  /** Web URL tabs live in the browser panel and carry no panes. */
  url?: string;
  /** Each with the root (resolved when the target was) its page assets,
   *  versions, restores and remote reads are contained in: the display-only
   *  path math of a publish never touches the file system. */
  targets: FileTarget[];
  panes: VisualizePaneView[];
  unwatch: Array<() => void>;
  reloadTimer: NodeJS.Timeout | null;
  /** The live files are gone (deleted, or their folder removed): the tab shows
   *  a "file was removed" notice and retries until they are back. */
  missing?: boolean;
  /** Retries a failed reload (see reloads.ts); not a pending reload. */
  retryTimer?: NodeJS.Timeout | null;
  /** Distinct runtime problems since the last reload (replaced, never mutated). */
  problems: VisualizeProblem[];
  /** Bumps on every report, repeats included: a page still erroring is not settled. */
  problemSeq: number;
  /** Outside network for this tab's pages; on for every opened tab (like the
   *  browser panel). The guard still reports refused requests if it is cleared. */
  allowNetwork?: boolean;
  /** Kept versions (file tabs, with history on). */
  versions?: VisualizeVersionView[];
  /** The kept version shown instead of live (null/absent = live). */
  shown?: ShownVersion | null;
  /** The shown version sits beside the live files. */
  compare?: boolean;
  /** A file changed while a kept version was shown; reload on back to live. */
  pendingReload?: boolean;
  /** The last snapshot was skipped: the session's version history is full. */
  historyFull?: boolean;
  /** The chat card's picture (a PNG data URL)… */
  thumbnail?: string;
  /** …of this version (0 for a tab without versions). */
  thumbnailVersion?: number;
  /** Direct-renderer tabs: the live content (no files, `targets` is empty). */
  inline?: VisualizeInlineContent;
  /** Kept contents of an inline tab, oldest first (held in memory), with the
   *  card picture each version's turn ended on. */
  inlineHistory?: Array<{
    n: number;
    at: number;
    content: VisualizeInlineContent;
    thumbnail?: string;
    turns?: VisualizeVersionTurn[];
  }>;
  /** Displayed pane indices whose inline render finished since the last open. */
  rendered?: Set<number>;
  /** Render ids already spent, with the tab revision they were issued for. */
  rendersSpent?: Map<string, number>;
  /** The agent's annotation marks and the revision they were made on: any
   *  remount (reload, version, network switch) leaves them behind. */
  annotations?: { revision: number; marks: VisualizeAnnotation[] };
}

/** The tab's marks for what it shows now (none once its revision moved on). */
export const currentAnnotations = (tab: TabState): VisualizeAnnotation[] =>
  tab.annotations && tab.annotations.revision === tab.revision ? tab.annotations.marks : [];

export interface SessionState {
  tabs: TabState[];
  active: string | null;
  counter: number;
  /** Everything opened this session, newest first (see history.ts). */
  history: HistoryEntry[];
}

/** The kind a tab's panes show together: the single pane's, else `split`. */
export const paneKindOf = (tab: TabState): VisualizePaneView['kind'] | 'split' =>
  tab.panes.length === 1 ? tab.panes[0].kind : 'split';

export function summary(tab: TabState): VisualizeTabSummary {
  if (tab.url) return { id: tab.id, label: tab.label, kind: 'url', target: tab.url };
  return {
    id: tab.id,
    label: tab.label,
    kind: paneKindOf(tab),
    target: tab.inline ? inlinePaneTarget(tab.inline) : tab.targets.map((target) => target.target).join(' | '),
  };
}

/** `summary` for an export result: file targets as project-relative paths and
 *  no host path or page-server URL in the label. */
export function exportSummary(tab: TabState, cwd: string): VisualizeTabSummary {
  const base = summary(tab);
  if (tab.url) return base;
  return {
    ...base,
    label: localizeProblemText(base.label, [cwd, ...problemRootsOf(tab)]),
    target: tab.inline ? base.target : tab.targets.map((target) => remoteTargetOf(target)).join(' | '),
  };
}

/** The host folders kept out of the tab's problem text: its cwd and the
 *  roots of its live files. */
export const problemRootsOf = (tab: TabState): string[] => [
  ...new Set([tab.cwd, ...tab.targets.map((target) => target.root)]),
];

const INLINE_LABELS: Record<VisualizeInlineKind, string> = {
  mermaid: 'Mermaid diagram',
  svg: 'SVG',
  chart: 'Chart',
  html: 'HTML',
  markdown: 'Markdown',
};

/** What an inline pane is called as a target (never a host path). */
const inlinePaneTarget = (content: VisualizeInlineContent): string => content.title ?? `inline ${content.kind}`;

export const inlinePane = (content: VisualizeInlineContent): VisualizePaneView => ({
  kind: 'inline',
  label: content.title ?? INLINE_LABELS[content.kind],
  target: inlinePaneTarget(content),
  url: '',
  inline: content,
});

/** Reuse identity of an inline tab: its title, else its exact content. */
export const inlineKey = (content: VisualizeInlineContent): string =>
  content.title
    ? `inline:${content.title}`
    : `inline:${content.kind}:${createHash('sha1').update(content.source).digest('hex')}`;

export const sameInline = (a: VisualizeInlineContent, b: VisualizeInlineContent): boolean =>
  a.kind === b.kind && a.source === b.source && a.title === b.title;

/** A target as a remote client may see it: relative to its root, or the file
 *  name when it is not representable that way. Pure path math: called on
 *  every publish. */
export function remoteTargetOf(target: FileTarget): string {
  const rel = relative(target.root, target.path);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return basename(target.path);
  return rel.split(sep).join('/');
}

/** Absolute paths in free text: POSIX roots, drive letters, UNC shares, ~/. */
const ABSOLUTE_PATH = /(?:^|[\s"'`(=,:;[])(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\|~[\\/])/;

/** The tab label a remote client may see: the agent's label unless it names a
 *  host path (cwd, a raw target or any absolute path), else the panes. */
export function remoteLabelOf(tab: TabState, panes: Array<{ target: string; remoteTarget: string }>): string {
  const fallback = panes.map((pane) => pane.remoteTarget).join(' · ');
  const label = tab.label;
  const named = [tab.cwd, ...panes.filter((pane) => isAbsolute(pane.target)).map((pane) => pane.target)];
  if (ABSOLUTE_PATH.test(label) || named.some((path) => path && label.includes(path))) return fallback;
  return label;
}

/** Compare layout: version pane, live pane, version pane, live pane… */
export function interleave<T>(shown: T[], live: T[]): T[] {
  return shown.flatMap((pane, index) => (live[index] ? [pane, live[index]] : [pane]));
}

/** The tab's layout of anything per pane: `live` alone, the kept version's
 *  `old` alone, or both interleaved in compare. */
export function shownLayout<T>(tab: TabState, old: T[], live: T[]): T[] {
  if (!tab.shown) return live;
  return tab.compare ? interleave(old, live) : old;
}

/** What the tab draws: live panes, a kept version's, or both interleaved. */
export function displayedPanes(tab: TabState): VisualizePaneView[] {
  const shown = tab.shown;
  if (!shown) return tab.panes;
  const old = shown.panes.map((pane) => ({ ...pane, version: shown.n }));
  return tab.compare ? interleave(old, tab.panes) : old;
}

function versionFields(tab: TabState): Pick<VisualizeTabView, 'versions' | 'version' | 'compare' | 'restoreAssets'> {
  if (!tab.versions) return {};
  return {
    versions: tab.versions,
    version: tab.shown?.n ?? null,
    ...(tab.shown && tab.compare ? { compare: true } : {}),
    ...(tab.shown?.restoreAssets.length ? { restoreAssets: tab.shown.restoreAssets } : {}),
  };
}

/** The tool result's note on a tab's history (once it has 2+ versions, or
 *  when the current files could not be kept). */
export function versionNote(tab: TabState): string {
  const full = tab.historyFull
    ? " The current files were not kept as a version: this session's version history is full (close visualize tabs to free it)."
    : '';
  const list = tab.versions ?? [];
  if (list.length < 2 && !tab.shown) return full;
  const range = list.length ? ` (v${list[0].n}–v${list.at(-1)?.n})` : '';
  if (tab.shown) {
    return ` Showing kept version v${tab.shown.n} of ${list.length}${range}, read-only; live reloads wait until the user goes back to live.${full}`;
  }
  return ` ${list.length} versions kept${range}; pass input.version to show an older one.${full}`;
}

export function view(tab: TabState): VisualizeTabView {
  return {
    id: tab.id,
    label: tab.label,
    revision: tab.revision,
    panes: displayedPanes(tab),
    ...(tab.missing && !tab.shown ? { missing: true as const } : {}),
    ...(tab.problems.length ? { problems: tab.problems } : {}),
    ...(tab.allowNetwork ? { networkAllowed: true as const } : {}),
    ...versionFields(tab),
    ...(tab.thumbnail ? { thumbnail: tab.thumbnail, thumbnailVersion: tab.thumbnailVersion ?? 0 } : {}),
    ...(currentAnnotations(tab).length ? { annotations: currentAnnotations(tab) } : {}),
  };
}

/** The tool result's problems section, appended to `text` when there is one. */
export function withProblems(tab: TabState, text: string): string {
  const section = formatProblemsSection(
    tab.id,
    tab.problems,
    displayedPanes(tab).map((pane) => pane.label)
  );
  return section ? `${text}\n${section}` : text;
}

export const problemsOf = (tab: TabState): Pick<VisualizeResult, 'problems'> =>
  tab.problems.length ? { problems: tab.problems } : {};
