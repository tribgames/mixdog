// Turn previews: at a turn's end its card (transcript-visualize-card.tsx)
// fills with the files the turn changed that the visualize panel can show,
// beside the tabs the agent's own `visualize` opens made, so an artifact never
// goes missing when the agent did not open it. Pure but for the small
// registries at the end (the live turn end, the files each card shows).
import { type VisualizePaneKind, visualizeKindForPath } from '../shared/visualize';
import { linkedLocalPaths } from './markdown-plugins';
import { isAbsolutePath } from './session-diff-model';
import {
  fileIdentity,
  normalizeChangePath,
  splitChangePath,
  type TurnChangesFile,
  turnChangeOpenPath,
} from './turn-changes-model';

/** The thumbnail's top-left mark: a file the turn created. A modified file
 *  has none (its "version N · updated" says it). */
export type TurnPreviewBadge = 'new';

export interface TurnPreviewFile {
  /** Root-relative path (forward slashes). */
  path: string;
  /** What the panel opens: the path under the reply's root (as is without one). */
  target: string;
  kind: Exclude<VisualizePaneKind, 'inline'>;
  /** The turn created it. */
  created: boolean;
  /** Opened in the panel when the turn ends; a candidate is only listed. */
  confident: boolean;
  badge: TurnPreviewBadge | null;
}

/** "New" for a file the turn created, else none. */
export function turnPreviewBadge(created: boolean): TurnPreviewBadge | null {
  return created ? 'new' : null;
}

const foldPath = (value: string) => normalizeChangePath(value.replace(/\\/g, '/')).toLowerCase();

/** Whether one of `surfaced` (paths a reply linked or the panel opened,
 *  relative or absolute, a bare name allowed) is this file. Case-insensitive. */
export function turnPreviewSurfaced(path: string, surfaced: readonly string[]): boolean {
  const file = foldPath(path);
  const base = splitChangePath(file).base;
  return surfaced.some((entry) => {
    const one = foldPath(entry);
    if (!one) return false;
    if (!one.includes('/')) return one === base;
    return one === file || one.endsWith(`/${file}`) || file.endsWith(`/${one}`);
  });
}

/** The file `target` names under `root`, as the panel opens it. */
function previewTarget(root: string, path: string): string {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return base ? `${base}/${path}` : path;
}

/** The turn's changed files that become preview tiles: on disk as the turn
 *  left them (not deleted, not undone), inside the root, of a kind the panel
 *  shows (`visualizeKindForPath`), and linked by a reply or opened before. The record lists only what
 *  the agent's own file tools wrote (edit, apply_patch, office, tidy; never a
 *  shell command's side effects), so a Git-ignored entry there is still the
 *  turn's artifact, and not already a tile of the agent's
 *  own opens (`opened`: their targets). One per file, confident ones first. */
export function turnPreviewFiles(
  files: readonly TurnChangesFile[],
  root: string,
  opened: readonly string[],
  replyText: string,
  /** Paths surfaced earlier in the conversation (linked by an earlier reply
   *  or opened in the panel): they stay artifacts when a later turn changes them. */
  surfacedBefore: readonly string[] = []
): TurnPreviewFile[] {
  const taken = new Set(opened.map((target) => fileIdentity(root, target)));
  const surfaced = [...linkedLocalPaths(replyText), ...surfacedBefore];
  const previews: TurnPreviewFile[] = [];
  for (const file of files) {
    if (file.state !== 'applied') continue;
    const path = turnChangeOpenPath(file);
    if (!path || isAbsolutePath(path)) continue;
    const kind = visualizeKindForPath(path);
    if (!kind || !turnPreviewSurfaced(path, surfaced)) continue;
    const target = previewTarget(root, path);
    const identity = fileIdentity(root, path);
    if (taken.has(identity)) continue;
    taken.add(identity);
    const created = file.status === 'A';
    previews.push({ path, target, kind, created, confident: true, badge: turnPreviewBadge(created) });
  }
  return previews;
}

/** The mark of an agent open's tile: from the turn's change of its file. */
export function turnPreviewBadgeFor(
  targets: readonly string[],
  files: readonly TurnChangesFile[],
  root: string
): TurnPreviewBadge | null {
  if (targets.length !== 1) return null;
  const identity = fileIdentity(root, targets[0]);
  const file = files.find((candidate) => fileIdentity(root, candidate.path) === identity);
  return file ? turnPreviewBadge(file.status === 'A' && file.state === 'applied') : null;
}

/** The targets the turn's end opens, in order: every confident file, the one
 *  to show (the first the turn created, else the first) last, since each open
 *  brings its own tab up. */
export function turnPreviewOpenOrder(previews: readonly TurnPreviewFile[]): string[] {
  const confident = previews.filter((preview) => preview.confident);
  const shown = confident.find((preview) => preview.created) ?? confident[0];
  if (!shown) return [];
  return [...confident.filter((preview) => preview !== shown), shown].map((preview) => preview.target);
}

export const TURN_PREVIEW_PAGE_SIZE = 6;

/** One page of a card's tiles; `page` is clamped into range. */
export function turnPreviewPage<T>(
  items: readonly T[],
  page: number,
  size: number = TURN_PREVIEW_PAGE_SIZE
): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const at = Math.min(Math.max(0, Math.floor(page) || 0), pages - 1);
  return { items: items.slice(at * size, at * size + size), page: at, pages };
}

// ── The live turn end ────────────────────────────────────────────────────
// A turn's end opens its confident previews once, only for the very turn this
// renderer saw running: the conversation marks that turn (session + turn key)
// while it runs, and the trailing card of that same turn, drawn once it
// stopped, claims the mark for its checkpoint. Any other turn (a later
// checkpoint, a transcript loaded from history) finds no mark; a reconnect
// or the conversation leaving the session drops the session's marks, so an
// ended turn met again there opens nothing; a re-render has none left.
const liveTurns = new Set<string>();
const pendingOpens = new Set<string>();
const previewKey = (sessionId: string, id: string) => `${sessionId}\0${id}`;

/** The key turn `turnKey` carried while it ran. A turn's rows are keyed by
 *  their prompt (`turn:<id>`) until its turndone names a checkpoint, which
 *  re-keys them all (`checkpoint:<id>`, `attempt:<id>`): the running mark and
 *  the ended card must meet on the first row's own id, which never changes. */
export function runningTurnKeyOf(
  items: readonly { kind?: string; id?: unknown }[],
  turnKeys: readonly string[],
  turnKey: string
): string {
  const first = items[turnKeys.indexOf(turnKey)];
  if (first?.id === undefined || first.id === null) return turnKey;
  return `${first.kind === 'user' ? 'turn' : 'segment'}:${String(first.id)}`;
}

/** The conversation shows turn `turnKey` of `sessionId` running right now. */
export function noteTurnRunning(sessionId: string, turnKey: string): void {
  if (sessionId && turnKey) liveTurns.add(previewKey(sessionId, turnKey));
}

/** Forget every running mark and unopened turn end of `sessionId` (a
 *  reconnect, the transcript replaced or left). */
export function forgetTurnPreviewMarks(sessionId: string): void {
  const prefix = previewKey(sessionId, '');
  for (const set of [liveTurns, pendingOpens]) {
    for (const key of [...set]) if (key.startsWith(prefix)) set.delete(key);
  }
}

/** The trailing card of turn `turnKey`, drawn with its turn stopped: takes
 *  that turn's live mark, so its previews open once its changes are known. */
export function claimTurnPreviewEnd(sessionId: string, turnKey: string, checkpointId: string): void {
  if (!checkpointId || !turnKey || !liveTurns.delete(previewKey(sessionId, turnKey))) return;
  pendingOpens.add(previewKey(sessionId, checkpointId));
}

/** True once for a claimed turn end (its opens are then due). */
export function takeTurnPreviewOpen(sessionId: string, checkpointId: string): boolean {
  return pendingOpens.delete(previewKey(sessionId, checkpointId));
}

export function turnPreviewOpenPending(sessionId: string, checkpointId: string): boolean {
  return pendingOpens.has(previewKey(sessionId, checkpointId));
}

// ── The files each card shows ────────────────────────────────────────────
// What a turn's card shows as previews, per session + checkpoint: its
// changed-files card lists none of them (as for the agent's own opens).
const TURN_PREVIEWS_LIMIT = 500;
const NO_TARGETS: readonly string[] = Object.freeze([]);
const shownTargets = new Map<string, readonly string[]>();
const shownListeners = new Set<() => void>();

export function noteTurnPreviewTargets(sessionId: string, checkpointId: string, targets: readonly string[]): void {
  if (!sessionId || !checkpointId) return;
  const key = previewKey(sessionId, checkpointId);
  const known = shownTargets.get(key) ?? NO_TARGETS;
  if (known.length === targets.length && known.every((target, index) => target === targets[index])) return;
  if (targets.length) shownTargets.set(key, [...targets]);
  else shownTargets.delete(key);
  while (shownTargets.size > TURN_PREVIEWS_LIMIT) shownTargets.delete(shownTargets.keys().next().value as string);
  for (const listener of shownListeners) listener();
}

export function turnPreviewTargets(sessionId: string, checkpointId: string): readonly string[] {
  return shownTargets.get(previewKey(sessionId, checkpointId)) ?? NO_TARGETS;
}

export function subscribeTurnPreviews(listener: () => void): () => void {
  shownListeners.add(listener);
  return () => {
    shownListeners.delete(listener);
  };
}

/** Test seam: forget every mark and shown list. */
export function resetTurnPreviews(): void {
  liveTurns.clear();
  pendingOpens.clear();
  shownTargets.clear();
}
