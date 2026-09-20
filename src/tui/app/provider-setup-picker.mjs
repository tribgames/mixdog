/*
 * provider-setup-picker.mjs — the Provider setup picker cluster.
 *
 * openProviderSetupPicker claims the panel surface once per open, loads the
 * provider setup and paints the main list. The per-provider action panels
 * live in provider-setup/ (api-key-actions, oauth-actions) and receive the
 * per-open `flow`: the claim, the paint/release sinks, the remembered row and
 * the list re-open, so a daemon ack landing after Esc can neither paint nor
 * navigate.
 */
import { openApiProviderActions } from './provider-setup/api-key-actions.mjs';
import { openOAuthProviderActions } from './provider-setup/oauth-actions.mjs';
import {
  buildProviderItems,
  providerMainInitialIndex,
  providerStatusFooter,
} from './provider-setup/provider-items.mjs';

const providerFooter = (item) => providerStatusFooter(item?._provider);

export function createProviderSetupPicker({
  store,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  closeUsagePanel,
  oauthSubmitRef,
  clearModelCaches,
}) {
  /** Fetches the provider setup behind a placeholder frame; null when the
   *  fetch failed (already reported). */
  const loadProviderSetup = async (own, options, onCancel) => {
    own.paint({
      title: options.title || 'Providers',
      description: options.description || 'Choose a provider to configure.',
      labelWidth: 18,
      metaWidth: 10,
      pickerKey: 'providers-loading',
      initialIndex: 0,
      items: [
        {
          value: 'checking',
          label: 'Checking Providers',
          meta: '',
          description: 'please wait',
          _type: 'loading',
        },
      ],
      onSelect: () => {},
      onCancel: () => {
        own.close();
        if (onCancel) onCancel();
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return await store.getProviderSetup();
    } catch (e) {
      store.pushNotice(`providers failed: ${e?.message || e}`, 'error');
      return null;
    }
  };

  const openProviderSetupPicker = async (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    const onContinue = typeof options.onContinue === 'function' ? options.onContinue : returnTo;
    const onCancel = typeof options.onCancel === 'function' ? options.onCancel : null;
    // ONE claim (panel-surface.mjs) per open, shared by the nested action /
    // progress / result panels: every paint re-validates and re-arms it, so a
    // daemon ack (key removal, OAuth callback, usage login) landing after Esc
    // can neither paint nor navigate.
    const own = surface.claim();
    setProviderPrompt(null);
    setSettingsPrompt(null);
    // Close full-panel overlays too: they render ahead of providerPrompt in
    // the floating-panel chain, so a lingering usage/context panel would mask
    // any text-entry prompt opened from the provider actions (e.g. the
    // OpenCode Go cookie prompt appeared to do nothing).
    own.context(null);
    closeUsagePanel();
    // Onboarding (and any caller) can pass a preloaded provider setup so we skip
    // the "Checking Providers" placeholder frame that otherwise flashes before
    // the real list — that swap is what looked like a jump on Step 1 entry.
    let setup = options.preloadedSetup && typeof options.preloadedSetup === 'object' ? options.preloadedSetup : null;
    options.preloadedSetup = null;
    if (!setup) {
      setup = await loadProviderSetup(own, options, onCancel);
      if (!setup) return;
    }

    const items = [];
    if ((returnTo || onContinue) && !options.confirmBar) {
      items.push({
        value: 'continue-setup',
        label: options.continueLabel || 'Continue setup',
        description: options.continueDescription || 'return to setup',
        _type: 'continue',
      });
    }
    items.push(...buildProviderItems(setup));

    const flow = {
      store,
      setProviderPrompt,
      clearModelCaches,
      oauthSubmitRef,
      returnTo,
      ownsSurface: () => own.owns(),
      paint: (panel) => own.paint(panel),
      // The flow itself handing the picker surface to a prompt (Enter on a
      // row): still ours, so clear-and-continue instead of going stale. Esc
      // paths use own.close() — leaving IS the handover.
      releaseSurface: () => own.paint(null),
      rememberProviderSelection: (providerItem) => {
        if (!providerItem?.value) return;
        options.highlightProviderValue = providerItem.value;
      },
      reopenProviders: () => {
        // Reached from acks as well as key presses: a stale ack must not
        // restart the whole cluster over the user's surface.
        if (!own.owns()) return;
        void Promise.resolve(openProviderSetupPicker(options)).catch((e) =>
          store.pushNotice(`providers failed: ${e?.message || e}`, 'error')
        );
      },
    };

    flow.paint({
      title: options.title || 'Providers',
      description: options.description || 'Choose a provider. Enter opens provider actions.',
      footer: providerFooter,
      footerGapRows: 1,
      help: options.confirmBar ? undefined : '↑/↓ Select · Enter Open · Esc Back',
      indexMode: 'always',
      labelWidth: 18,
      metaWidth: 12,
      pickerKey: `providers-main:${options.highlightProviderValue || 'root'}`,
      initialIndex: providerMainInitialIndex(items, options.highlightProviderValue),
      items,
      confirmBar: options.confirmBar || null,
      onHighlight: (_value, item) => {
        if (item?._providerId) flow.rememberProviderSelection(item);
      },
      onSelect: (_value, item) => {
        // In-flow navigation (Enter on a provider row): the flow keeps the
        // surface, so clear-and-continue — own.close() would supersede this
        // very flow and paintProviders would then reject the action panel the
        // user just asked for. Esc (onCancel below) does close.
        flow.releaseSurface();
        if (item._type === 'continue') {
          onContinue?.();
          return;
        }
        if (item._type === 'api-key') {
          openApiProviderActions(flow, item);
          return;
        }
        if (item._type === 'oauth') {
          openOAuthProviderActions(flow, item);
        }
      },
      onCancel: () => {
        own.close();
        if (onCancel) onCancel();
        else if (returnTo) returnTo();
      },
    });
  };

  return { openProviderSetupPicker };
}
