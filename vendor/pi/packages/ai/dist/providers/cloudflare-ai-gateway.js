import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.js";
import { openAICompletionsApi } from "../api/openai-completions.lazy.js";
import { openAIResponsesApi } from "../api/openai-responses.lazy.js";
import { envApiKeyAuth } from "../auth/helpers.js";
import { createProvider } from "../models.js";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "./cloudflare-ai-gateway.models.js";
export function cloudflareAIGatewayProvider() {
    return createProvider({
        id: "cloudflare-ai-gateway",
        name: "Cloudflare AI Gateway",
        auth: { apiKey: envApiKeyAuth("Cloudflare API key", ["CLOUDFLARE_API_KEY"]) },
        models: Object.values(CLOUDFLARE_AI_GATEWAY_MODELS),
        api: {
            "anthropic-messages": anthropicMessagesApi(),
            "openai-completions": openAICompletionsApi(),
            "openai-responses": openAIResponsesApi(),
        },
    });
}
//# sourceMappingURL=cloudflare-ai-gateway.js.map