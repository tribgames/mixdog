import { t } from './i18n';
import { useSection } from './section-store';

/** The core's `migration` section (native boot.rs `Settling`): while the earlier version's conversations convert behind the
 *  serving core, how many have settled of how many. */
interface MigrationState {
  converting?: unknown;
  done?: unknown;
  total?: unknown;
}

/** `{done, total}` while conversations still convert; `null` once none does. */
export function useMigrationConverting(): { done: number; total: number } | null {
  const state = useSection<MigrationState>('migration');
  if (state?.converting !== true) return null;
  const total = Number(state.total);
  const done = Number(state.done);
  if (!Number.isFinite(total) || !Number.isFinite(done) || total <= 0) return null;
  return { done: Math.min(done, total), total };
}

/** The session list's header note while the list is still filling: conversations of the earlier version still convert. */
export function MigrationProgress() {
  const converting = useMigrationConverting();
  if (!converting) return null;
  const text = t('Converting earlier conversations… {{done}} of {{total}}', converting);
  return (
    <span className="session-panel-indexing" role="status" title={text}>
      {text}
    </span>
  );
}
