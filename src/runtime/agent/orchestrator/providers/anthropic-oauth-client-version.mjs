import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { updateJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';

// Anthropic validates the Claude Code client identity carried by OAuth
// requests. This floor ships with Mixdog, while a newer server-advertised
// minimum is learned and persisted so future model launches do not require a
// source release just to advance the user-agent version.
export const DEFAULT_CLI_VERSION = '2.1.251';

const CACHE_SCHEMA_VERSION = 1;
const CACHE_FILE_NAME = 'anthropic-oauth-cli-version.json';
const VERSION_GATE_PATTERN = /Claude Code\s+(\d{1,4}\.\d{1,4}\.\d{1,6})\s+does not support this model;\s*version\s+(\d{1,4}\.\d{1,4}\.\d{1,6})\s+or newer is required\b/i;

let learnedCliVersion = null;
let learnedCliVersionLoaded = false;

function parseCliVersion(value) {
    const match = String(value || '').trim().match(/^(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/);
    if (!match) return null;
    const parts = match.slice(1).map(Number);
    if (parts.some((part) => !Number.isSafeInteger(part) || part < 0)) return null;
    return { text: parts.join('.'), parts };
}

function compareCliVersions(left, right) {
    const a = parseCliVersion(left);
    const b = parseCliVersion(right);
    if (!a || !b) return 0;
    for (let index = 0; index < 3; index += 1) {
        if (a.parts[index] !== b.parts[index]) return a.parts[index] - b.parts[index];
    }
    return 0;
}

function cliVersionCachePath() {
    return join(resolvePluginData(), CACHE_FILE_NAME);
}

function loadLearnedCliVersion() {
    if (learnedCliVersionLoaded) return learnedCliVersion;
    learnedCliVersionLoaded = true;
    try {
        const path = cliVersionCachePath();
        if (!existsSync(path)) return null;
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (raw?.version !== CACHE_SCHEMA_VERSION) return null;
        const parsed = parseCliVersion(raw?.cliVersion);
        if (!parsed || compareCliVersions(parsed.text, DEFAULT_CLI_VERSION) < 0) return null;
        learnedCliVersion = parsed.text;
    } catch {
        learnedCliVersion = null;
    }
    return learnedCliVersion;
}

function persistLearnedCliVersion(cliVersion) {
    try {
        const persisted = updateJsonAtomicSync(cliVersionCachePath(), (current) => {
            const currentVersion = current?.version === CACHE_SCHEMA_VERSION
                ? parseCliVersion(current?.cliVersion)
                : null;
            if (currentVersion && compareCliVersions(currentVersion.text, cliVersion) >= 0) {
                return undefined;
            }
            return {
                version: CACHE_SCHEMA_VERSION,
                cliVersion,
                updatedAt: Date.now(),
            };
        }, { lock: true, fsyncDir: true });
        return parseCliVersion(persisted?.cliVersion)?.text || cliVersion;
    } catch {
        // Runtime learning still fixes the active process. Persistence remains
        // best-effort so a read-only data directory cannot break inference.
        return cliVersion;
    }
}

export function resolveCliVersion() {
    const explicit = String(process.env.MIXDOG_CLI_VERSION || '').trim();
    if (explicit) return explicit;
    return loadLearnedCliVersion() || DEFAULT_CLI_VERSION;
}

/**
 * Learn Anthropic's exact minimum-version rejection. Returns null for every
 * other response shape. Learned versions only move upward and are persisted
 * atomically; an explicit MIXDOG_CLI_VERSION remains authoritative.
 */
export function learnRequiredCliVersion(errorText) {
    const match = String(errorText || '').match(VERSION_GATE_PATTERN);
    const required = parseCliVersion(match?.[2]);
    if (!required) return null;

    const currentFloor = loadLearnedCliVersion() || DEFAULT_CLI_VERSION;
    const updated = compareCliVersions(required.text, currentFloor) > 0;
    if (updated) {
        learnedCliVersion = persistLearnedCliVersion(required.text);
        learnedCliVersionLoaded = true;
    }

    const explicit = String(process.env.MIXDOG_CLI_VERSION || '').trim();
    return {
        requiredVersion: required.text,
        activeVersion: explicit || learnedCliVersion || DEFAULT_CLI_VERSION,
        updated,
        retryable: !explicit,
    };
}
