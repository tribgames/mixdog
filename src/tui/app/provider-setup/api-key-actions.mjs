// provider-setup/api-key-actions.mjs
// The API-key action panel of one provider row: add/replace/delete a key and
// open the key console. `flow` is the per-open picker state (surface claim,
// paint, navigation) built by provider-setup-picker.mjs.
import { openInBrowser } from '../../../runtime/shared/open-url.mjs';
import { providerDetailText } from '../app-format.mjs';
import { keyConsoleUrl, providerStatusFooter } from './provider-items.mjs';

const setApiKeyPrompt = (flow, providerItem) => {
  if (!flow.ownsSurface()) return;
  flow.setProviderPrompt({
    kind: 'api-key',
    providerId: providerItem._providerId,
    label: providerItem._providerName,
    mode: providerItem._authenticated ? 'replace' : 'set',
    envName: providerItem._provider?.envName || '',
    source: providerDetailText(providerItem._provider),
    keyUrl: keyConsoleUrl(providerItem._provider),
    afterSave: flow.returnTo,
  });
};

/** The actions offered for this provider's key, given what is stored/known. */
function apiKeyActions(providerItem, provider) {
  const hasAuth = providerItem._authenticated || provider.authenticated;
  const hasStoredKey = provider.stored || (!provider.env && hasAuth);
  const apiActions = [];
  apiActions.push({
    value: 'set-key',
    label: hasAuth ? 'Replace API key' : 'Add API key',
    description: provider.envName ? `masked input · ${provider.envName}` : 'masked input · stored in OS keychain',
    _action: 'set-key',
  });
  const keyUrl = keyConsoleUrl(provider);
  if (keyUrl && !hasAuth) {
    apiActions.push({
      value: 'get-key',
      label: 'Get API key (browser)',
      description: keyUrl,
      _action: 'get-key',
    });
  }
  if (hasStoredKey) {
    apiActions.push({
      value: 'forget-key',
      label: 'Delete API key',
      description: provider.env ? 'remove keychain key; env key remains active' : 'remove stored key for this provider',
      _action: 'forget-key',
    });
  }
  return { apiActions, keyUrl };
}

export function openApiProviderActions(flow, providerItem) {
  // Reached from acks (a failed forget-key) as well as key presses: prove
  // ownership at the sink so every caller is covered.
  if (!flow.ownsSurface()) return;
  flow.rememberProviderSelection(providerItem);
  const provider = providerItem._provider || {};
  const { apiActions, keyUrl } = apiKeyActions(providerItem, provider);
  flow.paint({
    title: `Provider · ${providerItem._providerName}`,
    description: 'Choose an API-key action.',
    footer: () => providerStatusFooter(provider),
    help: '↑/↓ Select · Enter Choose · Esc Providers',
    indexMode: 'always',
    labelWidth: 22,
    pickerKey: `providers-action:${providerItem.value}`,
    initialIndex: 0,
    items: apiActions,
    onSelect: (_detailValue, detail) => {
      flow.releaseSurface();
      if (detail._action === 'set-key') {
        setApiKeyPrompt(flow, providerItem);
        return;
      }
      if (detail._action === 'get-key') {
        // Opener is best-effort (open-url.mjs); the URL stays visible in
        // the key prompt hint so a failed open still leaves it readable.
        openInBrowser(keyUrl);
        flow.store.pushNotice(`opened ${keyUrl}`, 'info');
        setApiKeyPrompt(flow, providerItem);
        return;
      }
      if (detail._action === 'forget-key') {
        // Daemon RPC: only navigate once the removal is acknowledged, and
        // return to these actions (not an empty panel) when it fails.
        void Promise.resolve(flow.store.forgetProviderAuth?.(providerItem._providerId))
          .then(() => {
            flow.clearModelCaches('all');
            flow.reopenProviders();
          })
          .catch((e) => {
            flow.store.pushNotice(`auth-forget failed: ${e?.message || e}`, 'error');
            openApiProviderActions(flow, providerItem);
          });
      }
    },
    onCancel: flow.reopenProviders,
  });
}
