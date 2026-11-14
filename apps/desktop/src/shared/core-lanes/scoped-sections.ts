// Sections carried by scoped feeds (`media:<jobId>`, desktop-services.md §2.1, SPEC R14): the core keeps these out of the app
// snapshot and delivers them on the feed of the request that needs them. This turns a scoped feed's section notifications
// and snapshots into the `(section, key)` changes a window's mirror folds, so the window reads them like app sections.
import type { DesktopSectionChange, DesktopSectionEntry, DesktopSectionsPush } from '../contract-sections';
import { SECTION_NAMES } from '../contract-sections';

export interface ScopedFeedRoute {
  /** The windows watching the feed. */
  readonly windows: Set<{ push(push: DesktopSectionsPush): void }>;
  /** The sections the feed delivered and still holds, by `section\0key`: what a window that starts watching is given. */
  readonly held: Map<string, DesktopSectionEntry>;
}

interface SectionUpdateParams {
  readonly section: string;
  readonly key: string | null;
  readonly revision: number;
  readonly value?: unknown;
  readonly removed?: true;
}

const isSectionUpdate = (params: unknown): params is SectionUpdateParams => {
  const p = params as Partial<SectionUpdateParams> | null;
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.section === 'string' &&
    (SECTION_NAMES as readonly string[]).includes(p.section) &&
    typeof p.revision === 'number' &&
    (p.key === null || typeof p.key === 'string')
  );
};

const slot = (section: string, key: string | null): string => `${section}\0${key ?? ''}`;

function apply(route: ScopedFeedRoute, update: SectionUpdateParams): DesktopSectionChange[] {
  const { section, key, revision } = update;
  if (update.removed === true) {
    route.held.delete(slot(section, key));
    return [{ section, key, entry: null }];
  }
  // A stub (a value too large to push) is paged by the section's own list method; a job snapshot is always inline.
  if (!('value' in update)) return [];
  const entry = { section, key, revision, value: update.value };
  route.held.set(slot(section, key), entry);
  return [{ section, key, entry }];
}

/** The changes a scoped feed's notification makes: a section update is one change; `feed/snapshot` is the feed's whole
 *  state, so what the feed held before and the snapshot lacks is removed. Other notifications change nothing. */
export function scopedSectionChanges(route: ScopedFeedRoute, method: string, params: unknown): DesktopSectionChange[] {
  if (method === 'feed/snapshot') {
    const sections = (params as { state?: { sections?: unknown } } | null)?.state?.sections;
    if (!Array.isArray(sections)) return [];
    const before = new Map(route.held);
    route.held.clear();
    const changes = sections.filter(isSectionUpdate).flatMap((update) => apply(route, update));
    for (const [id, gone] of before) {
      if (!route.held.has(id)) changes.push({ section: gone.section, key: gone.key, entry: null });
    }
    return changes;
  }
  return isSectionUpdate(params) ? apply(route, params) : [];
}
