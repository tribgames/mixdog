/**
 * onboarding-steps.mjs — the first-run onboarding wizard.
 *
 * A 4-step wizard. Each step's ROOT screen carries a ConfirmBar (Back/Next,
 * Finish on the last step); the Picker owns the bar focus and only fires
 * onConfirm from the bar. Nested depths (API-key entry, model route picker)
 * render without a ConfirmBar so their own key semantics are untouched and
 * step-switching is disabled there. Esc/cancel during onboarding = confirm
 * skip. Deps pointing at later-defined App fns (openProviderSetupPicker,
 * openThemePicker, openOutputStylePicker) resolve the live opener at call
 * time, and the steps reach each other through `nav`, filled once every step
 * exists. The steps live under ./onboarding/:
 *   persist           — Finish / skip persistence and notices
 *   step-data         — Step 2 prefetch + on-entry loads (models, agents)
 *   models-step       — Step 2 root screen (one row per routing slot)
 *   role-model-picker — Step 2's per-slot model picker
 */
import { createModelsStep } from './onboarding/models-step.mjs';
import { createOnboardingPersist } from './onboarding/persist.mjs';
import { createRoleModelStep } from './onboarding/role-model-picker.mjs';
import { createOnboardingStepData } from './onboarding/step-data.mjs';

export function createOnboardingSteps({
  store,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  setOnboardingActive,
  onboardingRef,
  providerModelsCacheRef,
  onboardingPrefetchSeqRef,
  openProviderSetupPicker,
  openThemePicker,
  openOutputStylePicker,
}) {
  const nav = {};
  const { onboardingWarnReopen, finishOnboarding } = createOnboardingPersist({
    store,
    surface,
    setOnboardingActive,
    onboardingRef,
  });
  const stepData = createOnboardingStepData({ store, onboardingRef, providerModelsCacheRef, onboardingPrefetchSeqRef });
  const openOnboardingRoleModelPicker = createRoleModelStep({ store, surface, onboardingRef, nav });
  const openOnboardingWorkflowStep = createModelsStep({
    store,
    surface,
    setProviderPrompt,
    setSettingsPrompt,
    onboardingRef,
    stepData,
    nav,
  });

  const openOnboardingAuthStep = async () => {
    stepData.prefetchOnboardingStep2();
    // Surface claim (panel-surface.mjs): the provider-setup read below runs
    // before anything paints, and the wizard is reachable while a normal
    // surface is on screen (/onboarding, Step-1 re-entry), so Esc during the
    // wait must leave that surface alone instead of dropping Step 1 on it.
    const own = surface.claim();
    // Load the provider setup BEFORE opening the picker so Step 1 renders the
    // real list in one frame instead of flashing the "Checking Providers"
    // placeholder (that swap is what looked like a jump on entry). On failure,
    // fall back to the picker's own in-panel loading path.
    let preloadedSetup = null;
    try {
      preloadedSetup = await store.getProviderSetup?.();
    } catch {
      /* openProviderSetupPicker will show its loading frame + error. */
    }
    if (!own.owns()) return;
    void openProviderSetupPicker({
      title: 'First Run · Step 1/4 · Provider Auth',
      returnTo: () => openOnboardingAuthStep(),
      preloadedSetup,
      confirmBar: {
        buttons: [{ value: 'next', label: 'Next ▶' }],
        // Keep Step 1 visible while Step 2's async model load runs; the next
        // step replaces the picker itself, so no blank frame in between.
        onConfirm: () => {
          void openOnboardingWorkflowStep();
        },
      },
      onCancel: onboardingWarnReopen,
    });
  };

  const openOnboardingThemeStep = () => {
    openThemePicker({
      onboarding: {
        onAdvance: () => openOnboardingOutputStyleStep(),
        onBack: () => void openOnboardingWorkflowStep(),
        onCancel: onboardingWarnReopen,
      },
    });
  };

  const openOnboardingOutputStyleStep = () => {
    openOutputStylePicker({
      onboarding: {
        isLastStep: true,
        onAdvance: () => finishOnboarding(),
        onBack: () => openOnboardingThemeStep(),
        onCancel: onboardingWarnReopen,
      },
    });
  };

  Object.assign(nav, {
    openAuthStep: openOnboardingAuthStep,
    openWorkflowStep: openOnboardingWorkflowStep,
    openThemeStep: openOnboardingThemeStep,
    openRoleModelPicker: openOnboardingRoleModelPicker,
    warnReopen: onboardingWarnReopen,
  });

  return {
    onboardingWarnReopen,
    prefetchOnboardingStep2: stepData.prefetchOnboardingStep2,
    openOnboardingAuthStep,
    openOnboardingThemeStep,
    openOnboardingOutputStyleStep,
    finishOnboarding,
    openOnboardingRoleModelPicker,
    openOnboardingWorkflowStep,
  };
}
