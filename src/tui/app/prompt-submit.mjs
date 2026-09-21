// Prompt submit dispatcher. One entry point for
// everything the prompt box can accept: provider/settings
// text-entry prompts, slash commands, and the normal chat submit with
// pasted image/text token expansion. Factory pattern (like the pickers):
// re-created per render so it closes over the CURRENT prompt/panel state.
import { createPanelWrite } from './prompt-submit/panel-write.mjs';
import { submitProviderPrompt } from './prompt-submit/provider-prompts.mjs';
import { submitSettingsPrompt } from './prompt-submit/settings-prompts.mjs';
import { submitChat, submitSlashCommand } from './prompt-submit/chat-submit.mjs';

export function createPromptSubmit(deps) {
  const { store, providerPrompt, settingsPrompt, setProviderPrompt, setSettingsPrompt } = deps;
  const serviceCall = (name, ...args) => {
    const target = store?.[name];
    if (typeof target !== 'function') {
      return Promise.reject(new TypeError(`project service method ${name} is unavailable`));
    }
    return Promise.resolve(target.apply(store, args));
  };
  // Panel openers are async on a daemon-backed store: a bare call leaves a
  // rejected open as an unhandled rejection, which terminates the TUI.
  const openPanel = (open, ...args) => {
    if (typeof open !== 'function') return;
    void Promise.resolve(open(...args)).catch((error) => {
      store.pushNotice(`panel failed to open: ${error?.message || error}`, 'error');
    });
  };
  const submitPrompt = (prompt, options) => {
    if (typeof store.submitAsync !== 'function') return store.submit(prompt, options);
    void Promise.resolve(store.submitAsync(prompt, options))
      .then((accepted) => {
        if (accepted === false) store.pushNotice('prompt was not accepted by the session service', 'error');
      })
      .catch((error) => {
        store.pushNotice(`prompt submit failed: ${error?.message || error}`, 'error');
      });
    // Input clearing remains synchronous; the daemon ACK is responsible for
    // durable intake, while provider execution continues independently.
    return true;
  };
  const ctx = {
    ...deps,
    serviceCall,
    openPanel,
    submitPrompt,
    providerWrite: createPanelWrite('provider', { store, setPrompt: setProviderPrompt }),
    settingsWrite: createPanelWrite('settings', { store, setPrompt: setSettingsPrompt }),
  };
  const onSubmit = (raw) => {
    const text = String(raw ?? '');
    const commandText = text.trim();
    if (providerPrompt) {
      const handled = submitProviderPrompt(ctx, providerPrompt, commandText);
      if (handled !== undefined) return handled;
    }
    // Channel token/target and hook-rule text prompts are retired: channels
    // moved to the PWA and hooks lost their user-facing surface entirely
    // (config file / runtime API only), so no opener sets those prompts.
    if (settingsPrompt) {
      const handled = submitSettingsPrompt(ctx, settingsPrompt, commandText);
      if (handled !== undefined) return handled;
    }
    if (!commandText) return false;
    if (commandText.startsWith('/')) return submitSlashCommand(ctx, commandText);
    return submitChat(ctx, text);
  };

  return { onSubmit };
}
