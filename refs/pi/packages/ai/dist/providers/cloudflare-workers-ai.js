import { openAICompletionsApi } from "../api/openai-completions.lazy.js";
import { envApiKeyAuth } from "../auth/helpers.js";
import { createProvider } from "../models.js";
import { CLOUDFLARE_WORKERS_AI_MODELS } from "./cloudflare-workers-ai.models.js";
export function cloudflareWorkersAIProvider() {
    return createProvider({
        id: "cloudflare-workers-ai",
        name: "Cloudflare Workers AI",
        auth: { apiKey: envApiKeyAuth("Cloudflare API key", ["CLOUDFLARE_API_KEY"]) },
        models: Object.values(CLOUDFLARE_WORKERS_AI_MODELS),
        api: openAICompletionsApi(),
    });
}
//# sourceMappingURL=cloudflare-workers-ai.js.map