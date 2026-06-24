import { AnthropicProvider } from './anthropic.mjs';
import { OpenAICompatProvider, OPENAI_COMPAT_PRESETS } from './openai-compat.mjs';

// OpenCode Go publishes both OpenAI-compatible and Anthropic-compatible
// endpoints. Route by model family so the CLI matches the official surface
// instead of forcing every model through /chat/completions.
const ANTHROPIC_MODEL_PREFIXES = [
    'minimax-',
    'qwen',
];

function isAnthropicGoModel(model) {
    const id = String(model || '').toLowerCase();
    return ANTHROPIC_MODEL_PREFIXES.some(prefix => id.startsWith(prefix));
}

export class OpenCodeGoProvider {
    static inputExcludesCache = false;
    name = 'opencode-go';
    openai;
    anthropic;

    constructor(config = {}) {
        const preset = OPENAI_COMPAT_PRESETS['opencode-go'];
        const baseURL = config.baseURL || preset.baseURL;
        this.openai = new OpenAICompatProvider('opencode-go', { ...config, baseURL });
        this.anthropic = new AnthropicProvider({
            ...config,
            name: 'opencode-go',
            baseURL,
            disableBetaHeaders: true,
        });
    }

    async send(messages, model, tools, sendOpts) {
        if (isAnthropicGoModel(model)) {
            return this.anthropic.send(messages, model, tools, {
                ...(sendOpts || {}),
                cacheStrategy: {
                    tools: 'none',
                    system: 'none',
                    tier3: 'none',
                    messages: 'none',
                },
            });
        }
        return this.openai.send(messages, model, tools, sendOpts);
    }

    async listModels() {
        return this.openai.listModels();
    }
}
