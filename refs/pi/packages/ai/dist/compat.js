/**
 * Temporary compatibility entrypoint preserving the old global pi-ai API
 * surface: api-dispatch `stream()`/`complete()` with env API key injection,
 * the api-registry, generated catalog reads (`getModel`/`getModels`/
 * `getProviders`), per-API lazy stream wrappers, and image generation.
 *
 * Existing apps switch imports from "@earendil-works/pi-ai" to
 * "@earendil-works/pi-ai/compat" unchanged; new code uses `createModels()`
 * and the provider factories. This module is deleted with the coding-agent
 * ModelManager migration.
 */
export * from "./api/anthropic-messages.lazy.js";
export * from "./api/azure-openai-responses.lazy.js";
export * from "./api/bedrock-converse-stream.lazy.js";
export * from "./api/google-generative-ai.lazy.js";
export * from "./api/google-vertex.lazy.js";
export * from "./api/mistral-conversations.lazy.js";
export * from "./api/openai-codex-responses.lazy.js";
export * from "./api/openai-completions.lazy.js";
export * from "./api/openai-responses.lazy.js";
export * from "./api-registry.js";
export * from "./env-api-keys.js";
export * from "./image-models.js";
export * from "./images.js";
export * from "./images-api-registry.js";
export * from "./index.js";
export * from "./providers/images/register-builtins.js";
import { anthropicMessagesApi } from "./api/anthropic-messages.lazy.js";
import { azureOpenAIResponsesApi } from "./api/azure-openai-responses.lazy.js";
import { bedrockConverseStreamApi } from "./api/bedrock-converse-stream.lazy.js";
import { googleGenerativeAIApi } from "./api/google-generative-ai.lazy.js";
import { googleVertexApi } from "./api/google-vertex.lazy.js";
import { mistralConversationsApi } from "./api/mistral-conversations.lazy.js";
import { openAICodexResponsesApi } from "./api/openai-codex-responses.lazy.js";
import { openAICompletionsApi } from "./api/openai-completions.lazy.js";
import { openAIResponsesApi } from "./api/openai-responses.lazy.js";
import { clearApiProviders, getApiProvider, registerApiProvider } from "./api-registry.js";
import { getEnvApiKey } from "./env-api-keys.js";
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "./providers/all.js";
/** @deprecated Static catalog read. Use `getBuiltinModel` from "@earendil-works/pi-ai/providers/all" or `Models.getModel()`. */
export const getModel = getBuiltinModel;
/** @deprecated Static catalog read. Use `getBuiltinModels` from "@earendil-works/pi-ai/providers/all" or `Models.getModels()`. */
export const getModels = getBuiltinModels;
/** @deprecated Static catalog read. Use `getBuiltinProviders` from "@earendil-works/pi-ai/providers/all" or `Models.getProviders()`. */
export const getProviders = getBuiltinProviders;
const BUILTIN_APIS = [
    ["anthropic-messages", anthropicMessagesApi()],
    ["openai-completions", openAICompletionsApi()],
    ["openai-responses", openAIResponsesApi()],
    ["openai-codex-responses", openAICodexResponsesApi()],
    ["azure-openai-responses", azureOpenAIResponsesApi()],
    ["google-generative-ai", googleGenerativeAIApi()],
    ["google-vertex", googleVertexApi()],
    ["mistral-conversations", mistralConversationsApi()],
    ["bedrock-converse-stream", bedrockConverseStreamApi()],
];
/**
 * Registers the builtin API implementations into the api-registry without
 * clobbering existing entries: compat may load after a test or extension has
 * already registered an override for a builtin api id.
 */
export function registerBuiltInApiProviders() {
    for (const [api, streams] of BUILTIN_APIS) {
        if (getApiProvider(api))
            continue;
        registerApiProvider({ api, stream: streams.stream, streamSimple: streams.streamSimple });
    }
}
export function resetApiProviders() {
    clearApiProviders();
    registerBuiltInApiProviders();
}
registerBuiltInApiProviders();
function hasExplicitApiKey(apiKey) {
    return typeof apiKey === "string" && apiKey.trim().length > 0;
}
function withEnvApiKey(model, options) {
    if (hasExplicitApiKey(options?.apiKey))
        return options;
    const apiKey = getEnvApiKey(model.provider);
    if (!apiKey)
        return options;
    return { ...options, apiKey };
}
function resolveApiProvider(api) {
    const provider = getApiProvider(api);
    if (!provider) {
        throw new Error(`No API provider registered for api: ${api}`);
    }
    return provider;
}
export function stream(model, context, options) {
    const provider = resolveApiProvider(model.api);
    return provider.stream(model, context, withEnvApiKey(model, options));
}
export async function complete(model, context, options) {
    const s = stream(model, context, options);
    return s.result();
}
export function streamSimple(model, context, options) {
    const provider = resolveApiProvider(model.api);
    return provider.streamSimple(model, context, withEnvApiKey(model, options));
}
export async function completeSimple(model, context, options) {
    const s = streamSimple(model, context, options);
    return s.result();
}
//# sourceMappingURL=compat.js.map