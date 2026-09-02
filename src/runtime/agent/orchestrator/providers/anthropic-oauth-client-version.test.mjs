import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

test('Claude CLI compatibility floors validate, persist, and never downgrade', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-anthropic-cli-version-'));
    const previousDataDir = process.env.MIXDOG_DATA_DIR;
    const previousOverride = process.env.MIXDOG_CLI_VERSION;
    try {
        process.env.MIXDOG_DATA_DIR = dataDir;
        delete process.env.MIXDOG_CLI_VERSION;
        const nonce = `${process.pid}-${Date.now()}`;
        const versions = await import(`./anthropic-oauth-client-version.mjs?floor=${nonce}`);

        assert.equal(versions.resolveCliVersion(), '2.1.251');
        assert.equal(versions.learnRequiredCliVersion('generic invalid request'), null);

        const learned = versions.learnRequiredCliVersion(
            'Claude Code 2.1.251 does not support this model; version 2.1.300 or newer is required.',
        );
        assert.deepEqual(learned, {
            requiredVersion: '2.1.300',
            activeVersion: '2.1.300',
            updated: true,
            retryable: true,
        });
        assert.equal(versions.resolveCliVersion(), '2.1.300');

        const persisted = JSON.parse(await readFile(
            join(dataDir, 'anthropic-oauth-cli-version.json'),
            'utf-8',
        ));
        assert.equal(persisted.cliVersion, '2.1.300');

        const reloaded = await import(`./anthropic-oauth-client-version.mjs?reload=${nonce}`);
        assert.equal(reloaded.resolveCliVersion(), '2.1.300');

        await writeFile(
            join(dataDir, 'anthropic-oauth-cli-version.json'),
            JSON.stringify({ version: 1, cliVersion: '2.1.500', updatedAt: Date.now() }),
        );
        const concurrentRaise = versions.learnRequiredCliVersion(
            'Claude Code 2.1.300 does not support this model; version 2.1.400 or newer is required.',
        );
        assert.equal(concurrentRaise.activeVersion, '2.1.500');

        process.env.MIXDOG_CLI_VERSION = '9.9.9';
        const overridden = reloaded.learnRequiredCliVersion(
            'Claude Code 2.1.500 does not support this model; version 2.1.600 or newer is required.',
        );
        assert.equal(overridden.retryable, false);
        assert.equal(reloaded.resolveCliVersion(), '9.9.9');

        delete process.env.MIXDOG_CLI_VERSION;
        assert.equal(reloaded.resolveCliVersion(), '2.1.600');
        const downgrade = reloaded.learnRequiredCliVersion(
            'Claude Code 2.1.600 does not support this model; version 2.1.251 or newer is required.',
        );
        assert.equal(downgrade.updated, false);
        assert.equal(reloaded.resolveCliVersion(), '2.1.600');
    } finally {
        restoreEnv('MIXDOG_DATA_DIR', previousDataDir);
        restoreEnv('MIXDOG_CLI_VERSION', previousOverride);
        await rm(dataDir, { recursive: true, force: true });
    }
});

test('Anthropic OAuth retries the exact version gate once and leaves generic 400s terminal', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-anthropic-cli-retry-'));
    const previousDataDir = process.env.MIXDOG_DATA_DIR;
    const previousOverride = process.env.MIXDOG_CLI_VERSION;
    const previousProxy = process.env.HTTPS_PROXY;
    try {
        process.env.MIXDOG_DATA_DIR = dataDir;
        process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
        delete process.env.MIXDOG_CLI_VERSION;
        const nonce = `${process.pid}-${Date.now()}`;
        const { AnthropicOAuthProvider } = await import(`./anthropic-oauth.mjs?retry=${nonce}`);
        const { resolveCliVersion } = await import('./anthropic-oauth-client-version.mjs');

        const provider = Object.create(AnthropicOAuthProvider.prototype);
        provider.config = {};
        provider.fastModeBetaHeaderLatched = false;
        provider.ensureAuth = async () => ({ accessToken: 'test-access-token' });
        provider.scrubTokens = (text) => String(text || '');
        provider._refreshModelCache = async () => [];

        const requestVersions = [];
        const response = (status, text = '') => ({
            status,
            ok: status >= 200 && status < 300,
            headers: new Headers(),
            text: async () => text,
        });
        const requestResult = (status, text = '') => {
            const controller = new AbortController();
            return {
                response: response(status, text),
                controller,
                cancelHandler: null,
            };
        };
        const parseSuccess = async (...args) => {
            args[5].sawMessageStart = true;
            return {
                content: 'ok',
                model: 'claude-fable-5-1',
                toolCalls: [],
                usage: { inputTokens: 1, outputTokens: 1 },
            };
        };

        const result = await provider.send(
            [{ role: 'user', content: 'hello' }],
            'claude-fable-5-1',
            [],
            {
                _doRequestFn: async () => {
                    requestVersions.push(resolveCliVersion());
                    if (requestVersions.length === 1) {
                        return requestResult(
                            400,
                            'Claude Code 2.1.251 does not support this model; version 2.1.400 or newer is required.',
                        );
                    }
                    return requestResult(200);
                },
                _parseSSEFn: parseSuccess,
            },
        );
        assert.equal(result.content, 'ok');
        assert.deepEqual(requestVersions, ['2.1.251', '2.1.400']);

        let genericAttempts = 0;
        await assert.rejects(
            provider.send(
                [{ role: 'user', content: 'hello again' }],
                'claude-fable-5-1',
                [],
                {
                    _doRequestFn: async () => {
                        genericAttempts += 1;
                        return requestResult(400, 'generic invalid request');
                    },
                    _parseSSEFn: parseSuccess,
                },
            ),
            /generic invalid request/,
        );
        assert.equal(genericAttempts, 1);
    } finally {
        restoreEnv('MIXDOG_DATA_DIR', previousDataDir);
        restoreEnv('MIXDOG_CLI_VERSION', previousOverride);
        restoreEnv('HTTPS_PROXY', previousProxy);
        await rm(dataDir, { recursive: true, force: true });
    }
});
