#!/usr/bin/env node
import { resolve } from 'node:path';
import {
    _scrubTokens,
    preflightAnthropicOAuthCredentials,
} from '../../../src/runtime/agent/orchestrator/providers/anthropic-oauth-credentials.mjs';

function valueAfter(flag) {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : null;
}

const output = valueAfter('--output');
const minimumValidityMs = Number(valueAfter('--minimum-validity-ms'));
const credentialsPath = process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH;

if (!output || !credentialsPath || !Number.isFinite(minimumValidityMs) || minimumValidityMs < 0) {
    process.stderr.write(
        'usage: anthropic_oauth_preflight.mjs --output <snapshot> '
        + '--minimum-validity-ms <milliseconds>\n',
    );
    process.exitCode = 2;
} else {
    try {
        const result = await preflightAnthropicOAuthCredentials({
            credentialsPath,
            minimumValidityMs,
            snapshotPath: resolve(output),
        });
        process.stdout.write(
            `Anthropic OAuth host preflight ready (${Math.floor(result.remainingMs / 1000)}s lease).\n`,
        );
    } catch (error) {
        const message = _scrubTokens(error?.message || String(error)).slice(0, 500);
        process.stderr.write(`Anthropic OAuth host preflight failed: ${message}\n`);
        process.exitCode = 1;
    }
}
