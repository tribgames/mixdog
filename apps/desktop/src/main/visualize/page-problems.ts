/**
 * Runtime problems of a visualize HTML pane, as the agent and the panel see
 * them: classified from the page's console output, localized so no host path or
 * page-server URL survives, deduped and capped per tab.
 */
import {
  localizeLoopbackUrls,
  MAX_VISUALIZE_PROBLEMS,
  visualizeProblemLocation,
  type VisualizeProblem,
  type VisualizeProblemKind,
} from '../../shared/visualize';

const MAX_MESSAGE_CHARS = 300;
const MAX_SOURCE_CHARS = 200;
/** Lines of the "Page problems" section; the rest is summarized. */
const MAX_LISTED_PROBLEMS = 10;

/** The `http://127.0.0.1:<port>/<token>/` prefix every page and asset of one
 *  page-server lease shares; '' for any other URL. */
export function leasePrefixOf(url: string): string {
  return /^https?:\/\/[^/]+\/[^/]+\//.exec(url)?.[0] ?? '';
}

/** Windows drive / UNC / file: URL paths, and POSIX paths under the usual
 *  system and home roots, anywhere in free text. */
const HOST_PATH =
  /(?:file:\/\/\/?)?(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>()]*|file:\/\/\/[^\s"'`<>()]*|(?<![\w:/.])\/(?:Users|home|root|tmp|var|mnt|opt|private|etc|usr)\/[^\s"'`<>()]*/g;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `text` with page-server URLs reduced to project-relative paths, the working
 *  directory dropped from paths under it, and any other host path reduced to
 *  its file name. */
export function localizeProblemText(text: string, roots: readonly string[]): string {
  let out = localizeLoopbackUrls(text);
  for (const root of roots) {
    const segments = root.split(/[\\/]+/).filter(Boolean);
    if (!segments.length) continue;
    const lead = /^[\\/]/.test(root) ? '[\\\\/]+' : '';
    const pattern = new RegExp(
      `(?:file:\\/\\/\\/?)?${lead}${segments.map(escapeRegExp).join('[\\\\/]+')}(?:[\\\\/]+|(?![\\w]))`,
      process.platform === 'win32' ? 'gi' : 'g'
    );
    out = out.replace(pattern, '');
  }
  return out.replace(HOST_PATH, (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? '');
}

export interface PageConsoleReport {
  level: string;
  message: string;
  sourceId: string;
  lineNumber: number;
}

/** The problem a console message is, or null for ordinary log output. */
export function classifyConsole(
  report: Pick<PageConsoleReport, 'level' | 'message'>
): { kind: VisualizeProblemKind; message: string } | null {
  if (report.level !== 'error' && report.level !== 'warning') return null;
  const { message } = report;
  if (/^Uncaught \(in promise\)/.test(message)) return { kind: 'rejection', message };
  if (/^Uncaught\b/.test(message)) return { kind: 'exception', message };
  if (/Content[- ]Security[- ]Policy|^Refused to /.test(message)) return { kind: 'csp', message };
  // A failed resource load is reported by the network layer (host.ts), with
  // its status; Chromium does not log it to the page console.
  if (/^Failed to load resource/.test(message)) return null;
  // A ResizeObserver whose callback resizes what it observes (a fit-to-width
  // mockup) defers the rest to the next frame; Chromium logs that as an error
  // whenever the panel resizes the frame. Nothing is broken, and the
  // off-screen render never resizes, so it would show only in the panel.
  if (/^ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)/.test(message)) return null;
  return { kind: report.level === 'error' ? 'console-error' : 'console-warn', message };
}

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** A problem ready to record: texts localized and bounded. */
export function buildProblem(
  draft: { kind: VisualizeProblemKind; message: string; source: string; line: number; pane: number; version?: number },
  roots: readonly string[]
): VisualizeProblem {
  return {
    ...(typeof draft.version === 'number' ? { version: draft.version } : {}),
    kind: draft.kind,
    message: clip(localizeProblemText(draft.message, roots).trim(), MAX_MESSAGE_CHARS),
    source: clip(localizeProblemText(draft.source, roots), MAX_SOURCE_CHARS),
    line: Number.isFinite(draft.line) && draft.line > 0 ? Math.floor(draft.line) : 0,
    count: 1,
    pane: draft.pane,
  };
}

const sameProblem = (a: VisualizeProblem, b: VisualizeProblem) =>
  a.kind === b.kind &&
  a.pane === b.pane &&
  a.version === b.version &&
  a.message === b.message &&
  a.source === b.source &&
  a.line === b.line;

/** `problem` added to `list`: a repeat only raises the count of the existing
 *  entry; a new one is dropped once the list holds the cap. `added` is true
 *  only when the set of distinct problems grew. */
export function recordProblem(
  list: readonly VisualizeProblem[],
  problem: VisualizeProblem
): { list: VisualizeProblem[]; added: boolean } {
  const index = list.findIndex((candidate) => sameProblem(candidate, problem));
  if (index >= 0) {
    const next = [...list];
    next[index] = { ...list[index], count: list[index].count + 1 };
    return { list: next, added: false };
  }
  if (list.length >= MAX_VISUALIZE_PROBLEMS) return { list: [...list], added: false };
  return { list: [...list, problem], added: true };
}

/** The "Page problems" section of a tool result, or '' when there are none. */
export function formatProblemsSection(
  tabId: string,
  problems: readonly VisualizeProblem[],
  paneLabels: string[]
): string {
  if (!problems.length) return '';
  const lines = problems.slice(0, MAX_LISTED_PROBLEMS).map((problem) => {
    const where = visualizeProblemLocation(problem);
    const label = paneLabels.length > 1 ? paneLabels[problem.pane] : '';
    const kept = typeof problem.version === 'number' ? `kept v${problem.version}` : '';
    const pane = label || kept ? `[${[label, kept].filter(Boolean).join(' ')}] ` : '';
    return `- ${pane}${problem.kind}: ${problem.message}${where ? ` (${where})` : ''}${problem.count > 1 ? ` ×${problem.count}` : ''}`;
  });
  if (problems.length > lines.length) lines.push(`- …and ${problems.length - lines.length} more`);
  const blocked = problems.some(
    (problem) => problem.kind === 'blocked-network' || problem.kind === 'blocked-navigation'
  )
    ? [
        'blocked-network: visualize pages cannot reach the outside network unless the user allows it; make the page self-contained (inline or bundle the file in the project) instead of loading it from a CDN or API.',
      ]
    : [];
  return [
    `Page problems on tab ${tabId} (${problems.length}):`,
    ...lines,
    ...blocked,
    'Fix these before reporting.',
  ].join('\n');
}
