// provider-setup/oauth-actions.mjs
// The OAuth action panel of one provider row and the login it starts: the
// progress and result panels, the interactive (code prompt) login through
// store.beginOAuthProviderLogin, and the legacy store.loginOAuthProvider
// path. `flow` is the per-open picker state built by provider-setup-picker.mjs.
import { providerDetailText } from '../app-format.mjs';
import { providerStatusFooter } from './provider-items.mjs';

const panelFrame = (providerItem, provider, pickerKey) => ({
  title: `Provider · ${providerItem._providerName}`,
  footer: () => providerStatusFooter(provider),
  labelWidth: 22,
  metaWidth: 12,
  pickerKey,
  initialIndex: 0,
});

function showOAuthProgress(flow, providerItem, message, onBack) {
  const provider = providerItem._provider || {};
  flow.paint({
    ...panelFrame(providerItem, provider, `providers-oauth-progress:${providerItem.value}`),
    description: message,
    help: '↑/↓ Select · Enter Choose · Esc Providers',
    indexMode: 'never',
    items: [
      {
        value: 'waiting',
        label: 'Waiting for login',
        meta: 'Running',
        description: 'finish the browser/OAuth prompt',
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
      if (item?._action === 'back') onBack();
    },
    onCancel: onBack,
  });
}

function showOAuthResult(flow, providerItem, ok, message = '') {
  const provider = providerItem._provider || {};
  flow.setProviderPrompt(null);
  const leave = () => {
    if (ok) flow.reopenProviders();
    else openOAuthProviderActions(flow, providerItem);
  };
  flow.paint({
    ...panelFrame(providerItem, provider, `providers-oauth-result:${providerItem.value}:${ok ? 'ok' : 'fail'}`),
    description: message || (ok ? 'Login complete.' : 'Login did not complete.'),
    help: ok ? 'Enter Refresh Providers · Esc Providers' : 'Enter Back · Esc Providers',
    indexMode: 'never',
    items: [
      {
        value: ok ? 'success' : 'back',
        label: ok ? 'Success' : 'Back',
        meta: ok ? 'Done' : 'Ready',
        description: ok ? 'refresh provider status' : 'return to provider actions',
        _action: ok ? 'success' : 'back',
      },
    ],
    onSelect: leave,
    onCancel: leave,
  });
}

/** Login through store.beginOAuthProviderLogin: a code-completing login hands
 *  the surface to the OAuth code prompt; the callback (or the prompt) finishes. */
function beginInteractiveOAuthLogin(flow, providerItem, login) {
  let handled = false;
  const providerName = providerItem._providerName || providerItem._providerId || 'OAuth';
  const finish = (ok, message = '') => {
    if (handled) return;
    handled = true;
    if (ok) flow.clearModelCaches('all');
    if (login.backedOut) {
      if (message) flow.store.pushNotice(message, ok ? 'info' : 'error');
      return;
    }
    showOAuthResult(
      flow,
      providerItem,
      ok,
      message || (ok ? `${providerName} login complete.` : `${providerName} login failed.`)
    );
  };
  void flow.store
    .beginOAuthProviderLogin(providerItem._providerId)
    .then((started) => {
      if (typeof started?.completeCode === 'function') {
        // Post-await handover to the OAuth code prompt: only if this flow
        // still owns the surface (Esc during beginOAuthProviderLogin).
        if (!flow.ownsSurface()) return;
        flow.releaseSurface();
        const manualUrl = started?.manualUrl || '';
        flow.setProviderPrompt({
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
          login: started,
          afterSave: flow.returnTo,
          successReturn: () => {
            showOAuthResult(flow, providerItem, true, `${providerName} login complete.`);
          },
          failureReturn: (e) => {
            showOAuthResult(flow, providerItem, false, `${providerName} code failed: ${e?.message || e}`);
          },
          cancelReturn: () => {
            openOAuthProviderActions(flow, providerItem);
          },
        });
        flow.store.pushNotice(
          `browser opened for ${providerName}; paste code/redirect here if callback does not finish`,
          'info'
        );
      } else {
        flow.store.pushNotice(`browser opened for ${providerName}; finish signing in there`, 'info');
      }
      started.waitForCallback
        ?.then((result) => {
          if (result && !flow.oauthSubmitRef.current) finish(true, `${providerName} login complete`);
        })
        .catch((e) => finish(false, `${providerName} login failed: ${e?.message || e}`));
    })
    .catch((e) => {
      flow.store.pushNotice(`${providerName} login failed: ${e?.message || e}`, 'error');
      openOAuthProviderActions(flow, providerItem);
    });
}

/** Login through store.loginOAuthProvider: the promise alone decides the result panel. */
function runLegacyOAuthLogin(flow, providerItem, login) {
  void flow.store
    .loginOAuthProvider(providerItem._providerId)
    .then(() => {
      flow.clearModelCaches('all');
      if (login.backedOut) {
        flow.store.pushNotice(`${providerItem._providerName} login complete`, 'info');
        return;
      }
      showOAuthResult(flow, providerItem, true, `${providerItem._providerName} login complete.`);
    })
    .catch((e) => {
      if (login.backedOut) {
        flow.store.pushNotice(`oauth login failed: ${e?.message || e}`, 'error');
        return;
      }
      showOAuthResult(flow, providerItem, false, `OAuth login failed: ${e?.message || e}`);
    });
}

function startOAuthLogin(flow, providerItem) {
  // Back on the progress panel returns to the actions; a login that settles
  // afterwards becomes a notice instead of a result panel.
  const login = { backedOut: false };
  showOAuthProgress(flow, providerItem, 'Opening login flow. Complete it in the browser if prompted.', () => {
    login.backedOut = true;
    openOAuthProviderActions(flow, providerItem);
  });
  if (typeof flow.store.beginOAuthProviderLogin === 'function') {
    beginInteractiveOAuthLogin(flow, providerItem, login);
    return;
  }
  runLegacyOAuthLogin(flow, providerItem, login);
}

export function openOAuthProviderActions(flow, providerItem) {
  if (!flow.ownsSurface()) return;
  flow.rememberProviderSelection(providerItem);
  const provider = providerItem._provider || {};
  const hasAuth = providerItem._authenticated || provider.authenticated || provider.reauthRequired === true;
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
  flow.paint({
    title: `Provider · ${providerItem._providerName}`,
    description: 'Choose an OAuth login action.',
    footer: () => providerStatusFooter(provider),
    help: '↑/↓ Select · Enter Choose · Esc Providers',
    indexMode: 'always',
    labelWidth: 22,
    pickerKey: `providers-action:${providerItem.value}`,
    initialIndex: 0,
    items: oauthActions,
    onSelect: (_detailValue, detail) => {
      if (detail._action === 'login-oauth') {
        startOAuthLogin(flow, providerItem);
        return;
      }
      if (detail._action === 'forget-oauth') {
        void Promise.resolve(flow.store.forgetProviderAuth?.(providerItem._providerId))
          .then(() => {
            flow.clearModelCaches('all');
            flow.reopenProviders();
          })
          .catch((e) => {
            flow.store.pushNotice(`auth-forget failed: ${e?.message || e}`, 'error');
            openOAuthProviderActions(flow, providerItem);
          });
      }
    },
    onCancel: flow.reopenProviders,
  });
}
