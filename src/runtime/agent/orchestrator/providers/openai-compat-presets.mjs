// Lightweight preset table shared by config/registry without importing the
// OpenAI SDK or compat runtime implementation.
export const OPENAI_COMPAT_PRESETS = {
    deepseek: {
        baseURL: 'https://api.deepseek.com',
        defaultModel: 'deepseek-v4-pro',
    },
    xai: {
        baseURL: 'https://api.x.ai/v1',
        defaultModel: 'grok-4.3',
    },
    // OpenCode Go - low-cost coding-model subscription gateway.
    'opencode-go': {
        baseURL: 'https://opencode.ai/zen/go/v1',
        defaultModel: 'glm-5.2',
    },
    ollama: {
        baseURL: 'http://localhost:11434/v1',
        defaultModel: 'llama3.3:latest',
    },
    lmstudio: {
        baseURL: 'http://localhost:1234/v1',
        defaultModel: 'default',
    },
};
