import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'mixdog-anthropic-race-'));
const credentialsPath = join(root, 'anthropic-oauth-credentials.json');
process.env.MIXDOG_DATA_DIR = root;
process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH = credentialsPath;

const credentialsModule = await import(
    '../src/runtime/agent/orchestrator/providers/anthropic-oauth-credentials.mjs'
);
const { AnthropicOAuthProvider } = await import(
    '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs'
);
const {
    _saveCredentialsFile,
    loadCredentials,
    loadCredentialsFromPath,
    preflightAnthropicOAuthCredentials,
    refreshOAuthCredentials,
} = credentialsModule;

after(() => {
    delete process.env.MIXDOG_ANTHROPIC_OAUTH_REFRESH_DISABLED;
    rmSync(root, { recursive: true, force: true });
});

function writeCredentials({ accessToken, refreshToken, expiresAt }, path = credentialsPath) {
    _saveCredentialsFile(path, {
        claudeAiOauth: {
            accessToken,
            refreshToken,
            expiresAt,
            scopes: ['user:inference'],
        },
    });
}

test('parallel host preflights refresh once and snapshot the leased generation', async () => {
    writeCredentials({
        accessToken: 'fixture-access-old',
        refreshToken: 'fixture-refresh-old',
        expiresAt: Date.now() + 1_000,
    });
    let refreshCalls = 0;
    const refreshFn = async (current) => {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        const raw = JSON.parse(readFileSync(current.path, 'utf8'));
        raw.claudeAiOauth.accessToken = 'fixture-access-new';
        raw.claudeAiOauth.refreshToken = 'fixture-refresh-new';
        raw.claudeAiOauth.expiresAt = Date.now() + 10 * 60_000;
        _saveCredentialsFile(current.path, raw);
        return loadCredentials();
    };

    const snapshots = Array.from(
        { length: 12 },
        (_, index) => join(root, `container-${index}.json`),
    );
    await Promise.all(snapshots.map((snapshotPath) => (
        preflightAnthropicOAuthCredentials({
            minimumValidityMs: 5 * 60_000,
            snapshotPath,
            refreshFn,
        })
    )));

    assert.equal(refreshCalls, 1);
    for (const snapshotPath of snapshots) {
        const oauth = JSON.parse(readFileSync(snapshotPath, 'utf8')).claudeAiOauth;
        assert.equal(oauth.accessToken, 'fixture-access-new');
        assert.equal(Object.hasOwn(oauth, 'refreshToken'), false);
        assert.equal(Object.hasOwn(oauth, 'refresh_token'), false);
    }
});

test('explicit credential path is pinned over a newer default candidate', async () => {
    const explicitPath = join(root, 'explicit', 'credentials.json');
    mkdirSync(join(root, 'explicit'), { recursive: true });
    writeCredentials({
        accessToken: 'fixture-default-newer',
        refreshToken: 'fixture-default-refresh',
        expiresAt: Date.now() + 60 * 60_000,
    });
    writeCredentials({
        accessToken: 'fixture-explicit',
        refreshToken: 'fixture-explicit-refresh',
        expiresAt: Date.now() + 20 * 60_000,
    }, explicitPath);
    process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH = explicitPath;
    const snapshotPath = join(root, 'explicit-snapshot.json');
    try {
        assert.equal(loadCredentials().path, explicitPath);
        assert.equal(loadCredentials().accessToken, 'fixture-explicit');
        await preflightAnthropicOAuthCredentials({
            credentialsPath: explicitPath,
            minimumValidityMs: 5 * 60_000,
            snapshotPath,
        });
        const snapshot = loadCredentialsFromPath(snapshotPath);
        assert.equal(snapshot.accessToken, 'fixture-explicit');
        assert.equal(snapshot.refreshToken, null);
        assert.equal(
            loadCredentialsFromPath(credentialsPath).accessToken,
            'fixture-default-newer',
        );
    } finally {
        process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH = credentialsPath;
    }
});

test('10 contending host processes share one token exchange lock', async () => {
    const processCredentials = join(root, 'process-credentials.json');
    const exchangeDir = join(root, 'exchange-owners');
    const startPath = join(root, 'children-start');
    const readyDir = join(root, 'children-ready');
    const snapshotDir = join(root, 'child-snapshots');
    mkdirSync(readyDir);
    mkdirSync(snapshotDir);
    mkdirSync(exchangeDir);
    writeCredentials({
        accessToken: 'fixture-process-old',
        refreshToken: 'fixture-process-refresh-old',
        expiresAt: Date.now() + 1_000,
    }, processCredentials);

    const moduleUrl = new URL(
        '../src/runtime/agent/orchestrator/providers/anthropic-oauth-credentials.mjs',
        import.meta.url,
    ).href;
    const childSource = `
import { existsSync, writeFileSync } from 'node:fs';
const mod = await import(${JSON.stringify(moduleUrl)});
const stale = mod.loadCredentials();
writeFileSync(process.env.READY_PATH, 'ready');
while (!existsSync(process.env.START_PATH)) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
globalThis.fetch = async () => {
  const owner = String(process.pid);
  writeFileSync(process.env.EXCHANGE_DIR + '/' + owner + '.exchange', owner, { flag: 'wx' });
  await new Promise((resolve) => setTimeout(resolve, 75));
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        access_token: 'fixture-process-new-' + owner,
        refresh_token: 'fixture-process-refresh-new-' + owner,
        expires_in: 600
      });
    }
  };
};
if (process.env.CHILD_MODE === 'preflight') {
  await mod.preflightAnthropicOAuthCredentials({
    credentialsPath: process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH,
    minimumValidityMs: 300000,
    snapshotPath: process.env.SNAPSHOT_PATH
  });
} else {
  await mod.refreshOAuthCredentials(stale);
}
`;

    const exits = [];
    for (let index = 0; index < 10; index += 1) {
        const child = spawn(
            process.execPath,
            ['--input-type=module', '--eval', childSource],
            {
                env: {
                    ...process.env,
                    MIXDOG_DATA_DIR: root,
                    ANTHROPIC_OAUTH_CREDENTIALS_PATH: processCredentials,
                    READY_PATH: join(readyDir, String(index)),
                    START_PATH: startPath,
                    EXCHANGE_DIR: exchangeDir,
                    CHILD_MODE: index % 2 === 0 ? 'preflight' : 'refresh',
                    SNAPSHOT_PATH: join(snapshotDir, `${index}.json`),
                },
                stdio: ['ignore', 'ignore', 'pipe'],
            },
        );
        exits.push(new Promise((resolveExit, rejectExit) => {
            let stderr = '';
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            child.on('error', rejectExit);
            child.on('exit', (code) => {
                if (code === 0) resolveExit();
                else rejectExit(new Error(`contention child ${index} exited ${code}: ${stderr}`));
            });
        }));
    }

    const readyDeadline = Date.now() + 30_000;
    while (
        Array.from({ length: 10 }, (_, index) => existsSync(join(readyDir, String(index))))
            .some((ready) => !ready)
    ) {
        if (Date.now() >= readyDeadline) throw new Error('contention children did not become ready');
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    writeFileSync(startPath, 'start');
    await Promise.all(exits);

    const exchangeMarkers = readdirSync(exchangeDir)
        .filter((name) => name.endsWith('.exchange'));
    assert.equal(exchangeMarkers.length, 1);
    const exchangeOwner = exchangeMarkers[0].slice(0, -'.exchange'.length);
    assert.equal(
        readFileSync(join(exchangeDir, exchangeMarkers[0]), 'utf8'),
        exchangeOwner,
    );
    assert.equal(
        loadCredentialsFromPath(processCredentials).accessToken,
        `fixture-process-new-${exchangeOwner}`,
    );
    for (let index = 0; index < 10; index += 2) {
        const oauth = JSON.parse(
            readFileSync(join(snapshotDir, `${index}.json`), 'utf8'),
        ).claudeAiOauth;
        assert.equal(oauth.accessToken, `fixture-process-new-${exchangeOwner}`);
        assert.equal(Object.hasOwn(oauth, 'refreshToken'), false);
    }
});

test('host preflight fails clearly when refresh cannot satisfy the lease', async () => {
    writeCredentials({
        accessToken: 'fixture-access-short-old',
        refreshToken: 'fixture-refresh-short-old',
        expiresAt: Date.now() + 1_000,
    });
    const snapshotPath = join(root, 'short-lease-container.json');
    const refreshFn = async (current) => {
        const raw = JSON.parse(readFileSync(current.path, 'utf8'));
        raw.claudeAiOauth.accessToken = 'fixture-access-short-new';
        raw.claudeAiOauth.refreshToken = 'fixture-refresh-short-new';
        raw.claudeAiOauth.expiresAt = Date.now() + 30_000;
        _saveCredentialsFile(current.path, raw);
        return loadCredentials();
    };

    await assert.rejects(
        preflightAnthropicOAuthCredentials({
            minimumValidityMs: 60_000,
            snapshotPath,
            refreshFn,
        }),
        /cannot satisfy the 60s credential lease/,
    );
});

test('expiring, forced, and 401 containers cause zero token exchanges', async () => {
    writeCredentials({
        accessToken: 'fixture-access-expiring',
        refreshToken: 'fixture-refresh-must-not-be-used',
        expiresAt: Date.now() + 1_000,
    });
    process.env.MIXDOG_ANTHROPIC_OAUTH_REFRESH_DISABLED = '1';
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        throw new Error('refresh transport must not run');
    };
    try {
        const providers = Array.from({ length: 12 }, () => {
            const provider = Object.create(AnthropicOAuthProvider.prototype);
            provider.credentials = loadCredentials();
            provider.config = {};
            return provider;
        });
        const results = await Promise.allSettled(
            providers.map((provider) => provider.ensureAuth()),
        );
        assert.equal(fetchCalls, 0);
        assert.ok(results.every((result) => (
            result.status === 'rejected'
            && /refresh is disabled.*Host credential preflight/s.test(result.reason.message)
        )));
        await assert.rejects(
            refreshOAuthCredentials(loadCredentials()),
            /host credential preflight must provide a fresh snapshot/,
        );
        writeCredentials({
            accessToken: 'fixture-access-valid',
            expiresAt: Date.now() + 10 * 60_000,
        });
        const forcedProvider = Object.create(AnthropicOAuthProvider.prototype);
        forcedProvider.credentials = loadCredentials();
        forcedProvider.config = {};
        forcedProvider.fastModeBetaHeaderLatched = false;
        await assert.rejects(
            forcedProvider.ensureAuth({ forceRefresh: true, reason: 'test' }),
            /refresh is disabled.*Host credential preflight/s,
        );

        let apiRequests = 0;
        await assert.rejects(
            forcedProvider.send([], 'claude-sonnet-4-5', [], {
                _doRequestFn: async () => {
                    apiRequests += 1;
                    return {
                        response: {
                            status: 401,
                            ok: false,
                            headers: new Map(),
                            async text() { return ''; },
                        },
                        controller: null,
                        cancelHandler: null,
                    };
                },
            }),
            /refresh is disabled.*Host credential preflight/s,
        );
        assert.equal(apiRequests, 1);
        assert.equal(fetchCalls, 0);
    } finally {
        globalThis.fetch = originalFetch;
        delete process.env.MIXDOG_ANTHROPIC_OAUTH_REFRESH_DISABLED;
    }
});
