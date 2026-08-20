// Welcome-screen prompt hint, extracted from App.jsx. A random starter tip is
// pinned per process; setup problems (no provider/model, solo workflow,
// unsupported default web-search route, error toasts) override it with a targeted
// conditional hint. Dismissal only fires while the hint row is actually on
// screen AND the draft gains its first character — generic key/mouse events
// used to dismiss it before the user ever typed.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONDITIONAL_WELCOME_PROMPT_HINTS,
  activeWorkflowSummaryForStore,
  providerSetupHasUsableProvider,
  randomWelcomePromptHint,
} from './app-format.mjs';

export function useWelcomePromptHint({ store, state, toastErrorSignature }) {
  const [welcomePromptHintDismissed, setWelcomePromptHintDismissed] = useState(false);
  const [conditionalWelcomePromptHint, setConditionalWelcomePromptHint] = useState('');
  const welcomePromptHintRef = useRef(null);
  if (welcomePromptHintRef.current === null) {
    welcomePromptHintRef.current = randomWelcomePromptHint();
  }
  // Tracks whether the welcome hint row is ACTUALLY on screen this frame.
  const welcomePromptHintVisibleRef = useRef(false);
  const dismissWelcomePromptHint = useCallback(() => {
    if (!welcomePromptHintVisibleRef.current) return;
    setWelcomePromptHintDismissed((dismissed) => dismissed || true);
  }, []);

  useEffect(() => {
    let alive = true;
    const refreshConditionalWelcomeHint = async () => {
      let next = '';
      try {
        const setup = await store.getProviderSetup?.();
        if (setup && !providerSetupHasUsableProvider(setup)) {
          next = CONDITIONAL_WELCOME_PROMPT_HINTS.noProvider;
        }
      } catch {
        // If provider setup probing fails, let the generic/error tip path decide.
      }
      if (!next) {
        const activeProvider = String(state.provider || '').trim();
        const activeModel = String(state.model || '').trim();
        if (!activeProvider || !activeModel) {
          next = CONDITIONAL_WELCOME_PROMPT_HINTS.noModel;
        } else {
          try {
            const models = await Promise.resolve(store.listProviderModels?.({ quick: true }) || []);
            if (Array.isArray(models) && models.length === 0) {
              next = CONDITIONAL_WELCOME_PROMPT_HINTS.noModel;
            }
          } catch {
            // Model probing is advisory only; avoid replacing the random hint on failure.
          }
        }
      }
      const activeWorkflow = await activeWorkflowSummaryForStore(store, state.workflow || {});
      if (!next && String(activeWorkflow?.id || state.workflow?.id || '').toLowerCase() === 'solo') {
        next = CONDITIONAL_WELCOME_PROMPT_HINTS.soloWorkflow;
      }
      if (!next) {
        const webSearchRoute = (await store.getWebSearchRoute?.()) || null;
        const webSearchProvider = String(webSearchRoute?.provider || '').trim();
        const webSearchModel = String(webSearchRoute?.model || '').trim();
        const defaultWebSearchRoute = webSearchProvider.toLowerCase() === 'default' && webSearchModel.toLowerCase() === 'default';
        if (defaultWebSearchRoute) {
          try {
            const models = await Promise.resolve(store.listProviderModels?.({ quick: true }) || []);
            const current = Array.isArray(models)
              ? models.find((model) => model?.provider === state.provider && model?.id === state.model)
              : null;
            if (current && current.supportsWebSearch !== true) {
              next = CONDITIONAL_WELCOME_PROMPT_HINTS.webSearchDefaultUnsupported;
            }
          } catch {
            // Web-search default probing is advisory only.
          }
        }
      }
      if (!next && toastErrorSignature) {
        next = CONDITIONAL_WELCOME_PROMPT_HINTS.error;
      }
      if (alive) setConditionalWelcomePromptHint((prev) => (prev === next ? prev : next));
    };
    void refreshConditionalWelcomeHint();
    return () => { alive = false; };
  }, [store, state.provider, state.model, state.workflow?.id, toastErrorSignature]);

  return {
    welcomePromptHintDismissed,
    conditionalWelcomePromptHint,
    welcomePromptHintRef,
    welcomePromptHintVisibleRef,
    dismissWelcomePromptHint,
  };
}
