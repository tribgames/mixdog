/**
 * model-switch-target.mjs — what a user's model selection names, and whether
 * it switches an established conversation to another model. Shared by every
 * surface that offers the choice (session API routes, plain REPL /model).
 */

/** The provider/model a selection names; a bare preset id or name names the
 *  preset's model. */
export function selectedModel(runtime, request, sessionProvider, sessionModel) {
  const model = String(request?.model ?? '').trim();
  if (!request?.provider && model) {
    const wanted = model.toLowerCase();
    const presets = runtime?.listPresets?.();
    const preset = (Array.isArray(presets) ? presets : []).find((entry) =>
      [entry?.id, entry?.name].some(
        (key) =>
          String(key ?? '')
            .trim()
            .toLowerCase() === wanted
      )
    );
    if (preset?.provider && preset?.model) return { provider: String(preset.provider), model: String(preset.model) };
  }
  return { provider: String(request?.provider ?? sessionProvider), model: model || sessionModel };
}

/** A selection of another model than the established conversation's own. */
export function switchesSessionModel(runtime, request) {
  const sessionProvider = String(runtime?.sessionProvider ?? '');
  const sessionModel = String(runtime?.sessionModel ?? '');
  if (!sessionProvider || !sessionModel) return false;
  const { provider, model } = selectedModel(runtime, request, sessionProvider, sessionModel);
  return provider !== sessionProvider || model !== sessionModel;
}
