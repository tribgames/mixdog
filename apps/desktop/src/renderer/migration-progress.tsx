import { useState } from 'react';
import { t } from './i18n';
import { useSection } from './section-store';

/** The core's `migration` section (native boot.rs `Settling`, `publish_migration_settled`): while the earlier version's
 *  conversations convert behind the serving core, how many have settled of how many; once the migration has completed, what it
 *  set aside (`{id, count, dir}`). */
interface MigrationState {
  converting?: unknown;
  done?: unknown;
  total?: unknown;
  setAside?: { id?: unknown; count?: unknown; dir?: unknown; moved?: unknown; inPlace?: unknown } | null;
}

/** The completed migration whose set-aside items the person was told of (its identity), kept by this browser profile. */
export const SET_ASIDE_TOLD_KEY = 'mixdog:migration-set-aside-told';

/** `{done, total}` while conversations still convert; `null` once none does. */
export function useMigrationConverting(): { done: number; total: number } | null {
  const state = useSection<MigrationState>('migration');
  if (state?.converting !== true) return null;
  const total = Number(state.total);
  const done = Number(state.done);
  if (!Number.isFinite(total) || !Number.isFinite(done) || total <= 0) return null;
  return { done: Math.min(done, total), total };
}

/** What the completed migration set aside, until the person has been told once. */
function useSetAside(): { id: string; count: number; dir: string; moved: number; inPlace: string[] } | null {
  const state = useSection<MigrationState>('migration');
  const aside = state?.converting === true ? null : state?.setAside;
  const id = typeof aside?.id === 'string' ? aside.id : '';
  const count = Number(aside?.count);
  const dir = typeof aside?.dir === 'string' ? aside.dir : '';
  if (!id || !dir || !Number.isFinite(count) || count <= 0) return null;
  const inPlace = Array.isArray(aside?.inPlace) ? aside.inPlace.filter((f): f is string => typeof f === 'string' && f.length > 0) : [];
  const rawMoved = Number(aside?.moved);
  const moved = Number.isFinite(rawMoved) && rawMoved >= 0 ? rawMoved : inPlace.length > 0 ? Math.max(0, count - inPlace.length) : count;
  return { id, count, dir, moved, inPlace };
}

function told(id: string): boolean {
  try {
    return window.localStorage.getItem(SET_ASIDE_TOLD_KEY) === id;
  } catch {
    return false;
  }
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

/** Told once, after the migration: how many items it could not carry over and set aside, and where they are kept. */
export function MigrationSetAsideNotice() {
  const aside = useSetAside();
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!aside || dismissed === aside.id || told(aside.id)) return null;
  const dismiss = (): void => {
    try {
      window.localStorage.setItem(SET_ASIDE_TOLD_KEY, aside.id);
    } catch {
      /* told for this window only */
    }
    setDismissed(aside.id);
  };
  const message =
    aside.inPlace.length === 0
      ? t('Updating from the earlier version set aside {{items}} items it could not convert. They are kept in {{dir}}.', {
          items: aside.count,
          dir: aside.dir,
        })
      : aside.moved === 0
        ? t('Updating from the earlier version found damaged files and left them in place: {{files}}. Details are in {{dir}}.', {
            files: aside.inPlace.join(', '),
            dir: aside.dir,
          })
        : t('Updating from the earlier version set aside {{items}} items in {{dir}} and left damaged files in place: {{files}}.', {
            items: aside.moved,
            dir: aside.dir,
            files: aside.inPlace.join(', '),
          });
  return (
    <div className="session-migration-notice" role="status">
      <p>{message}</p>
      <button type="button" onClick={dismiss}>
        {t('OK')}
      </button>
    </div>
  );
}
