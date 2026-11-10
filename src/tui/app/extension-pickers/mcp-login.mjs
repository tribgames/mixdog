// extension-pickers/mcp-login.mjs
// `/mcp login <name>` and `/mcp logout <name>`. The sign-in URL is always
// printed (and kept in the live prompt); the runtime may open the browser. The
// flow is polled while a paste prompt (the shared 'oauth-code' provider prompt)
// accepts the final redirect address. Pasted text is never echoed.
const POLL_MS = 1500;

export function createMcpLogin({ store, setProviderPrompt, pollMs = POLL_MS }) {
  let active = null;

  const stop = (flow) => {
    flow.finished = true;
    clearTimeout(flow.timer);
    if (active === flow) active = null;
  };

  const closePrompt = (flow) => setProviderPrompt((prompt) => (prompt === flow.prompt ? null : prompt));

  const showPrompt = (flow) => {
    if (flow.finished) return;
    const prompt = {
      kind: 'oauth-code',
      providerName: `MCP ${flow.name}`,
      // The shared prompt pushes the one completion notice; no provider picker follows.
      successReturn: () => {},
      label: `MCP sign-in · ${flow.name}`,
      hint: 'If the browser page fails to load, paste its address here.',
      detail: flow.url,
      login: {
        completeCode: async (text) => {
          const result = await store.completeMcpOAuthLogin(flow.id, text);
          if (result?.state !== 'complete') throw new Error(result?.error || 'sign-in did not complete');
          stop(flow);
        },
        cancel: () => {
          if (flow.finished) return;
          stop(flow);
          void Promise.resolve(store.cancelMcpOAuthLogin(flow.id)).catch(() => {});
          store.pushNotice(`MCP sign-in cancelled for ${flow.name}`, 'info');
        },
      },
      failureReturn: () => showPrompt(flow),
    };
    flow.prompt = prompt;
    setProviderPrompt(prompt);
  };

  const poll = (flow) => {
    flow.timer = setTimeout(async () => {
      if (flow.finished) return;
      let status;
      try {
        status = await store.getMcpOAuthLoginStatus(flow.id);
      } catch (e) {
        if (flow.finished) return;
        stop(flow);
        closePrompt(flow);
        store.pushNotice(`MCP sign-in failed for ${flow.name}: ${e?.message || e}`, 'error');
        return;
      }
      if (flow.finished) return;
      if (status?.state === 'pending') {
        poll(flow);
        return;
      }
      stop(flow);
      closePrompt(flow);
      if (status?.state === 'complete') store.pushNotice(`MCP sign-in complete for ${flow.name}`, 'info');
      else if (status?.state === 'cancelled') store.pushNotice(`MCP sign-in cancelled for ${flow.name}`, 'info');
      else store.pushNotice(`MCP sign-in failed for ${flow.name}${status?.error ? `: ${status.error}` : ''}`, 'error');
    }, pollMs);
  };

  const loginMcpServer = async (name) => {
    if (active) {
      const previous = active;
      stop(previous);
      closePrompt(previous);
      void Promise.resolve(store.cancelMcpOAuthLogin(previous.id)).catch(() => {});
    }
    try {
      const started = await store.beginMcpOAuthLogin(name, { openBrowser: true });
      if (started?.state === 'complete') {
        store.pushNotice(`MCP sign-in complete for ${name}`, 'info');
        return;
      }
      const flow = { id: started.flowId, name, url: started.url || '', finished: false, timer: null, prompt: null };
      active = flow;
      if (flow.url) store.pushNotice(`Sign in to ${name}: ${flow.url}`, 'info');
      showPrompt(flow);
      poll(flow);
    } catch (e) {
      store.pushNotice(`MCP sign-in failed for ${name}: ${e?.message || e}`, 'error');
    }
  };

  const logoutMcpServer = async (name) => {
    try {
      await store.signOutMcpServer(name);
      store.pushNotice(`MCP signed out of ${name}`, 'info');
    } catch (e) {
      store.pushNotice(`MCP sign-out failed for ${name}: ${e?.message || e}`, 'error');
    }
  };

  return { loginMcpServer, logoutMcpServer };
}
