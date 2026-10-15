/**
 * OpenRouter: one API key, three wires. Claude (`anthropic/*`, `~anthropic/*`)
 * goes through the Anthropic Messages engine at https://openrouter.ai/api (the
 * SDK appends /v1/messages); OpenAI GPT / o-series (`openai/gpt-*`,
 * `openai/o*`, `~openai/*`) through the OpenAI-compatible engine's Responses
 * wire; openrouter/auto and every other model through Chat Completions.
 * Account-level provider-routing preferences stay OpenRouter's: no request
 * names a provider order.
 */
import { WireGatewayProvider, messagesBaseFromOpenAIBase } from './wire-gateway.mjs';
import { OPENAI_COMPAT_PRESETS } from './openai-compat-presets.mjs';
import { openRouterReasoning } from './openai-compat-options.mjs';

/**
 * The Claude id a routing slug stands for: an alias (`~anthropic/claude-opus-latest`)
 * reads its catalog `alias_target`, the vendor prefix and a `:variant` suffix
 * drop. Capability lookup only — the request still names the routing slug.
 */
export function openRouterCapabilityModel(model, aliasTarget = null) {
  return String(aliasTarget || model || '')
    .replace(/^~/, '')
    .replace(/^anthropic\//i, '')
    .replace(/:[^/]*$/, '');
}

// Responses requests carry the same reasoning control as Chat requests
// (`openRouterReasoningEffort`, else the turn effort, else the configured
// effort; `none` disables reasoning).
function openRouterResponsesParams(config) {
  return (params, { opts }) => {
    const reasoning = openRouterReasoning(opts, config);
    if (reasoning) params.reasoning = reasoning;
    else delete params.reasoning;
  };
}

// The Messages route takes the same control: the effort to send ('none' = no
// thinking), or null to keep the engine's own handling.
function openRouterMessagesEffort(config) {
  return (opts) => {
    const reasoning = openRouterReasoning(opts, config);
    if (!reasoning) return null;
    return reasoning.enabled === false ? 'none' : reasoning.effort;
  };
}

/** A roster row carrying `top_provider.max_completion_tokens` as its output ceiling. */
export function withTopProviderOutputCeiling(item) {
  const ceiling = Number(item?.top_provider?.max_completion_tokens);
  if (!(ceiling > 0) || item.max_output_tokens !== undefined) return item;
  return { ...item, max_output_tokens: ceiling };
}

export class OpenRouterProvider extends WireGatewayProvider {
  constructor(config = {}) {
    const baseURL = config.baseURL || OPENAI_COMPAT_PRESETS.openrouter.baseURL;
    super(
      'openrouter',
      config,
      {
        baseURL: messagesBaseFromOpenAIBase(baseURL),
        authScheme: 'bearer',
        // OpenRouter Messages takes PDFs natively as document blocks.
        nativePdf: true,
        messagesEffort: openRouterMessagesEffort(config),
        capabilityModel: (model) => openRouterCapabilityModel(model, this.getCachedModelInfo(model)?.aliasTarget),
      },
      { responsesParamsHook: openRouterResponsesParams(config) }
    );
    // The roster's output ceiling is `top_provider.max_completion_tokens`.
    const fetchItems = this.openai._fetchModelItems.bind(this.openai);
    this.openai._fetchModelItems = async (options) =>
      (await fetchItems(options)).map(withTopProviderOutputCeiling);
  }
}
