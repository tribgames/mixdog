import { loadConfig } from '../config.mjs';
import { getProvider, initProviders } from '../providers/registry.mjs';
import { resolveMaintenanceRoute } from './maintenance-route.mjs';

export const COMMIT_MESSAGE_SYSTEM_PROMPT = 'You are generating one git commit message from the provided diff. First line: imperative mood, at most 72 characters, no trailing period. Optionally add a blank line and a short body (wrapped at 72 characters) explaining WHY. Output ONLY the commit message - no preamble, no code fences, no quotes.';

export function commitMessageSystemPrompt(style = '') {
    const hint = String(style || '').trim();
    return hint ? `${COMMIT_MESSAGE_SYSTEM_PROMPT}\n${hint}` : COMMIT_MESSAGE_SYSTEM_PROMPT;
}

function resultText(result) {
    if (typeof result === 'string') return result;
    if (typeof result?.content === 'string') return result.content;
    if (Array.isArray(result?.content)) {
        return result.content
            .map((part) => part?.type === 'text' ? String(part.text || '') : '')
            .filter(Boolean)
            .join('\n');
    }
    return '';
}

export function createCommitMessageCompletion(deps = {}) {
    const load = deps.loadConfig || loadConfig;
    const resolveRoute = deps.resolveMaintenanceRoute || resolveMaintenanceRoute;
    const initialize = deps.initProviders || initProviders;
    const providerFor = deps.getProvider || getProvider;

    return async function generateCommitMessage(source, options = {}) {
        const text = String(source || '').trim();
        if (!text) return '';
        const signal = options.signal || null;
        const config = load();
        // Commit messages are maintenance-class work: they ride the same
        // route as session titles instead of the main conversation model.
        const route = resolveRoute({
            agent: 'title-agent',
            config,
        });
        if (!route || typeof route !== 'object') {
            throw new Error('Commit message maintenance route is unresolved.');
        }
        const providerName = String(route.provider || '').trim();
        const model = String(route.model || '').trim();
        if (!providerName || !model) {
            throw new Error('Commit message maintenance route requires provider and model.');
        }
        await initialize(config.providers || {}, { signal });
        const provider = providerFor(providerName);
        if (!provider || typeof provider.send !== 'function') {
            throw new Error(`Commit message provider is unavailable: ${providerName}`);
        }
        const response = await provider.send([
            { role: 'system', content: commitMessageSystemPrompt(options.style) },
            { role: 'user', content: text },
        ], model, undefined, {
            signal,
            effort: String(route.effort || '').trim() || 'low',
            fast: route.fast === true,
            maxOutputTokens: 400,
        });
        return resultText(response).trim();
    };
}

export const generateCommitMessage = createCommitMessageCompletion();
