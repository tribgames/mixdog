import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';

const ANTHROPIC_DEFAULT_CREDENTIALS_PATH = join(resolvePluginData(), 'anthropic-oauth-credentials.json');
const CLAUDE_CODE_CREDENTIALS_PATH = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json');
const GROK_ISSUER = 'https://auth.x.ai';
const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

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
    pushUnique(paths, CLAUDE_CODE_CREDENTIALS_PATH);
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
    const paths = [
        join(resolvePluginData(), 'openai-oauth.json'),
        join(homedir(), '.codex', 'auth.json'),
    ];
    for (const path of paths) {
        const raw = readJsonIfExists(path);
        const tokens = raw?.tokens || raw;
        if (tokens?.access_token && tokens?.refresh_token) return true;
    }
    return false;
}

export function hasGrokOAuthCredentials() {
    const own = readJsonIfExists(join(resolvePluginData(), 'grok-oauth.json'));
    if (own?.access_token && own?.refresh_token) return true;
    const cli = readJsonIfExists(join(homedir(), '.grok', 'auth.json'));
    const entry = cli?.[`${GROK_ISSUER}::${GROK_CLIENT_ID}`];
    return !!(entry?.key && entry?.refresh_token);
}
