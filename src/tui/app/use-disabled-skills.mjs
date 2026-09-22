/**
 * use-disabled-skills.mjs — which Skills the user has turned off.
 *
 * The set is read once on mount and written back through the store on every
 * change, so the Skills picker edits one authority instead of a local copy.
 *
 * Hook order note: state → load effect → setter callback, declared in the same
 * order App.jsx declared them, so this hook drops into the same position in
 * App.jsx's hook list.
 */
import { useCallback, useEffect, useState } from 'react';

export function useDisabledSkills({ store }) {
  // getDisabledSkills is a remote call on a daemon-backed store, so it cannot
  // seed useState synchronously (the initializer used to capture a promise and
  // every skill looked enabled). Start empty and adopt the real set on mount.
  const [disabledSkills, setDisabledSkillsInner] = useState(() => new Set());
  useEffect(() => {
    let alive = true;
    void Promise.resolve(store.getDisabledSkills?.())
      .then((result) => {
        if (!alive) return;
        const disabled = Array.isArray(result?.disabled) ? result.disabled : [];
        if (disabled.length) setDisabledSkillsInner(new Set(disabled));
      })
      .catch(() => {
        /* skills stay enabled when the probe fails */
      });
    return () => {
      alive = false;
    };
  }, [store]);
  const setDisabledSkills = useCallback(
    (next) => {
      setDisabledSkillsInner((current) => {
        const base = current instanceof Set ? current : new Set(current);
        let set;
        if (typeof next === 'function') set = next(base);
        else if (next instanceof Set) set = next;
        else set = new Set(next);
        try {
          store.setDisabledSkills?.([...set]);
        } catch (e) {
          store.pushNotice(`skill disable persist failed: ${e?.message || e}`, 'error');
        }
        return set;
      });
    },
    [store]
  );
  return { disabledSkills, setDisabledSkills };
}
