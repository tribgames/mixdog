// The onboarding wizard's (OnboardingWizard.tsx) capability runner, its
// provider/profile reads, and its modal keyboard and focus handling.
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type {
  DesktopApi,
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
} from '../../shared/contract';
import { waitForDesktopProviders } from '../desktop-provider-retry';
import { errorMessage } from '../editor-pane-session-errors';
import { record } from '../record-utils';
import { invalidateSidebarReferenceForMutation } from '../sidebar-reference-cache';
import { FOCUSABLE_SELECTOR, openModal, portaledMenuOpen, trapTab } from './dialog-modality';
import { friendlyCapabilityError } from './remote-capability-guard';

type RecordValue = Record<string, unknown>;

async function readCapabilityBatch(
  api: DesktopApi,
  requests: DesktopCapabilityReadRequest[]
): Promise<DesktopCapabilityReadResult[]> {
  if (typeof api.readCapabilities === 'function') return api.readCapabilities(requests);
  return Promise.all(
    requests.map(async (request) => {
      try {
        const result = await api.invokeCapability({ capability: request.capability, args: request.args });
        return { ok: true as const, value: result.value };
      } catch (reason) {
        return { ok: false as const, error: errorMessage(reason) };
      }
    })
  );
}

/** The wizard's capability runner: a mutation runs after the ones before it,
 *  marks the wizard pending (by key) and reports its failure; a silent call
 *  (a status read) runs at once and reports nothing. */
export function useOnboardingRun(api: DesktopApi) {
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const capabilityPendingRef = useRef(false);
  const mutationChain = useRef<Promise<unknown>>(Promise.resolve());
  const mutationCount = useRef(0);
  const run = useCallback(
    async <T>(
      capability: DesktopCapability,
      args: unknown[] = [],
      key: string = capability,
      _refresh = false,
      silent = false
    ): Promise<T | undefined> => {
      if (!silent) {
        mutationCount.current += 1;
        capabilityPendingRef.current = true;
        setPending(key);
        setError('');
      }
      const execute = async (): Promise<T | undefined> => {
        try {
          const result = (await api.invokeCapability<T>({ capability, args })).value;
          // Invalidate only after the authoritative mutation has resolved.
          invalidateSidebarReferenceForMutation(capability);
          return result;
        } catch (rawReason) {
          const reason = friendlyCapabilityError(rawReason);
          if (!silent) setError(errorMessage(reason));
          return undefined;
        } finally {
          if (!silent && --mutationCount.current === 0) {
            capabilityPendingRef.current = false;
            setPending('');
          }
        }
      };
      // OAuth status reads must not wait behind an interactive login mutation.
      if (silent) return execute();
      const task = mutationChain.current.then(execute);
      mutationChain.current = task;
      return task;
    },
    [api]
  );
  return { run, pending, error, setError, capabilityPendingRef };
}

/** The provider setup and profile the steps edit, read on mount (and again on
 *  `load(true)`); a client-managed setup follows desktop sign-ins on the
 *  shared desktop-provider cadence, plus focus and reconnect. */
export function useOnboardingSetup(api: DesktopApi, setError: (error: string) => void) {
  const [loading, setLoading] = useState(true);
  const [providerSetup, setProviderSetup] = useState<RecordValue>({});
  const [profile, setProfile] = useState<RecordValue>({});
  const loadedRef = useRef(false);
  const load = useCallback(
    async (force = false) => {
      if (!loadedRef.current) setLoading(true);
      setError('');
      try {
        const readResults = await readCapabilityBatch(api, [
          { capability: 'getProviderSetup', args: [{ force }] },
          { capability: 'getProfile' },
        ]);
        const values = readResults.map((result) => (result.ok ? result.value : null));
        const readErrors = readResults.flatMap((result) => (result.ok ? [] : [result.error]));
        if (readErrors.length) setError(readErrors.join(' · '));
        setProviderSetup(record(values[0]));
        setProfile(record(values[1]));
      } catch (reason) {
        setError(errorMessage(reason));
      } finally {
        loadedRef.current = true;
        setLoading(false);
      }
    },
    [api, setError]
  );

  useEffect(() => {
    if (!loadedRef.current) void load();
  }, [load]);

  useEffect(() => {
    if (providerSetup.managedByClient !== true) return;
    let cancelled = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const [result] = await readCapabilityBatch(api, [{ capability: 'getProviderSetup', args: [{ force: true }] }]);
        if (!cancelled && result?.ok) setProviderSetup(record(result.value));
      } finally {
        pending = false;
      }
    };
    const onRefresh = () => void refresh().catch(() => undefined);
    // Desktop sign-ins have no event on a server window: follow them on the
    // shared desktop-provider cadence, plus focus and reconnect.
    const leave = waitForDesktopProviders(onRefresh);
    window.addEventListener('focus', onRefresh);
    window.addEventListener('mixdog:remote-reconnected', onRefresh);
    return () => {
      cancelled = true;
      leave();
      window.removeEventListener('focus', onRefresh);
      window.removeEventListener('mixdog:remote-reconnected', onRefresh);
    };
  }, [api, providerSetup.managedByClient]);
  return { loading, load, providerSetup, profile, setProfile };
}

/** The wizard as a modal: background made inert while it is open and focus
 *  returned on close; Ctrl+Enter advances (never under a nested dialog),
 *  Escape closes the nested dialog or asks to skip, Tab stays inside. */
export function useOnboardingModality({
  layerRef,
  dialogRef,
  closeRef,
  advanceRef,
  requestSkip,
}: {
  layerRef: RefObject<HTMLDivElement | null>;
  dialogRef: RefObject<HTMLElement | null>;
  closeRef: RefObject<HTMLButtonElement | null>;
  advanceRef: RefObject<() => void>;
  requestSkip(trigger?: HTMLButtonElement | null): void;
}): void {
  const priorFocus = useRef<HTMLElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: opened once for the wizard's life; the refs are stable
  useLayoutEffect(() => {
    priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const layer = layerRef.current;
    const restoreBackground = layer ? openModal(layer) : () => {};
    closeRef.current?.focus();
    return () => {
      restoreBackground();
      if (priorFocus.current?.isConnected) priorFocus.current.focus();
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the handler reaches state only through refs and stable setters, so one registration serves every render (requestSkip is a per-render closure).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const nested = dialog.querySelector<HTMLElement>('[data-settings-nested-dialog]');
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        // Screen-local submit: never advance underneath a
        // nested dialog (OAuth login, skip confirmation).
        if (nested) return;
        event.preventDefault();
        event.stopPropagation();
        advanceRef.current();
        return;
      }
      if (event.key === 'Escape') {
        if (portaledMenuOpen(dialog)) return;
        event.preventDefault();
        event.stopPropagation();
        if (nested) nested.querySelector<HTMLButtonElement>('[aria-label^="Close"]')?.click();
        else requestSkip(closeRef.current);
        return;
      }
      if (event.key !== 'Tab') return;
      const root = nested || dialog;
      trapTab(event, root, Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)));
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
