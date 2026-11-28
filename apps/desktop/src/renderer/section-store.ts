// React's reading of the window's section store. The store itself is section-store-model.ts, which the phone imports without React.
import { useCallback, useSyncExternalStore } from 'react';
import type { DesktopSectionEntry } from '../shared/contract-sections';
import { EMPTY_SECTION, type SectionStore, windowSectionStore } from './section-store-model';

export {
  createSectionStore,
  installSectionStore,
  installedSectionStore,
  sectionStoreFor,
  sectionsSourceFromFoldStore,
  windowSectionStore,
  type FoldStoreLike,
  type SectionStore,
  type SectionsSource,
} from './section-store-model';

const NO_STORE: SectionStore = {
  get: () => undefined,
  list: () => EMPTY_SECTION,
  status: () => 'reconnecting',
  subscribe: () => () => undefined,
  onFeedError: () => () => undefined,
  ready: () => Promise.resolve(),
  dispose: () => undefined,
};

/** The value of one `(section, key)`, re-rendering on every change of the section. `undefined` until it is pushed. */
export function useSection<T>(section: string, key: string | null = null): T | undefined {
  const store = windowSectionStore() ?? NO_STORE;
  const subscribe = useCallback((listener: () => void) => store.subscribe(section, listener), [store, section]);
  return useSyncExternalStore(subscribe, () => store.get(section, key)?.value as T | undefined);
}

/** Every entry of a keyed section. */
export function useSectionEntries(section: string): readonly DesktopSectionEntry[] {
  const store = windowSectionStore() ?? NO_STORE;
  const subscribe = useCallback((listener: () => void) => store.subscribe(section, listener), [store, section]);
  return useSyncExternalStore(subscribe, () => store.list(section));
}
