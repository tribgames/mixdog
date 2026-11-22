import { t } from './i18n';
import { useSection } from './section-store';

/** The core's `catalogIndex` section: how far a rebuild of its session index has come, while one runs behind the serving core. */
interface CatalogIndexState {
  building?: unknown;
  done?: unknown;
  total?: unknown;
}

/** `{done, total}` while the core is still indexing its sessions; `null` once it is done or when it rebuilt nothing. */
export function useCatalogIndexBuilding(): { done: number; total: number } | null {
  const state = useSection<CatalogIndexState>('catalogIndex');
  if (state?.building !== true) return null;
  const total = Number(state.total);
  const done = Number(state.done);
  if (!Number.isFinite(total) || !Number.isFinite(done)) return null;
  return { done: Math.min(done, total), total };
}

/** The session list's header note: the list holds only the sessions indexed so far. */
export function CatalogIndexProgress() {
  const building = useCatalogIndexBuilding();
  if (!building) return null;
  const text = t('Indexing sessions… {{done}} of {{total}}', building);
  return (
    <span className="session-panel-indexing" role="status" title={text}>
      {text}
    </span>
  );
}

/** The search results' note: matches come only from the sessions indexed so far. */
export function CatalogIndexSearchNote() {
  const building = useCatalogIndexBuilding();
  if (!building) return null;
  return (
    <p className="session-search-indexing" role="status">
      {t('Results may be incomplete: sessions are still being indexed ({{done}} of {{total}}).', building)}
    </p>
  );
}
