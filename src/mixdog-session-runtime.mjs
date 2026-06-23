const RUNTIME = './runtime/agent/orchestrator';
const STATUSLINE_SESSION_ROUTES = './vendor/statusline/src/gateway/session-routes.mjs';

const DEFAULT_PROVIDER = 'anthropic-oauth';
const DEFAULT_MODEL = 'claude-opus-4-8';
const TOOL_MODES = new Set(['full', 'readonly']);

function normalizeToolMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  return TOOL_MODES.has(value) ? value : 'full';
}

function toolSpecForMode(mode) {
  return mode === 'readonly' ? ['tools:readonly'] : 'full';
}

function clean(value) {
  return String(value ?? '').trim();
}

function findPreset(config, key) {
  const wanted = clean(key).toLowerCase();
  if (!wanted) return null;
  const presets = Array.isArray(config?.presets) ? config.presets : [];
  return presets.find((p) => {
    const id = clean(p?.id).toLowerCase();
    const name = clean(p?.name).toLowerCase();
    return id === wanted || name === wanted;
  }) || null;
}

function resolveRoute(config, { provider, model } = {}) {
  const explicitProvider = clean(provider);
  const explicitModel = clean(model);

  if (explicitModel && !explicitProvider) {
    const preset = findPreset(config, explicitModel);
    if (preset) {
      return {
        provider: clean(preset.provider) || DEFAULT_PROVIDER,
        model: clean(preset.model) || DEFAULT_MODEL,
        preset,
      };
    }
  }

  if (!explicitProvider && !explicitModel) {
    const defaultKey = config?.default;
    const preset = findPreset(config, defaultKey) || findPreset(config, 'opus-high');
    if (preset) {
      return {
        provider: clean(preset.provider) || DEFAULT_PROVIDER,
        model: clean(preset.model) || DEFAULT_MODEL,
        preset,
      };
    }
  }

  return {
    provider: explicitProvider || DEFAULT_PROVIDER,
    model: explicitModel || DEFAULT_MODEL,
    preset: null,
  };
}

function ensureProviderEnabled(config, provider) {
  const providers = { ...(config?.providers || {}) };
  providers[provider] = { ...(providers[provider] || {}), enabled: true };
  return providers;
}

function routeForStatusline(route) {
  const out = {
    mode: 'fixed',
    defaultProvider: route.provider,
    defaultModel: route.model,
  };
  const preset = route.preset || {};
  if (preset.id) out.presetId = preset.id;
  if (preset.name) out.presetName = preset.name;
  if (preset.effort) out.effort = preset.effort;
  if (preset.displayEffort) out.displayEffort = preset.displayEffort;
  if (preset.modelDisplay) out.modelDisplay = preset.modelDisplay;
  if (preset.fast === true || preset.fast === false) out.fast = preset.fast;
  return out;
}

export async function createMixdogSessionRuntime({
  provider,
  model,
  cwd = process.cwd(),
  toolMode = 'full',
} = {}) {
  process.env.MIXDOG_QUIET_SESSION_LOG ??= '1';

  const cfgMod = await import(`${RUNTIME}/config.mjs`);
  const reg = await import(`${RUNTIME}/providers/registry.mjs`);
  const mgr = await import(`${RUNTIME}/session/manager.mjs`);
  const statusRoutes = await import(STATUSLINE_SESSION_ROUTES).catch(() => null);

  const config = cfgMod.loadConfig();
  let route = resolveRoute(config, { provider, model });
  let mode = normalizeToolMode(toolMode);
  let session = null;

  async function createCurrentSession() {
    const providers = ensureProviderEnabled(config, route.provider);
    await reg.initProviders(providers);
    const providerImpl = reg.getProvider(route.provider);
    if (!providerImpl) {
      throw new Error(`Provider "${route.provider}" is not configured.`);
    }
    session = mgr.createSession({
      provider: route.provider,
      model: route.model,
      preset: route.preset || undefined,
      tools: toolSpecForMode(mode),
      owner: 'cli',
      lane: 'cli',
      sourceType: 'cli',
      sourceName: 'main',
      skipSkills: true,
      disallowedTools: ['diagnostics', 'open_config'],
      cwd,
    });
    statusRoutes?.writeGatewaySessionRoute?.(session.id, routeForStatusline(route));
    return session;
  }

  await createCurrentSession();

  return {
    get id() {
      return session?.id || null;
    },
    get provider() {
      return route.provider;
    },
    get model() {
      return route.model;
    },
    get toolMode() {
      return mode;
    },
    get session() {
      return session;
    },
    listPresets() {
      return cfgMod.listPresets(config);
    },
    async listProviderModels() {
      const allProviders = reg.getAllProviders();
      const results = [];
      for (const [name, provider] of allProviders) {
        if (typeof provider?.listModels !== 'function') continue;
        try {
          const models = await provider.listModels();
          if (Array.isArray(models)) {
            for (const m of models) {
              if (!m?.id) continue;
              results.push({
                id: m.id,
                provider: name,
                display: m.display || m.name || m.id,
                contextWindow: m.contextWindow,
              });
            }
          }
        } catch (err) {
          process.stderr.write(`[runtime] listModels failed for ${name}: ${err.message}\n`);
        }
      }
      return results;
    },
    async ask(prompt, options = {}) {
      if (!session?.id) await createCurrentSession();
      const result = await mgr.askSession(
        session.id,
        prompt,
        options.context || null,
        options.onToolCall,
        cwd,
        options.prefetch || null,
        {
          onTextDelta: options.onTextDelta,
          onReasoningDelta: options.onReasoningDelta,
          onUsageDelta: options.onUsageDelta,
          onStageChange: options.onStageChange,
          onStreamDelta: options.onStreamDelta,
        },
      );
      session = mgr.getSession(session.id) || session;
      return { result, session };
    },
    async clear() {
      if (!session?.id) return false;
      return await mgr.clearSessionMessages(session.id);
    },
    async compact() {
      if (!session?.id) return null;
      const result = await mgr.compactSessionMessages(session.id);
      session = mgr.getSession(session.id) || session;
      return result;
    },
    async setToolMode(nextMode) {
      mode = normalizeToolMode(nextMode);
      if (session?.id) mgr.closeSession(session.id, 'cli-mode-switch');
      await createCurrentSession();
      return mode;
    },
    async setRoute(next) {
      const requested = { ...(next || {}) };
      if (!requested.provider && requested.model && !findPreset(config, requested.model)) {
        requested.provider = route.provider;
      }
      route = resolveRoute(config, requested);
      if (session?.id) mgr.closeSession(session.id, 'cli-model-switch');
      await createCurrentSession();
      return route;
    },
    close(reason = 'cli-exit') {
      if (!session?.id) return false;
      statusRoutes?.clearGatewaySessionRoute?.(session.id);
      const ok = mgr.closeSession(session.id, reason);
      session = null;
      return ok;
    },
    abort(reason = 'cli-abort') {
      if (!session?.id) return false;
      statusRoutes?.clearGatewaySessionRoute?.(session.id);
      const ok = mgr.closeSession(session.id, reason);
      session = null;
      return ok;
    },
    listSessions() {
      return mgr.listSessions({}).map(s => {
        const msgs = s.messages || [];
        const firstUser = msgs.find(m => m && m.role === 'user');
        const preview = firstUser
          ? (typeof firstUser.content === 'string'
              ? firstUser.content.slice(0, 120)
              : '(non-text)')
          : '';
        const userAsst = msgs.filter(m => m && (m.role === 'user' || m.role === 'assistant'));
        return {
          id: s.id,
          updatedAt: s.updatedAt,
          model: s.model,
          provider: s.provider,
          messageCount: userAsst.length,
          preview,
        };
      });
    },
    async newSession() {
      if (session?.id) mgr.closeSession(session.id, 'cli-new');
      await createCurrentSession();
      return session.id;
    },
    async resume(id) {
      const previousId = session?.id || null;
      const resumed = await mgr.resumeSession(id, toolSpecForMode(mode));
      if (!resumed) return null;
      if (previousId && previousId !== resumed.id) {
        statusRoutes?.clearGatewaySessionRoute?.(previousId);
        mgr.closeSession(previousId, 'cli-resume');
      }
      session = resumed;
      route = resolveRoute(config, { provider: resumed.provider, model: resumed.model });
      statusRoutes?.writeGatewaySessionRoute?.(session.id, routeForStatusline(route));
      return {
        id: resumed.id,
        messages: resumed.messages || [],
        provider: resumed.provider,
        model: resumed.model,
      };
    },
  };
}
