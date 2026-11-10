/*
 * app/use-onboarding-start.mjs — first-run onboarding gate + wizard launch.
 */
import { useEffect, useRef } from 'react';

// First-run gate. The daemon-backed engine store answers any method it does
// not implement locally with an async remote call, so a synchronous
// getOnboardingStatus() probe can hand back a Promise instead of the status
// object — which read as "not completed" and re-opened a dismissed wizard on
// every launch. runTui resolves the status before mount and passes the verdict
// in; only a local store (tests, direct mounts) falls back to the sync probe,
// and anything unresolvable counts as completed.
export function resolveOnboardingCompleted(store, onboardingCompleted) {
  if (typeof onboardingCompleted === 'boolean') return onboardingCompleted;
  try {
    const status = store.getOnboardingStatus?.();
    if (!status || typeof status !== 'object' || typeof status.then === 'function') return true;
    return status.completed === true;
  } catch {
    return true;
  }
}

export function useOnboardingStart({
  store,
  forceOnboarding,
  onboardingCompleted,
  setOnboardingActive,
  openOnboardingAuthStep,
}) {
  // Latches the launch so the wizard opens at most once per mount.
  const onboardingStartedRef = useRef(false);
  // openOnboardingAuthStep is rebuilt by the picker factory every render;
  // depending on it would re-run this launch (and cancel its deferred open)
  // on every commit. The launch keys on the gate inputs only.
  // biome-ignore lint/correctness/useExhaustiveDependencies(openOnboardingAuthStep): per-render factory callback; launch keys on gate inputs
  useEffect(() => {
    if (onboardingStartedRef.current) return undefined;
    if (resolveOnboardingCompleted(store, onboardingCompleted) && !forceOnboarding) return undefined;
    let canceled = false;
    onboardingStartedRef.current = true;
    setOnboardingActive(true);
    setTimeout(() => {
      if (!canceled) openOnboardingAuthStep();
    }, 0);
    return () => {
      canceled = true;
    };
  }, [store, forceOnboarding, onboardingCompleted, setOnboardingActive]);
}
