import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';

const ANTHROPIC_DEFAULT_CREDENTIALS_PATH = join(resolvePluginData(), 'anthropic-oauth-credentials.json');

function readJsonIfExists(path) {
    if (!path || !existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, 'utf-8')); }
    catch { return null; }
}

function pushUnique(list, value) {
    if (!value || typeof value !== 'string') return;
    if (!list.includes(value)) list.push(value);
}

export function hasAnthropicOAuthCredentials() {
    const paths = [];
    pushUnique(paths, process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH);
    pushUnique(paths, ANTHROPIC_DEFAULT_CREDENTIALS_PATH);
    for (const path of paths) {
        const raw = readJsonIfExists(path);
        const oauth = raw?.claudeAiOauth;
        if (oauth?.accessToken && Array.isArray(oauth.scopes) && oauth.scopes.includes('user:inference')) {
            return true;
        }
    }
    return false;
}

export function hasOpenAIOAuthCredentials() {
    const paths = [join(resolvePluginData(), 'openai-oauth.json')];
    for (const path of paths) {
        const raw = readJsonIfExists(path);
        const tokens = raw?.tokens || raw;
        if (tokens?.access_token && tokens?.refresh_token) return true;
    }
    return false;
}

export function hasGrokOAuthCredentials() {
    const own = readJsonIfExists(join(resolvePluginData(), 'grok-oauth.json'));
    return !!(own?.access_token && own?.refresh_token);
}
