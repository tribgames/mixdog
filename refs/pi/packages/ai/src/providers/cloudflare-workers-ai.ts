import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { CLOUDFLARE_WORKERS_AI_MODELS } from "./cloudflare-workers-ai.models.ts";

export function cloudflareWorkersAIProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "cloudflare-workers-ai",
		name: "Cloudflare Workers AI",
		auth: { apiKey: envApiKeyAuth("Cloudflare API key", ["CLOUDFLARE_API_KEY"]) },
		models: Object.values(CLOUDFLARE_WORKERS_AI_MODELS),
		api: openAICompletionsApi(),
	});
}
