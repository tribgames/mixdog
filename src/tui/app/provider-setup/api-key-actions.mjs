// provider-setup/api-key-actions.mjs
// The API-key action panel of one provider row: add/replace/delete a key,
// open the key console, and the OpenCode Go usage-login wait panel. `flow` is
// the per-open picker state (surface claim, paint, navigation) built by
// provider-setup-picker.mjs.
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
  if (providerItem._providerId === 'opencode-go') {
    apiActions.push({
      value: 'usage-login-browser',
      label: 'Usage login (browser)',
      description: 'open browser; auth cookie captured automatically',
      _action: 'usage-login-browser',
    });
  }
  return { apiActions, keyUrl };
}

/** Paints the wait panel and runs the browser usage login; Back returns to
 *  the actions and turns the eventual ack into a notice-only outcome. */
function openUsageLoginWait(flow, providerItem, provider) {
  let backedOut = false;
  const backToActions = () => {
    backedOut = true;
    openApiProviderActions(flow, providerItem);
  };
  flow.paint({
    title: `Provider · ${providerItem._providerName}`,
    description: 'Opening browser. Sign in at opencode.ai/auth; the auth cookie is captured automatically.',
    footer: () => providerStatusFooter(provider),
    help: '↑/↓ Select · Enter Choose · Esc Providers',
    indexMode: 'never',
    labelWidth: 22,
    metaWidth: 12,
    pickerKey: `providers-usage-login:${providerItem.value}`,
    initialIndex: 0,
    items: [
      {
        value: 'waiting',
        label: 'Waiting for login',
        meta: 'Running',
        description: 'sign in via the browser window',
        _action: 'waiting',
      },
      {
        value: 'back',
        label: 'Back',
        meta: '',
        description: 'return to provider actions',
        _action: 'back',
      },
    ],
    onSelect: (_value, item) => {
      if (item?._action === 'back') backToActions();
    },
    onCancel: backToActions,
  });
  void flow.store
    .loginOpenCodeGoUsage()
    .then(() => {
      flow.store.pushNotice('OpenCode Go usage auth captured', 'info');
      if (!backedOut) flow.reopenProviders();
    })
    .catch((e) => {
      flow.store.pushNotice(`OpenCode Go usage login failed: ${e?.message || e}`, 'error');
      if (!backedOut) openApiProviderActions(flow, providerItem);
    });
}

export function openApiProviderActions(flow, providerItem) {
  // Reached from acks (forget-key failure, usage-login back-out) as well as
  // key presses: prove ownership at the sink so every caller is covered.
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
      if (detail._action === 'usage-login-browser') {
        openUsageLoginWait(flow, providerItem, provider);
      }
    },
    onCancel: flow.reopenProviders,
  });
}
