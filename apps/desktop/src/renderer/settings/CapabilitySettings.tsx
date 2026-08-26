import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  DesktopCapability,
  DesktopModelOption,
  DesktopUpdaterState,
  SessionSnapshot
} from '../../shared/contract';

import { PaneSurfaceGate } from '../PaneSurfaceGate';
import { preferredModelEffort } from '../model-route-utils';
import { showDesktopToast } from '../notifications';
import { record } from '../record-utils';
import { invalidateSidebarReferenceForMutation } from '../sidebar-reference-cache';
import { SettingsConfirmDialog } from "./capability-controls";
import { type CapabilitySettingsProps, type PanelContext, type SettingsConfirmation, getCachedCapabilitySettings, preloadCapabilitySettings } from "./capability-data";
import { CategoryPanel } from "./capability-panels";
export { getCachedCapabilitySettings, preloadCapabilitySettings, type CachedCapabilitySettings } from "./capability-data";
export { OAuthControl } from "./capability-panels";

export function CapabilitySettings({ api, category, onCompose, onOpenCategory }: CapabilitySettingsProps) {
  const initialCache = getCachedCapabilitySettings(api);
  const [data, setData] = useState<Record<string, unknown>>(() => initialCache?.data || {});
  const [hydrating, setHydrating] = useState(() => !initialCache);
  const [pending, setPending] = useState('');
  const [error, setError] = useState(() => initialCache?.error || '');
  const [confirmation, setConfirmation] = useState<SettingsConfirmation | null>(null);
  const [liveSnapshot, setLiveSnapshot] = useState<SessionSnapshot>(null);
  const [updaterState, setUpdaterState] = useState<DesktopUpdaterState>({ status: 'disabled' });
  const [revision, setRevision] = useState(0);
  const loadSequence = useRef(0);
  const updateChecked = useRef(false);
  // Tail of the in-flight mutation chain: capability calls run one after the
  // other so a burst of clicks lands in order instead of being dropped.
  const mutationChain = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (error) showDesktopToast(error, 'error');
  }, [error]);

  const load = useCallback(async (force = false) => {
    const sequence = ++loadSequence.current;
    const startedAt = performance.now();
    const cached = getCachedCapabilitySettings(api);
    if (cached) {
      setData(cached.data);
      setError(cached.error);
      setHydrating(false);
    } else {
      setError('');
      setHydrating(true);
    }
    // Cold settings stay behind one spinner until the complete snapshot lands.
    // A warm refresh keeps the cached panel intact and adopts the final sweep
    // in one React commit instead of inserting rows batch by batch.
    const next = await preloadCapabilitySettings(api, force);
    if (sequence !== loadSequence.current) return;
    setData(next.data);
    setError(next.error);
    setHydrating(false);
    // Perf diagnostics (dropped unless MIXDOG_DESKTOP_PERF=1): how long the
    // panel showed skeleton/stale values before real data landed.
    if (!cached) {
      window.mixdogDesktop?.perfLog?.(`settings-hydrate ms=${(performance.now() - startedAt).toFixed(0)}`);
    }
  }, [api]);

  useEffect(() => {
    const cached = getCachedCapabilitySettings(api);
    // Reads now cost ~30ms in one sweep, so every open re-reads unless it just
    // happened: a settings panel showing a minute-old snapshot (or a value that
    // was still warming up when it was cached) is the worse trade.
    const stale = Boolean(cached && Date.now() - cached.loadedAt >= 2_000);
    void load(revision > 0 || stale);
    return () => { loadSequence.current += 1; };
  }, [api, load, revision]);
  useEffect(() => {
    let live = true;
    void api.getSnapshot?.().then((snapshot) => { if (live) setLiveSnapshot(snapshot); }).catch(() => {});
    const unsubscribe = api.subscribeState?.((snapshot) => { if (live) setLiveSnapshot(snapshot); });
    return () => { live = false; unsubscribe?.(); };
  }, [api]);
  useEffect(() => {
    let live = true;
    void api.getUpdaterState?.().then((next) => {
      if (live) setUpdaterState(next);
    }).catch(() => {});
    const unsubscribe = api.subscribeUpdaterState?.((next) => {
      if (live) setUpdaterState(next);
    });
    return () => { live = false; unsubscribe?.(); };
  }, [api]);

  const run = useCallback(async <T,>(
    capability: DesktopCapability,
    args: unknown[] = [],
    key: string = capability,
    refresh = true,
    silent = false,
  ): Promise<T | undefined> => {
    if (!api.invokeCapability || hydrating) return undefined;
    // Serialize instead of dropping: a fast second click used to be swallowed
    // while the first mutation was still in flight, so the toggle silently
    // ignored the press (the control stays enabled, so the user sees nothing).
    const previous = mutationChain.current;
    const task = (async (): Promise<T | undefined> => {
      try { await previous; } catch { /* the prior call reported its own error */ }
      if (!silent) {
        setPending(key);
        setError('');
      }
      try {
        const result = await api.invokeCapability!<T>({ capability, args });
        // Authoritative completion boundary for every settings mutation: only
        // a resolved call invalidates the sidebar reference keys it makes
        // untrue (provider setup/model catalogs, search route, agents).
        invalidateSidebarReferenceForMutation(capability);
        if (refresh) setRevision((value) => value + 1);
        return result.value;
      } catch (reason) {
        if (!silent) setError(reason instanceof Error ? reason.message : String(reason));
        return undefined;
      } finally {
        if (!silent) setPending('');
      }
    })();
    mutationChain.current = task.then(() => undefined, () => undefined);
    return task;
  }, [api, hydrating]);

  const checkDesktopUpdate = useCallback(async (): Promise<void> => {
    if (!api.checkForDesktopUpdate || pending || hydrating) return;
    setPending('desktop-update');
    setError('');
    try {
      setUpdaterState(await api.checkForDesktopUpdate());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending('');
    }
  }, [api, hydrating, pending]);

  const installDesktopUpdate = useCallback(async (): Promise<void> => {
    if (!api.showDesktopUpdate || updaterState.status !== 'ready' || pending || hydrating) return;
    setPending('desktop-update');
    setError('');
    try {
      setUpdaterState(await api.showDesktopUpdate());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending('');
    }
  }, [api, hydrating, pending, updaterState.status]);

  useEffect(() => {
    if (category !== 'system') {
      updateChecked.current = false;
      return;
    }
    if (hydrating || updateChecked.current) return;
    updateChecked.current = true;
    if (api.checkForDesktopUpdate) void checkDesktopUpdate();
    else void run('checkForUpdate', [{}]);
  }, [api.checkForDesktopUpdate, category, checkDesktopUpdate, hydrating, run]);

  const route = useCallback(async (model: DesktopModelOption) => {
    if (!api.setModelRoute || pending || hydrating) return;
    setPending('model-route');
    setError('');
    try {
      const active = record(liveSnapshot);
      const isActiveRoute = active.provider === model.provider && active.model === model.model;
      const activeEffort = String(active.effort || '');
      const effort = isActiveRoute && model.effortOptions.some((entry) => entry.value === activeEffort)
        ? activeEffort
        : preferredModelEffort(model);
      const fast = model.fastCapable
        ? (isActiveRoute && typeof active.fast === 'boolean'
          ? active.fast === true
          : (typeof model.savedFast === 'boolean' ? model.savedFast : model.fastPreferred))
        : undefined;
      await api.setModelRoute({
        provider: model.provider,
        model: model.model,
        ...(effort ? { effort } : {}),
        ...(fast === undefined ? {} : { fast }),
      });
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setPending(''); }
  }, [api, hydrating, liveSnapshot, pending]);

  const setFast = useCallback(async (enabled: boolean) => {
    if (!api.setFast || pending || hydrating) return;
    setPending('fast');
    setError('');
    try {
      await api.setFast(enabled);
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setPending(''); }
  }, [api, hydrating, pending]);

  const confirm = useCallback((options: SettingsConfirmation) => setConfirmation(options), []);
  const pushNotice = useCallback((message: string, tone: 'info' | 'warn' = 'info') => {
    showDesktopToast(message, tone);
  }, []);

  const effectivePending = hydrating ? 'settings-hydrating' : pending;
  const context = useMemo<PanelContext>(() => ({
    api, data, snapshot: liveSnapshot, pending: effectivePending, run, route, setFast, confirm, notice: pushNotice,
    updaterState, checkDesktopUpdate, installDesktopUpdate,
    compose: onCompose, openCategory: onOpenCategory,
  }), [api, checkDesktopUpdate, confirm, data, effectivePending, installDesktopUpdate, liveSnapshot, onCompose,
    onOpenCategory, pushNotice, route, run, setFast, updaterState]);

  return <PaneSurfaceGate ready label="Loading settings…">
    <div className="capability-settings-content">
    <CategoryPanel category={category} context={context} />
    {confirmation && <SettingsConfirmDialog options={confirmation} onClose={() => setConfirmation(null)} />}
    </div>
  </PaneSurfaceGate>;
}
