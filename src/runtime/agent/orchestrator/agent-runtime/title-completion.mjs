import { loadConfig } from '../config.mjs';
import { getProvider, initProviders } from '../providers/registry.mjs';
import { resolveMaintenanceRoute } from './maintenance-route.mjs';

export const TITLE_SYSTEM_PROMPT = "Create a concise session title from the provided message or conversation. Output only one title on one line, at most 32 characters; no quotes, markdown, or trailing period.";

export function titleSystemPrompt(locale = '') {
    const systemLocale = String(locale || '').trim();
    return systemLocale
        ? `${TITLE_SYSTEM_PROMPT} System language/locale: ${systemLocale}. Prefer that language when the source is ambiguous; preserve a clearly different source language.`
        : TITLE_SYSTEM_PROMPT;
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

export function createTitleCompletion(deps = {}) {
    const load = deps.loadConfig || loadConfig;
    const resolveRoute = deps.resolveMaintenanceRoute || resolveMaintenanceRoute;
    const initialize = deps.initProviders || initProviders;
    const providerFor = deps.getProvider || getProvider;

    return async function generateSessionTitle(source, options = {}) {
        const text = String(source || '').trim();
        if (!text) return '';
        const signal = options.signal || null;
        const config = load();
        const route = resolveRoute({
            agent: 'title-agent',
            config,
        });
        if (!route || typeof route !== 'object') {
            throw new Error('Session title maintenance route is unresolved.');
        }
        const providerName = String(route.provider || '').trim();
        const model = String(route.model || '').trim();
        if (!providerName || !model) {
            throw new Error('Session title maintenance route requires provider and model.');
        }
        await initialize(config.providers || {}, { signal });
        const provider = providerFor(providerName);
        if (!provider || typeof provider.send !== 'function') {
            throw new Error(`Session title provider is unavailable: ${providerName}`);
        }
        const response = await provider.send([
            { role: 'system', content: titleSystemPrompt(options.locale) },
            { role: 'user', content: text },
        ], model, undefined, {
            signal,
            effort: String(route.effort || '').trim() || 'low',
            fast: route.fast === true,
            maxOutputTokens: 128,
        });
        return resultText(response).trim();
    };
}

export const generateSessionTitle = createTitleCompletion();
