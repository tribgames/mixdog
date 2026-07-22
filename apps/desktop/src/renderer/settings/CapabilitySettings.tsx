import React, { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Trash2,
  X,
} from 'lucide-react';

import type {
  DesktopApi,
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopReadCapability,
  DesktopModelOption,
  DesktopModelSelection,
  DesktopRemoteAccessInfo,
  EngineSnapshot,
} from '../../shared/contract';
import type { SettingsCategory } from './settings-items';
import {
  desktopThemePreferenceForTheme,
  getDesktopThemePreference,
  setDesktopThemePreference,
  type DesktopThemePreference,
} from '../desktop-theme';
import { OpenSelect } from '../OpenSelect';
import { filterConfiguredModels, ModelPicker } from '../ModelPicker';
import { modelDisplayName, modelOptionLabel, normalizeModelOptions, providerDisplayName } from '../provider-display';

import { type RecordValue, type CapabilityApi, type CapabilitySettingsProps, type PanelContext, type SettingsConfirmation, type CachedCapabilitySettings, SECTION_READS, getCachedCapabilitySettings, preloadCapabilitySettings, record, rows, bool, label, providerLabel, count, formatDuration, durationTextInput } from "./capability-data";
import { SettingsConfirmDialog, preferredEffort } from "./capability-controls";
import { CategoryPanel } from "./capability-panels";
export { getCachedCapabilitySettings, preloadCapabilitySettings, type CachedCapabilitySettings } from "./capability-data";
export { OAuthControl } from "./capability-panels";

export function CapabilitySettings({ api, category, onCompose, onOpenCategory }: CapabilitySettingsProps) {
  const initialCache = getCachedCapabilitySettings(api);
  const [data, setData] = useState<Record<string, unknown>>(() => initialCache?.data || {});
  const [hydrating, setHydrating] = useState(() => !initialCache);
  const [pending, setPending] = useState('');
  const [error, setError] = useState(() => initialCache?.error || '');
  const [notice, setNotice] = useState<{ message: string; tone: 'info' | 'warn' } | null>(null);
  const [confirmation, setConfirmation] = useState<SettingsConfirmation | null>(null);
  const [liveSnapshot, setLiveSnapshot] = useState<EngineSnapshot>(null);
  const [revision, setRevision] = useState(0);
  const loadSequence = useRef(0);
  const updateChecked = useRef(false);

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
    const stale = Boolean(cached && Date.now() - cached.loadedAt >= 15_000);
    void load(revision > 0 || stale);
    return () => { loadSequence.current += 1; };
  }, [api, load, revision]);
  useEffect(() => {
    let live = true;
    void api.getSnapshot?.().then((snapshot) => { if (live) setLiveSnapshot(snapshot); }).catch(() => {});
    const unsubscribe = api.subscribeState?.((snapshot) => { if (live) setLiveSnapshot(snapshot); });
    return () => { live = false; unsubscribe?.(); };
  }, [api]);

  const run = useCallback(async <T,>(
    capability: DesktopCapability,
    args: unknown[] = [],
    key: string = capability,
    refresh = true,
  ): Promise<T | undefined> => {
    if (!api.invokeCapability || pending || hydrating) return undefined;
    setPending(key);
    setError('');
    try {
      const result = await api.invokeCapability<T>({ capability, args });
      if (refresh) setRevision((value) => value + 1);
      return result.value;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally {
      setPending('');
    }
  }, [api, hydrating, pending]);

  useEffect(() => {
    if (category !== 'system') {
      updateChecked.current = false;
      return;
    }
    if (hydrating || updateChecked.current) return;
    updateChecked.current = true;
    void run('checkForUpdate', [{}]);
  }, [category, hydrating, run]);

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
        : preferredEffort(model);
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
    setNotice({ message, tone });
  }, []);

  const effectivePending = hydrating ? 'settings-hydrating' : pending;
  const context = useMemo<PanelContext>(() => ({
    data, snapshot: liveSnapshot, pending: effectivePending, run, route, setFast, confirm, notice: pushNotice,
    compose: onCompose, openCategory: onOpenCategory,
  }), [confirm, data, effectivePending, liveSnapshot, onCompose, onOpenCategory, pushNotice, route, run, setFast]);

  return <>
    <CategoryPanel category={category} context={context} />
    {error && <p className="mixdog-settings__error" role="alert">{error}</p>}
    {notice && <p className={`settings-notice settings-notice--${notice.tone}`}
      role={notice.tone === 'warn' ? 'alert' : 'status'}>{notice.message}</p>}
    {confirmation && <SettingsConfirmDialog options={confirmation} onClose={() => setConfirmation(null)} />}
  </>;
}
