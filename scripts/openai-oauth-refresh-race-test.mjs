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

const root = mkdtempSync(join(tmpdir(), 'mixdog-openai-race-'));
const tokenPath = join(root, 'openai-oauth.json');
const readyDir = join(root, 'ready');
const exchangeDir = join(root, 'exchanges');
const resultDir = join(root, 'results');
const startPath = join(root, 'start');
const moduleUrl = new URL(
  '../src/runtime/agent/orchestrator/providers/openai-oauth.mjs',
  import.meta.url,
).href;

after(() => rmSync(root, { recursive: true, force: true }));

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`OpenAI contention child exited ${code}: ${stderr}`));
    });
  });
}

test('contending OpenAI OAuth processes share one reread/exchange/write lock', async () => {
  mkdirSync(readyDir);
  mkdirSync(exchangeDir);
  mkdirSync(resultDir);
  writeFileSync(tokenPath, JSON.stringify({
    access_token: 'fixture-old-access',
    refresh_token: 'fixture-old-refresh',
    expires_at: Date.now() + 1_000,
  }));

  const childSource = `
import { existsSync, writeFileSync } from 'node:fs';
const { OpenAIOAuthProvider } = await import(${JSON.stringify(moduleUrl)});
const provider = Object.create(OpenAIOAuthProvider.prototype);
provider.config = {};
provider.tokens = {
  ...JSON.parse(await (await import('node:fs/promises')).readFile(process.env.TOKEN_PATH, 'utf8')),
  _mtimeMs: (await (await import('node:fs/promises')).stat(process.env.TOKEN_PATH)).mtimeMs
};
provider._lastDiskScan = provider.tokens._mtimeMs;
provider._refreshFallbackUntil = 0;
writeFileSync(process.env.READY_PATH, 'ready');
while (!existsSync(process.env.START_PATH)) await new Promise((resolve) => setTimeout(resolve, 10));
globalThis.fetch = async () => {
  const owner = String(process.pid);
  writeFileSync(process.env.EXCHANGE_DIR + '/' + owner, 'exchange', { flag: 'wx' });
  await new Promise((resolve) => setTimeout(resolve, 75));
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        access_token: 'fixture-new-access-' + owner,
        refresh_token: 'fixture-new-refresh-' + owner,
        expires_in: 600
      };
    }
  };
};
const tokens = await provider.ensureAuth();
writeFileSync(process.env.RESULT_PATH, tokens.access_token);
`;

  const exits = [];
  for (let index = 0; index < 10; index += 1) {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
      env: {
        ...process.env,
        MIXDOG_DATA_DIR: root,
        OPENAI_OAUTH_CREDENTIALS_PATH: tokenPath,
        TOKEN_PATH: tokenPath,
        READY_PATH: join(readyDir, String(index)),
        START_PATH: startPath,
        EXCHANGE_DIR: exchangeDir,
        RESULT_PATH: join(resultDir, String(index)),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    exits.push(waitForExit(child));
  }

  const deadline = Date.now() + 30_000;
  while (readdirSync(readyDir).length < 10) {
    if (Date.now() >= deadline) throw new Error('OpenAI contention children did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  writeFileSync(startPath, 'start');
  await Promise.all(exits);

  const exchanges = readdirSync(exchangeDir);
  assert.equal(exchanges.length, 1);
  const winner = exchanges[0];
  const expected = `fixture-new-access-${winner}`;
  assert.equal(JSON.parse(readFileSync(tokenPath, 'utf8')).access_token, expected);
  for (const result of readdirSync(resultDir)) {
    assert.equal(readFileSync(join(resultDir, result), 'utf8'), expected);
  }
  assert.equal(existsSync(`${tokenPath}.refresh.lock`), false);
});
