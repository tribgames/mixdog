/**
 * src/tui/app/prompt-submit/provider-prompts.mjs - text-entry prompts that
 * write provider credentials: API key, OpenAI usage session key, OAuth code.
 * Every write is a DAEMON RPC (async): the prompt may only close once the
 * write is acknowledged; a rejection keeps the panel open with the entered
 * value restored so a transport hiccup never silently eats a credential.
 */

function afterProviderSave(ctx, target) {
  if (target.afterSave) target.afterSave();
  else ctx.openPanel(ctx.openProviderSetupPicker);
}

function providerSave(ctx, target, value, { requiredNotice, busyNotice, method, args, onSaved, failurePrefix }) {
  const { store, serviceCall, providerWrite } = ctx;
  if (!value) {
    store.pushNotice(requiredNotice, 'warn');
    return false;
  }
  if (providerWrite.inFlight()) {
    store.pushNotice(busyNotice, 'warn');
    return false;
  }
  const token = providerWrite.begin(target);
  void serviceCall(method, ...args)
    .then(() => {
      onSaved?.();
      providerWrite.finish(token, () => afterProviderSave(ctx, target));
    })
    .catch((error) => providerWrite.fail(target, value, `${failurePrefix}: ${error?.message || error}`, token));
  return true;
}

function saveApiKey(ctx, target, commandText) {
  return providerSave(ctx, target, commandText, {
    requiredNotice: `API key is required for ${target.providerId}`,
    busyNotice: 'API key is already being saved',
    method: 'saveProviderApiKey',
    args: [target.providerId, commandText],
    onSaved: () => ctx.clearModelCaches('all'),
    failurePrefix: 'api key save failed',
  });
}

function saveUsageSessionKey(ctx, target, commandText) {
  return providerSave(ctx, target, commandText, {
    requiredNotice: 'OpenAI usage session key is required for credit lookup',
    busyNotice: 'OpenAI usage session key is already being saved',
    method: 'saveOpenAIUsageSessionKey',
    args: [commandText],
    failurePrefix: 'OpenAI usage auth save failed',
  });
}

function completeOAuthCode(ctx, target, commandText) {
  const { store, oauthSubmitRef, setProviderPrompt, clearModelCaches } = ctx;
  if (!commandText) {
    store.pushNotice('OAuth code is required', 'warn');
    return false;
  }
  if (oauthSubmitRef.current || target.submitting) {
    store.pushNotice('OAuth code is already being submitted', 'warn');
    return false;
  }
  oauthSubmitRef.current = true;
  setProviderPrompt((prompt) => (prompt === target ? { ...prompt, submitting: true } : prompt));
  // Every exit below must drop oauthSubmitRef: a missing login or a synchronous
  // throw lands on the same failure path as a rejected completion.
  const completion =
    typeof target.login?.completeCode === 'function'
      ? new Promise((resolve) => resolve(target.login.completeCode(commandText)))
      : Promise.reject(new Error('OAuth login is no longer active'));
  void completion
    .then(() => {
      const successReturn = target.successReturn;
      const afterSave = target.afterSave;
      oauthSubmitRef.current = false;
      clearModelCaches('all');
      setProviderPrompt(null);
      store.pushNotice(`${target.providerName || 'OAuth'} login complete`, 'info');
      if (successReturn) successReturn();
      else if (afterSave) afterSave();
      else ctx.openPanel(ctx.openProviderSetupPicker);
    })
    .catch((e) => {
      oauthSubmitRef.current = false;
      store.pushNotice(`oauth code failed: ${e?.message || e}`, 'error');
      setProviderPrompt(null);
      target.failureReturn?.(e);
    });
  return true;
}

const PROVIDER_PROMPTS = {
  'api-key': saveApiKey,
  'openai-usage-session': saveUsageSessionKey,
  'oauth-code': completeOAuthCode,
};

/** true/false when the prompt consumed the submit; undefined for an unknown kind. */
export function submitProviderPrompt(ctx, providerPrompt, commandText) {
  if (ctx.state.commandBusy) {
    ctx.store.pushNotice('wait for the current command to finish', 'warn');
    return false;
  }
  const handler = PROVIDER_PROMPTS[providerPrompt.kind];
  return handler ? handler(ctx, providerPrompt, commandText) : undefined;
}
