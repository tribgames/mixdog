import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type {
  DesktopCapability,
  DesktopModelOption,
  DesktopUpdaterState,
  SessionSnapshot,
} from '../../shared/contract';

import { PaneSurfaceGate } from '../PaneSurfaceGate';
import { preferredModelEffort } from '../model-route-utils';
import { showDesktopToast, useErrorToast } from '../notifications';
import { ErrorNotice } from '../ErrorNotice';
import { t } from '../i18n';
import { record } from '../record-utils';
import { invalidateSidebarReferenceForMutation } from '../sidebar-reference-cache';
import { subscribeSetupChanges } from '../setup-change-refresh';
import { SettingsConfirmDialog } from './capability-controls';
import {
  type CapabilitySettingsProps,
  type PanelContext,
  type SettingsConfirmation,
  getCachedCapabilitySettings,
  preloadCapabilitySettings,
} from './capability-data';
import { CategoryPanel } from './capability-panels';
import { friendlyCapabilityError } from './remote-capability-guard';
export { getCachedCapabilitySettings, preloadCapabilitySettings } from './capability-data';
export { OAuthControl } from './capability-panels';

export const CapabilitySettings = memo(function CapabilitySettings({
  api,
  category,
  refreshNonce = 0,
  active = true,
  onCompose,
  onOpenCategory,
  createOpen = false,
  onCreateOpenChange,
}: CapabilitySettingsProps) {
  const initialCache = getCachedCapabilitySettings(api);
  const [data, setData] = useState<Record<string, unknown>>(() => initialCache?.data || {});
  const [hydrating, setHydrating] = useState(() => !initialCache);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState(() => initialCache?.error || '');
  const [confirmation, setConfirmation] = useState<SettingsConfirmation | null>(null);
  const [liveSnapshot, setLiveSnapshot] = useState<SessionSnapshot>(null);
  const [updaterState, setUpdaterState] = useState<DesktopUpdaterState>({ status: 'disabled' });
  const activeRef = useRef(active);
  activeRef.current = active;
  const latestSnapshot = useRef(liveSnapshot);
  const latestUpdaterState = useRef(updaterState);
  useLayoutEffect(() => {
    if (!active) return;
    setLiveSnapshot(latestSnapshot.current);
    setUpdaterState(latestUpdaterState.current);
  }, [active]);
  const [revision, setRevision] = useState(0);
  const loadSequence = useRef(0);
  const updateChecked = useRef(false);
  // Tail of the in-flight mutation chain: capability calls run one after the
  // other so a burst of clicks lands in order instead of being dropped.
  const mutationChain = useRef<Promise<void>>(Promise.resolve());
  useErrorToast(error, 'settings');

  const load = useCallback(
    async (force = false) => {
      const sequence = ++loadSequence.current;
      const startedAt = performance.now();
      const cached = getCachedCapabilitySettings(api);
      if (cached) {
        setData(cached.data);
        setLoadError(cached.error);
        setHydrating(false);
      } else {
        setLoadError('');
        setHydrating(true);
      }
      // Cold settings stay behind one spinner until the complete snapshot lands.
      // A warm refresh keeps the cached panel intact and adopts the final sweep
      // in one React commit instead of inserting rows batch by batch.
      const next = await preloadCapabilitySettings(api, force);
      if (sequence !== loadSequence.current) return;
      setData(next.data);
      setLoadError(next.error);
      setHydrating(false);
      // Perf diagnostics (dropped unless MIXDOG_DESKTOP_PERF=1): how long the
      // panel showed skeleton/stale values before real data landed.
      if (!cached) {
        window.mixdogDesktop?.perfLog?.(`settings-hydrate ms=${(performance.now() - startedAt).toFixed(0)}`);
      }
    },
    [api]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: api, refreshNonce and revision are re-read triggers; load itself only reads api.
  useEffect(() => {
    // A hidden panel adopts the shared cache without another sweep. Every
    // opening refreshes it: a two-second cache grace period could otherwise
    // keep a change made while hidden invisible until a later visit.
    void load(active);
    return () => {
      loadSequence.current += 1;
    };
  }, [active, api, load, refreshNonce, revision]);
  // A setup-tool change rewrites settings outside this panel: re-read now
  // while visible; a hidden panel refreshes on its next opening.
  useEffect(() => subscribeSetupChanges(() => setRevision((value) => value + 1)), []);
  useEffect(() => {
    let live = true;
    const receive = (snapshot: SessionSnapshot) => {
      if (!live) return;
      latestSnapshot.current = snapshot;
      if (activeRef.current) setLiveSnapshot(snapshot);
    };
    void api
      .getSnapshot?.()
      .then(receive)
      .catch(() => {});
    // Keep receiving while hidden, but publish to React only while visible.
    // The layout effect above adopts the latest value before reopening paints.
    const unsubscribe = api.subscribeState?.(receive);
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [api]);
  useEffect(() => {
    let live = true;
    const receive = (next: DesktopUpdaterState) => {
      if (!live) return;
      latestUpdaterState.current = next;
      if (activeRef.current) setUpdaterState(next);
    };
    void api
      .getUpdaterState?.()
      .then(receive)
      .catch(() => {});
    const unsubscribe = api.subscribeUpdaterState?.(receive);
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [api]);

  const run = useCallback(
    async <T,>(
      capability: DesktopCapability,
      args: unknown[] = [],
      key: string = capability,
      refresh = true,
      silent = false,
      errorMode: 'toast' | 'throw' = 'toast'
    ): Promise<T | undefined> => {
      if (!api.invokeCapability || hydrating) return undefined;
      // Serialize instead of dropping: a fast second click used to be swallowed
      // while the first mutation was still in flight, so the toggle silently
      // ignored the press (the control stays enabled, so the user sees nothing).
      const previous = mutationChain.current;
      const task = (async (): Promise<T | undefined> => {
        try {
          await previous;
        } catch {
          /* the prior call reported its own error */
        }
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
        } catch (rawReason) {
          const reason = friendlyCapabilityError(rawReason);
          if (errorMode === 'throw') throw reason;
          if (!silent) setError(reason instanceof Error ? reason.message : String(reason));
          return undefined;
        } finally {
          if (!silent) setPending('');
        }
      })();
      mutationChain.current = task.then(
        () => undefined,
        () => undefined
      );
      return task;
    },
    [api, hydrating]
  );

  const checkDesktopUpdate = useCallback(async (): Promise<void> => {
    if (!api.checkForDesktopUpdate || pending || hydrating) return;
    setPending('desktop-update');
    setError('');
    try {
      const next = await api.checkForDesktopUpdate();
      latestUpdaterState.current = next;
      if (activeRef.current) setUpdaterState(next);
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
      const next = await api.showDesktopUpdate();
      latestUpdaterState.current = next;
      if (activeRef.current) setUpdaterState(next);
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

  const route = useCallback(
    async (model: DesktopModelOption) => {
      if (!api.setModelRoute || pending || hydrating) return;
      setPending('model-route');
      setError('');
      try {
        const active = record(liveSnapshot);
        const isActiveRoute = active.provider === model.provider && active.model === model.model;
        const activeEffort = String(active.effort || '');
        const effort =
          isActiveRoute && model.effortOptions.some((entry) => entry.value === activeEffort)
            ? activeEffort
            : preferredModelEffort(model);
        let fast: boolean | undefined;
        if (model.fastCapable) {
          if (isActiveRoute && typeof active.fast === 'boolean') fast = active.fast;
          else if (typeof model.savedFast === 'boolean') fast = model.savedFast;
          else fast = model.fastPreferred;
        }
        await api.setModelRoute({
          provider: model.provider,
          model: model.model,
          ...(effort ? { effort } : {}),
          ...(fast === undefined ? {} : { fast }),
        });
        setRevision((value) => value + 1);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setPending('');
      }
    },
    [api, hydrating, liveSnapshot, pending]
  );

  const setFast = useCallback(
    async (enabled: boolean) => {
      if (!api.setFast || pending || hydrating) return;
      setPending('fast');
      setError('');
      try {
        await api.setFast(enabled);
        setRevision((value) => value + 1);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setPending('');
      }
    },
    [api, hydrating, pending]
  );

  const confirm = useCallback((options: SettingsConfirmation) => setConfirmation(options), []);
  const pushNotice = useCallback((message: string, tone: 'info' | 'warn' = 'info') => {
    showDesktopToast(message, tone);
  }, []);

  const effectivePending = hydrating ? 'settings-hydrating' : pending;
  const closeCreate = useCallback(() => onCreateOpenChange?.(false), [onCreateOpenChange]);
  const context = useMemo<PanelContext>(
    () => ({
      api,
      data,
      snapshot: liveSnapshot,
      pending: effectivePending,
      run,
      route,
      setFast,
      confirm,
      notice: pushNotice,
      updaterState,
      checkDesktopUpdate,
      installDesktopUpdate,
      compose: onCompose,
      openCategory: onOpenCategory,
      createOpen,
      closeCreate,
    }),
    [
      api,
      checkDesktopUpdate,
      closeCreate,
      confirm,
      createOpen,
      data,
      effectivePending,
      installDesktopUpdate,
      liveSnapshot,
      onCompose,
      onOpenCategory,
      pushNotice,
      route,
      run,
      setFast,
      updaterState,
    ]
  );

  return (
    <PaneSurfaceGate ready label={t('Loading settings…')}>
      <div className="capability-settings-content">
        {loadError && <ErrorNotice error={loadError} role="status" onRetry={() => void load(true)} />}
        <CategoryPanel category={category} context={context} />
        {confirmation && <SettingsConfirmDialog options={confirmation} onClose={() => setConfirmation(null)} />}
      </div>
    </PaneSurfaceGate>
  );
});
