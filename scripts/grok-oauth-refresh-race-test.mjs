import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonAtomicSync } from '../src/runtime/shared/atomic-file.mjs';

const root = mkdtempSync(join(tmpdir(), 'mixdog-grok-race-'));
const tokenPath = join(root, 'grok-oauth.json');
const moduleUrl = new URL(
    '../src/runtime/agent/orchestrator/providers/grok-oauth.mjs',
    import.meta.url,
).href;

after(() => {
    rmSync(root, { recursive: true, force: true });
});

function writeTokens(accessToken, refreshToken, expiresAt, extra = {}) {
    writeJsonAtomicSync(tokenPath, {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        token_endpoint: 'https://auth.x.ai/oauth/token',
        ...extra,
    }, { lock: true, fsyncDir: true, mode: 0o600, secret: true });
}

function waitForExit(child, label) {
    return new Promise((resolve, reject) => {
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${label} exited ${code}: ${stderr}`));
        });
    });
}

async function waitForFiles(dir, count) {
    const deadline = Date.now() + 30_000;
    while (readdirSync(dir).length < count) {
        if (Date.now() >= deadline) throw new Error('Grok race children did not become ready');
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

test('contending Grok processes adopt a refresh-only token rotation', async () => {
    const readyDir = join(root, 'ready');
    const exchangeDir = join(root, 'exchanges');
    const resultDir = join(root, 'results');
    const startPath = join(root, 'start');
    mkdirSync(readyDir);
    mkdirSync(exchangeDir);
    mkdirSync(resultDir);
    writeTokens('fixture-old-access', 'fixture-old-refresh', Date.now() + 1_000);

    const childSource = `
import { writeFileSync } from 'node:fs';
const { GrokOAuthProvider } = await import(${JSON.stringify(moduleUrl)});
const provider = Object.create(GrokOAuthProvider.prototype);
provider.config = {};
provider.tokens = {
  ...JSON.parse(await (await import('node:fs/promises')).readFile(process.env.TOKEN_PATH, 'utf8')),
  mtimeMs: (await (await import('node:fs/promises')).stat(process.env.TOKEN_PATH)).mtimeMs,
  source: 'own'
};
provider._lastDiskScan = provider.tokens.mtimeMs;
provider._refreshFallbackUntil = 0;
writeFileSync(process.env.READY_PATH, 'ready');
while (!(await (await import('node:fs/promises')).stat(process.env.START_PATH).catch(() => null))) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
globalThis.fetch = async () => {
  const owner = String(process.pid);
  writeFileSync(process.env.EXCHANGE_DIR + '/' + owner, 'exchange', { flag: 'wx' });
  await new Promise((resolve) => setTimeout(resolve, 75));
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        access_token: 'fixture-old-access',
        refresh_token: 'fixture-new-refresh-' + owner,
        expires_in: 600
      });
    }
  };
};
const tokens = await provider.ensureAuth();
writeFileSync(process.env.RESULT_PATH, tokens.refresh_token);
`;

    const exits = [];
    for (let index = 0; index < 10; index += 1) {
        const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
            env: {
                ...process.env,
                MIXDOG_DATA_DIR: root,
                TOKEN_PATH: tokenPath,
                READY_PATH: join(readyDir, String(index)),
                START_PATH: startPath,
                EXCHANGE_DIR: exchangeDir,
                RESULT_PATH: join(resultDir, String(index)),
            },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        exits.push(waitForExit(child, `contention child ${index}`));
    }

    await waitForFiles(readyDir, 10);
    writeFileSync(startPath, 'start');
    await Promise.all(exits);

    const exchanges = readdirSync(exchangeDir);
    assert.equal(exchanges.length, 1);
    const expectedRefresh = `fixture-new-refresh-${exchanges[0]}`;
    const persisted = JSON.parse(readFileSync(tokenPath, 'utf8'));
    assert.equal(persisted.access_token, 'fixture-old-access');
    assert.equal(persisted.refresh_token, expectedRefresh);
    for (const result of readdirSync(resultDir)) {
        assert.equal(readFileSync(join(resultDir, result), 'utf8'), expectedRefresh);
    }
});

test('invalid_grant adopts a valid token written by a peer without rotating it', async () => {
    const requestStarted = join(root, 'invalid-request-started');
    const peerWritten = join(root, 'invalid-peer-written');
    const resultPath = join(root, 'invalid-result');
    writeTokens('fixture-invalid-old-access', 'fixture-invalid-old-refresh', Date.now() + 1_000);

    const childSource = `
import { writeFileSync } from 'node:fs';
const { GrokOAuthProvider } = await import(${JSON.stringify(moduleUrl)});
const provider = Object.create(GrokOAuthProvider.prototype);
provider.config = {};
provider.tokens = {
  ...JSON.parse(await (await import('node:fs/promises')).readFile(process.env.TOKEN_PATH, 'utf8')),
  mtimeMs: (await (await import('node:fs/promises')).stat(process.env.TOKEN_PATH)).mtimeMs,
  source: 'own'
};
provider._lastDiskScan = provider.tokens.mtimeMs;
provider._refreshFallbackUntil = 0;
let calls = 0;
globalThis.fetch = async () => {
  calls += 1;
  writeFileSync(process.env.REQUEST_STARTED, 'started');
  while (!(await (await import('node:fs/promises')).stat(process.env.PEER_WRITTEN).catch(() => null))) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return {
    ok: false,
    status: 400,
    async text() { return JSON.stringify({ error: 'invalid_grant' }); }
  };
};
const tokens = await provider.ensureAuth();
writeFileSync(process.env.RESULT_PATH, JSON.stringify({
  adopted: tokens.access_token === 'fixture-peer-access',
  calls
}));
`;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
        env: {
            ...process.env,
            MIXDOG_DATA_DIR: root,
            TOKEN_PATH: tokenPath,
            REQUEST_STARTED: requestStarted,
            PEER_WRITTEN: peerWritten,
            RESULT_PATH: resultPath,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    const exit = waitForExit(child, 'invalid_grant child');
    const deadline = Date.now() + 30_000;
    while (!existsSync(requestStarted)) {
        if (Date.now() >= deadline) throw new Error('invalid_grant request did not start');
        await new Promise((resolve) => setTimeout(resolve, 20));
    }

    writeTokens('fixture-peer-access', 'fixture-peer-refresh', Date.now() + 10 * 60_000);
    writeFileSync(peerWritten, 'written');
    await exit;

    assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), { adopted: true, calls: 1 });
    assert.ok(statSync(tokenPath).size > 0);
});

test('refresh retries transient responses three times, preserves principal fields, and stops on invalid_client', async () => {
    const resultPath = join(root, 'retry-policy-result');
    writeTokens('fixture-retry-access', 'fixture-retry-refresh', Date.now() + 1_000, {
        principal_type: 'user',
        principal_id: 'principal-123',
    });
    const childSource = `
const { writeFileSync } = await import('node:fs');
const { GrokOAuthProvider } = await import(${JSON.stringify(moduleUrl)});
const provider = new GrokOAuthProvider({preconnect:false});
const bodies = [];
let retryCalls = 0;
globalThis.fetch = async (_url, init) => {
  retryCalls += 1;
  bodies.push(Object.fromEntries(init.body.entries()));
  if (retryCalls === 1) {
    return {ok:false,status:400,async text(){return JSON.stringify({error:'temporarily_unavailable'});}};
  }
  if (retryCalls === 2) {
    return {ok:false,status:401,async text(){return '{}';}};
  }
  return {ok:true,status:200,async text(){return JSON.stringify({
    access_token:'fixture-retry-new-access',
    refresh_token:'fixture-retry-new-refresh',
    expires_in:600
  });}};
};
const refreshed = await provider.ensureAuth({forceRefresh:true});
let terminalCalls = 0;
globalThis.fetch = async () => {
  terminalCalls += 1;
  return {ok:false,status:400,async text(){return JSON.stringify({error:'invalid_client'});}};
};
let terminalCode = null;
try {
  await provider.ensureAuth({forceRefresh:true});
} catch (error) {
  terminalCode = error.oauthError;
}
writeFileSync(process.env.RESULT_PATH, JSON.stringify({
  retryCalls,
  bodies,
  principalType: refreshed.principal_type,
  principalId: refreshed.principal_id,
  terminalCalls,
  terminalCode
}));
`;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
        env: {
            ...process.env,
            MIXDOG_DATA_DIR: root,
            GROK_OAUTH_CREDENTIALS_PATH: tokenPath,
            RESULT_PATH: resultPath,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    await waitForExit(child, 'refresh retry policy child');
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.equal(result.retryCalls, 3);
    assert.equal(result.terminalCalls, 1);
    assert.equal(result.terminalCode, 'invalid_client');
    assert.equal(result.principalType, 'user');
    assert.equal(result.principalId, 'principal-123');
    for (const body of result.bodies) {
        assert.equal(body.principal_type, 'user');
        assert.equal(body.principal_id, 'principal-123');
        assert.equal(body.refresh_token, 'fixture-retry-refresh');
    }
    const persisted = JSON.parse(readFileSync(tokenPath, 'utf8'));
    assert.equal(persisted.principal_type, 'user');
    assert.equal(persisted.principal_id, 'principal-123');
});
