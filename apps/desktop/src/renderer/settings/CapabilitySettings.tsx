import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type {
  DesktopCapability,
  DesktopModelOption,
  DesktopUpdaterState,
  SessionSnapshot,
} from '../../shared/contract';

import { PaneSurfaceGate } from '../PaneSurfaceGate';
import { preferredModelEffort } from '../model-route-utils';
import { routeAutoEffortCapable } from '../auto-effort-store';
import { showDesktopToast, useErrorToast } from '../notifications';
import { ErrorNotice } from '../ErrorNotice';
import { t } from '../i18n';
import { record } from '../record-utils';
import { invalidateSidebarReferenceForMutation } from '../sidebar-reference-cache';
import { invalidateSkillCatalogForMutation } from '../composer-skill-mentions';
import { announceSetupChange, subscribeSetupChanges } from '../setup-change-refresh';
import { SettingsConfirmDialog } from './capability-controls';
import {
  type CapabilitySettingsProps,
  type PanelContext,
  type SettingsConfirmation,
  EXTENSION_SECTIONS,
  applySectionRefresh,
  getCachedCapabilitySettings,
  refreshCapabilitySections,
  invalidateCapabilitySettings,
  preloadCapabilitySettings,
} from './capability-data';
import { CategoryPanel } from './capability-panels';
import { friendlyCapabilityError } from './remote-capability-guard';
import { errorMessage } from '../editor-pane-session-errors';
import { isSshConnectionWindow } from '../desktop-connection';
export { getCachedCapabilitySettings, preloadCapabilitySettings } from './capability-data';
export { OAuthControl } from './capability-panels';

// The updater is this PC's: a server window neither reads nor checks it.
const serverWindow = isSshConnectionWindow();

// Read-only provider probes that can run for most of a minute.
const UNQUEUED_PROBES: ReadonlySet<DesktopCapability> = new Set(['discoverCustomProviderModels', 'testCustomProvider']);

export const CapabilitySettings = memo(function CapabilitySettings({
  api,
  category,
  refreshNonce = 0,
  active = true,
  onCompose,
  onOpenCategory,
  createOpen = false,
  onCreateOpenChange,
  portalConfirm = false,
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
  useEffect(
    () =>
      subscribeSetupChanges(() => {
        invalidateCapabilitySettings(api);
        setRevision((value) => value + 1);
      }),
    [api]
  );
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
    if (serverWindow) return;
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

  const extensionCategory =
    category === 'plugins' ||
    category === 'skills' ||
    category === 'user-skills' ||
    category === 'mcp' ||
    category === 'connectors';
  const refreshExtensions = useCallback(async () => {
    const sections = await refreshCapabilitySections(api, EXTENSION_SECTIONS);
    if (Object.keys(sections).length) setData((previous) => applySectionRefresh(previous, sections));
  }, [api]);
  // Plugin folders change outside the app: re-read the extension sections the
  // moment the window is back instead of waiting for the next opening.
  useEffect(() => {
    if (!active || !extensionCategory) return;
    const onFocus = () => void refreshExtensions();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshExtensions();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, extensionCategory, refreshExtensions]);

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
      // A provider probe writes nothing: it neither waits for queued writes nor
      // holds them, so a discovery the user stopped waiting for (up to a
      // minute on a slow service) never blocks the Save that follows.
      const probe = UNQUEUED_PROBES.has(capability);
      const previous = probe ? undefined : mutationChain.current;
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
          // The composer's `$` palette, mention highlight and off-skill notice
          // read their own skill catalog; a skill change re-reads it.
          invalidateSkillCatalogForMutation(capability);
          // The next load must re-read past the write instead of adopting a
          // cached or still-running sweep that predates it.
          invalidateCapabilitySettings(api, capability);
          if (refresh) {
            // Extension lists update from a section read right away; the full
            // sweep below only reconciles the rest.
            if (extensionCategory) await refreshExtensions();
            setRevision((value) => value + 1);
          }
          return result.value;
        } catch (rawReason) {
          const reason = friendlyCapabilityError(rawReason);
          if (errorMode === 'throw') throw reason;
          if (!silent) setError(errorMessage(reason));
          return undefined;
        } finally {
          if (!silent) setPending('');
        }
      })();
      if (!probe) {
        mutationChain.current = task.then(
          () => undefined,
          () => undefined
        );
      }
      return task;
    },
    [api, extensionCategory, hydrating, refreshExtensions]
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
      setError(errorMessage(reason));
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
      setError(errorMessage(reason));
    } finally {
      setPending('');
    }
  }, [api, hydrating, pending, updaterState.status]);

  useEffect(() => {
    if (category !== 'system') {
      updateChecked.current = false;
      return;
    }
    if (serverWindow || hydrating || updateChecked.current) return;
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
        let autoEffort: boolean | undefined;
        if (routeAutoEffortCapable(model)) {
          if (isActiveRoute && typeof active.autoEffort === 'boolean') autoEffort = active.autoEffort;
          else autoEffort = model.savedAutoEffort ?? true;
        }
        await api.setModelRoute({
          provider: model.provider,
          model: model.model,
          ...(effort ? { effort } : {}),
          ...(fast === undefined ? {} : { fast }),
          ...(autoEffort === undefined ? {} : { autoEffort }),
        });
        announceSetupChange('set_route');
        invalidateCapabilitySettings(api);
        setRevision((value) => value + 1);
      } catch (reason) {
        setError(errorMessage(reason));
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
        invalidateCapabilitySettings(api);
        setRevision((value) => value + 1);
      } catch (reason) {
        setError(errorMessage(reason));
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
      refreshExtensions,
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
      active,
    }),
    [
      active,
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
      refreshExtensions,
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
        {confirmation && (
          <SettingsConfirmDialog options={confirmation} portal={portalConfirm} onClose={() => setConfirmation(null)} />
        )}
      </div>
    </PaneSurfaceGate>
  );
});
