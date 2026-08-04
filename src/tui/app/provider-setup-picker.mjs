/*
 * provider-setup-picker.mjs — the Provider setup picker cluster.
 *
 * Extracted from App.jsx behavior-preservingly as a dependency-injection
 * factory. Every function body is the original App logic verbatim, with closure
 * identifiers threaded through the factory argument. The internal action openers
 * (openApiProviderActions/openOAuthProviderActions/openLocalProviderActions/
 * startOAuthLogin) stay nested inside openProviderSetupPicker so they keep
 * closing over the per-open `setup`/`items`/`returnTo`. Refs and cache
 * invalidation thread directly.
 */
import { theme } from '../theme.mjs';
import {
  providerStatusLabel,
  providerDetailText,
  providerKindLabel,
} from './app-format.mjs';
import { providerDisplayRank } from './model-options.mjs';

export function createProviderSetupPicker({
  store,
  setPicker,
  setProviderPrompt,
  setChannelPrompt,
  setHookPrompt,
  setSettingsPrompt,
  setContextPanel,
  closeUsagePanel,
  oauthSubmitRef,
  clearModelCaches,
}) {
  const openProviderSetupPicker = async (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    const onContinue = typeof options.onContinue === 'function' ? options.onContinue : returnTo;
    const onCancel = typeof options.onCancel === 'function' ? options.onCancel : null;
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    // Close full-panel overlays too: they render ahead of providerPrompt in
    // the floating-panel chain, so a lingering usage/context panel would mask
    // any text-entry prompt opened from the provider actions (e.g. the
    // OpenCode Go cookie prompt appeared to do nothing).
    setContextPanel(null);
    closeUsagePanel();
    // Onboarding (and any caller) can pass a preloaded provider setup so we skip
    // the "Checking Providers" placeholder frame that otherwise flashes before
    // the real list — that swap is what looked like a jump on Step 1 entry.
    let setup = options.preloadedSetup && typeof options.preloadedSetup === 'object'
      ? options.preloadedSetup
      : null;
    options.preloadedSetup = null;
    if (!setup) {
      setPicker({
        title: options.title || 'Providers',
        description: options.description || 'Choose a provider to configure.',
        labelWidth: 18,
        metaWidth: 10,
        pickerKey: 'providers-loading',
        initialIndex: 0,
        items: [{
          value: 'checking',
          label: 'Checking Providers',
          meta: '',
          description: 'please wait',
          _type: 'loading',
        }],
        onSelect: () => {},
        onCancel: () => {
          setPicker(null);
          if (onCancel) onCancel();
        },
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        setup = await store.getProviderSetup();
      } catch (e) {
        store.pushNotice(`providers failed: ${e?.message || e}`, 'error');
        return;
      }
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
    const providerFooter = (item) => {
      const provider = item?._provider;
      if (!provider) return '';
      const active = provider.enabled || provider.authenticated || provider.detected;
      return [{
        glyph: active ? '●' : '○',
        color: active ? theme.success : theme.inactive,
        text: [providerKindLabel(provider), providerStatusLabel(provider), providerDetailText(provider)].filter(Boolean).join(' · '),
      }];
    };
    const providerItemRank = (item) => providerDisplayRank(item._providerId || item.value);
    const providerItems = [];
    for (const p of setup.api || []) {
      providerItems.push({
        value: `api:${p.id}`,
        label: p.name,
        meta: providerStatusLabel(p),
        description: '',
        _type: 'api-key',
        _providerId: p.id,
        _providerName: p.name,
        _provider: p,
        _authenticated: p.authenticated,
        _url: p.url,
      });
    }
    for (const p of setup.oauth || []) {
      providerItems.push({
        value: `oauth:${p.id}`,
        label: p.name,
        meta: providerStatusLabel(p),
        description: '',
        _type: 'oauth',
        _providerId: p.id,
        _providerName: p.name,
        _provider: p,
        _authenticated: p.authenticated,
      });
    }
    for (const p of setup.local || []) {
      providerItems.push({
        value: `local:${p.id}`,
        label: p.name,
        meta: providerStatusLabel(p),
        description: '',
        _type: 'local',
        _providerId: p.id,
        _providerName: p.name,
        _provider: p,
        _enabled: p.enabled,
        _baseURL: p.baseURL,
        _defaultURL: p.defaultURL,
      });
    }
    providerItems.sort((a, b) => {
      const rank = providerItemRank(a) - providerItemRank(b);
      if (rank !== 0) return rank;
      return String(a.label || '').localeCompare(String(b.label || ''), 'en', { sensitivity: 'base' });
    });
    items.push(...providerItems);

    const rememberProviderSelection = (providerItem) => {
      if (!providerItem?.value) return;
      options.highlightProviderValue = providerItem.value;
    };
    const providerMainInitialIndex = () => {
      const value = options.highlightProviderValue;
      if (!value) return 0;
      const idx = items.findIndex((item) => item.value === value);
      return idx >= 0 ? idx : 0;
    };

    const reopenProviders = () => {
      void openProviderSetupPicker(options);
    };
    const providerActionFooter = (provider) => provider ? [{
      glyph: provider.enabled || provider.authenticated || provider.detected ? '●' : '○',
      color: provider.enabled || provider.authenticated || provider.detected ? theme.success : theme.inactive,
      text: [providerKindLabel(provider), providerStatusLabel(provider), providerDetailText(provider)].filter(Boolean).join(' · '),
    }] : '';
    const setApiKeyPrompt = (providerItem) => {
      setProviderPrompt({
        kind: 'api-key',
        providerId: providerItem._providerId,
        label: providerItem._providerName,
        mode: providerItem._authenticated ? 'replace' : 'set',
        envName: providerItem._provider?.envName || '',
        source: providerDetailText(providerItem._provider),
        afterSave: returnTo,
      });
    };
    const openApiProviderActions = (providerItem) => {
      rememberProviderSelection(providerItem);
      const provider = providerItem._provider || {};
      const hasAuth = providerItem._authenticated || provider.authenticated;
      const hasStoredKey = provider.stored || (!provider.env && hasAuth);
      const apiActions = [];
      apiActions.push({
        value: 'set-key',
        label: hasAuth ? 'Replace API key' : 'Add API key',
        description: provider.envName ? `masked input · ${provider.envName}` : 'masked input · stored in OS keychain',
        _action: 'set-key',
      });
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
      setPicker({
        title: `Provider · ${providerItem._providerName}`,
        description: 'Choose an API-key action.',
        footer: () => providerActionFooter(provider),
        help: '↑/↓ Select · Enter Choose · Esc Providers',
        indexMode: 'always',
        labelWidth: 22,
        pickerKey: `providers-action:${providerItem.value}`,
        initialIndex: 0,
        items: apiActions,
        onSelect: (_detailValue, detail) => {
          setPicker(null);
          if (detail._action === 'set-key') {
            setApiKeyPrompt(providerItem);
            return;
          }
          if (detail._action === 'forget-key') {
            try {
              store.forgetProviderAuth(providerItem._providerId);
              clearModelCaches('all');
              reopenProviders();
            } catch (e) {
              store.pushNotice(`auth-forget failed: ${e?.message || e}`, 'error');
            }
          }
          if (detail._action === 'usage-login-browser') {
            let backedOut = false;
            const waitItems = [
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
            ];
            setPicker({
              title: `Provider · ${providerItem._providerName}`,
              description: 'Opening browser. Sign in at opencode.ai/auth; the auth cookie is captured automatically.',
              footer: () => providerActionFooter(provider),
              help: '↑/↓ Select · Enter Choose · Esc Providers',
              indexMode: 'never',
              labelWidth: 22,
              metaWidth: 12,
              pickerKey: `providers-usage-login:${providerItem.value}`,
              initialIndex: 0,
              items: waitItems,
              onSelect: (_value, item) => {
                if (item?._action === 'back') {
                  backedOut = true;
                  openApiProviderActions(providerItem);
                }
              },
              onCancel: () => {
                backedOut = true;
                openApiProviderActions(providerItem);
              },
            });
            void store.loginOpenCodeGoUsage()
              .then(() => {
                store.pushNotice('OpenCode Go usage auth captured', 'info');
                if (!backedOut) reopenProviders();
              })
              .catch((e) => {
                store.pushNotice(`OpenCode Go usage login failed: ${e?.message || e}`, 'error');
                if (!backedOut) openApiProviderActions(providerItem);
              });
            return;
          }
        },
        onCancel: reopenProviders,
      });
    };

    const startOAuthLogin = (providerItem) => {
      const provider = providerItem._provider || {};
      const showOAuthProgress = (message = 'Opening login flow. Complete it in the browser if prompted.', opts = {}) => {
        const onBack = typeof opts.onBack === 'function' ? opts.onBack : () => openOAuthProviderActions(providerItem);
        const actions = [
          {
            value: 'waiting',
            label: opts.waitLabel || 'Waiting for login',
            meta: 'Running',
            description: opts.waitDescription || 'finish the browser/OAuth prompt',
            _action: 'waiting',
          },
          {
            value: 'back',
            label: 'Back',
            meta: '',
            description: 'return to provider actions',
            _action: 'back',
          },
        ];
        setPicker({
          title: `Provider · ${providerItem._providerName}`,
          description: message,
          footer: () => providerActionFooter(provider),
          help: '↑/↓ Select · Enter Choose · Esc Providers',
          indexMode: 'never',
          labelWidth: 22,
          metaWidth: 12,
          pickerKey: `providers-oauth-progress:${providerItem.value}`,
          initialIndex: 0,
          items: actions,
          onSelect: (_value, item) => {
            if (item?._action === 'back') onBack();
          },
          onCancel: onBack,
        });
      };
      const showOAuthResult = (ok, message = '') => {
        setProviderPrompt(null);
        setPicker({
          title: `Provider · ${providerItem._providerName}`,
          description: message || (ok ? 'Login complete.' : 'Login did not complete.'),
          footer: () => providerActionFooter(provider),
          help: ok ? 'Enter Refresh Providers · Esc Providers' : 'Enter Back · Esc Providers',
          indexMode: 'never',
          labelWidth: 22,
          metaWidth: 12,
          pickerKey: `providers-oauth-result:${providerItem.value}:${ok ? 'ok' : 'fail'}`,
          initialIndex: 0,
          items: [{
            value: ok ? 'success' : 'back',
            label: ok ? 'Success' : 'Back',
            meta: ok ? 'Done' : 'Ready',
            description: ok ? 'refresh provider status' : 'return to provider actions',
            _action: ok ? 'success' : 'back',
          }],
          onSelect: () => {
            if (ok) reopenProviders();
            else openOAuthProviderActions(providerItem);
          },
          onCancel: () => {
            if (ok) reopenProviders();
            else openOAuthProviderActions(providerItem);
          },
        });
      };
      let backedOut = false;
      showOAuthProgress('Opening login flow. Complete it in the browser if prompted.', {
        onBack: () => {
          backedOut = true;
          openOAuthProviderActions(providerItem);
        },
      });
      if (typeof store.beginOAuthProviderLogin === 'function') {
        let handled = false;
        const providerName = providerItem._providerName || providerItem._providerId || 'OAuth';
        const finish = (ok, message = '') => {
          if (handled) return;
          handled = true;
          if (ok) clearModelCaches('all');
          if (backedOut) {
            if (message) store.pushNotice(message, ok ? 'info' : 'error');
            return;
          }
          showOAuthResult(ok, message || (ok ? `${providerName} login complete.` : `${providerName} login failed.`));
        };
        void store.beginOAuthProviderLogin(providerItem._providerId)
          .then((login) => {
            setPicker(null);
            const manualUrl = login?.manualUrl || '';
            setProviderPrompt({
              kind: 'oauth-code',
              providerId: providerItem._providerId,
              providerName,
              label: `${providerName} OAuth code`,
              hint: manualUrl
                ? 'If the browser callback does not finish, open the URL below manually and paste code#state.'
                : `Paste the authorization code or full redirect URL for ${providerName}.`,
              // Shown inside the live panel only — never written to the
              // transcript, so it cannot linger in scrollback after the flow.
              detail: manualUrl,
              login,
              afterSave: returnTo,
              successReturn: () => {
                showOAuthResult(true, `${providerName} login complete.`);
              },
              failureReturn: (e) => {
                showOAuthResult(false, `${providerName} code failed: ${e?.message || e}`);
              },
              cancelReturn: () => {
                openOAuthProviderActions(providerItem);
              },
            });
            store.pushNotice(`browser opened for ${providerName}; paste code/redirect here if callback does not finish`, 'info');
            login.waitForCallback
              ?.then((result) => {
                if (result && !oauthSubmitRef.current) finish(true, `${providerName} login complete`);
              })
              .catch((e) => finish(false, `oauth login failed: ${e?.message || e}`));
          })
          .catch((e) => {
            store.pushNotice(`oauth login failed: ${e?.message || e}`, 'error');
            openOAuthProviderActions(providerItem);
          });
        return;
      }
      void store.loginOAuthProvider(providerItem._providerId)
        .then(() => {
          clearModelCaches('all');
          if (backedOut) {
            store.pushNotice(`${providerItem._providerName} login complete`, 'info');
            return;
          }
          showOAuthResult(true, `${providerItem._providerName} login complete.`);
        })
        .catch((e) => {
          if (backedOut) {
            store.pushNotice(`oauth login failed: ${e?.message || e}`, 'error');
            return;
          }
          showOAuthResult(false, `OAuth login failed: ${e?.message || e}`);
        });
    };
    const openOAuthProviderActions = (providerItem) => {
      rememberProviderSelection(providerItem);
      const provider = providerItem._provider || {};
      const hasAuth = providerItem._authenticated || provider.authenticated;
      const oauthActions = [];
      oauthActions.push({
        value: 'login-oauth',
        label: hasAuth ? 'Re-login' : 'Login',
        description: providerDetailText(provider) || 'open browser or OAuth flow',
        _action: 'login-oauth',
      });
      if (hasAuth) {
        oauthActions.push({
          value: 'forget-oauth',
          label: 'Forget login',
          description: 'remove stored OAuth credentials',
          _action: 'forget-oauth',
        });
      }
      setPicker({
        title: `Provider · ${providerItem._providerName}`,
        description: 'Choose an OAuth login action.',
        footer: () => providerActionFooter(provider),
        help: '↑/↓ Select · Enter Choose · Esc Providers',
        indexMode: 'always',
        labelWidth: 22,
        pickerKey: `providers-action:${providerItem.value}`,
        initialIndex: 0,
        items: oauthActions,
        onSelect: (_detailValue, detail) => {
          if (detail._action === 'login-oauth') {
            startOAuthLogin(providerItem);
            return;
          }
          if (detail._action === 'forget-oauth') {
            try {
              store.forgetProviderAuth(providerItem._providerId);
              clearModelCaches('all');
              reopenProviders();
            } catch (e) {
              store.pushNotice(`auth-forget failed: ${e?.message || e}`, 'error');
            }
          }
        },
        onCancel: reopenProviders,
      });
    };

    const openLocalProviderActions = (providerItem) => {
      rememberProviderSelection(providerItem);
      const provider = providerItem._provider || {};
      const localActions = [
        {
          value: 'set-local-url',
          label: providerItem._enabled ? 'Update Base URL' : 'Enable / Set URL',
          description: providerDetailText(provider) || providerItem._defaultURL,
          _action: 'set-local-url',
        },
      ];
      if (providerItem._enabled) {
        localActions.push({
          value: 'disable-local',
          label: 'Disable provider',
          description: 'keep URL but stop using this local provider',
          _action: 'disable-local',
        });
      }
      setPicker({
        title: `Provider · ${providerItem._providerName}`,
        description: 'Choose a local endpoint action.',
        footer: () => providerActionFooter(provider),
        help: '↑/↓ Select · Enter Choose · Esc Providers',
        indexMode: 'always',
        labelWidth: 22,
        pickerKey: `providers-action:${providerItem.value}`,
        initialIndex: 0,
        items: localActions,
        onSelect: (_detailValue, detail) => {
          setPicker(null);
          if (detail._action === 'set-local-url') {
            setProviderPrompt({
              kind: 'local-url',
              providerId: providerItem._providerId,
              label: providerItem._providerName,
              defaultURL: providerItem._baseURL || providerItem._defaultURL,
              afterSave: returnTo,
            });
            return;
          }
          if (detail._action === 'disable-local') {
            try {
              store.setLocalProvider(providerItem._providerId, { enabled: false, baseURL: providerItem._baseURL });
              clearModelCaches('all');
              reopenProviders();
            } catch (e) {
              store.pushNotice(`local provider update failed: ${e?.message || e}`, 'error');
            }
          }
        },
        onCancel: reopenProviders,
      });
    };

    setPicker({
      title: options.title || 'Providers',
      description: options.description || 'Choose a provider. Enter opens provider actions.',
      footer: providerFooter,
      footerGapRows: 1,
      help: options.confirmBar ? undefined : '↑/↓ Select · Enter Open · Esc Back',
      indexMode: 'always',
      labelWidth: 18,
      metaWidth: 12,
      pickerKey: `providers-main:${options.highlightProviderValue || 'root'}`,
      initialIndex: providerMainInitialIndex(),
      items,
      confirmBar: options.confirmBar || null,
      onHighlight: (_value, item) => {
        if (item?._providerId) rememberProviderSelection(item);
      },
      onSelect: (_value, item) => {
        setPicker(null);
        if (item._type === 'continue') {
          onContinue?.();
          return;
        }
        if (item._type === 'api-key') {
          openApiProviderActions(item);
          return;
        }
        if (item._type === 'oauth') {
          openOAuthProviderActions(item);
          return;
        }
        if (item._type === 'local') {
          openLocalProviderActions(item);
        }
      },
      onCancel: () => {
        setPicker(null);
        if (onCancel) onCancel();
        else if (returnTo) returnTo();
      },
    });
  };

  return { openProviderSetupPicker };
}
