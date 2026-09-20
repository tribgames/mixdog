// provider-auth/login.mjs — credential mutations: API keys, OAuth logins (with
// the browser-callback and code-completion continuations), usage-dashboard
// credentials, and forgetting an account.
import {
  beginOAuthProviderLogin,
  forgetProviderAuth,
  loginOAuthProvider,
  saveOpenAIUsageSessionKey,
  saveOpenCodeGoUsageAuth,
  loginOpenCodeGoUsage,
  saveProviderApiKey,
} from '../../standalone/provider-admin.mjs';

export function createLoginApi({ cfgMod, awaitKeychainPrewarm, reloadFullConfig }, refresh) {
  async function completeOAuthLogin(login) {
    return {
      ...login,
      waitForCallback: login.waitForCallback?.then(async (completed) => {
        await awaitKeychainPrewarm();
        reloadFullConfig();
        if (completed) refresh.adoptCredentials();
        return completed;
      }),
      ...(typeof login.completeCode === 'function'
        ? {
            completeCode: async (code) => {
              const completed = await login.completeCode(code);
              await awaitKeychainPrewarm();
              refresh.afterCredentialChange();
              return completed;
            },
          }
        : {}),
    };
  }

  return {
    async authenticateProvider(providerId, secret) {
      await awaitKeychainPrewarm();
      const result = String(secret || '').trim()
        ? saveProviderApiKey(cfgMod, providerId, secret)
        : await loginOAuthProvider(cfgMod, providerId);
      refresh.afterCredentialChange();
      return result;
    },
    async loginOAuthProvider(providerId) {
      await awaitKeychainPrewarm();
      const result = await loginOAuthProvider(cfgMod, providerId);
      refresh.afterCredentialChange();
      return result;
    },
    async beginOAuthProviderLogin(providerId, options = {}) {
      await awaitKeychainPrewarm();
      const result = await beginOAuthProviderLogin(cfgMod, providerId, options);
      reloadFullConfig();
      return completeOAuthLogin(result);
    },
    saveProviderApiKey(providerId, secret) {
      const result = saveProviderApiKey(cfgMod, providerId, secret);
      refresh.afterCredentialChange();
      return result;
    },
    saveOpenAIUsageSessionKey(secret) {
      const result = saveOpenAIUsageSessionKey(cfgMod, secret);
      refresh.afterUsageAuthChange();
      return result;
    },
    saveOpenCodeGoUsageAuth(opts) {
      const result = saveOpenCodeGoUsageAuth(cfgMod, opts);
      refresh.afterUsageAuthChange();
      return result;
    },
    async loginOpenCodeGoUsage() {
      await awaitKeychainPrewarm();
      const result = await loginOpenCodeGoUsage(cfgMod);
      refresh.afterUsageAuthChange();
      return result;
    },
    forgetProviderAuth(providerId, accountId) {
      const result = forgetProviderAuth(cfgMod, providerId, accountId);
      refresh.afterCredentialChange();
      return result;
    },
  };
}
