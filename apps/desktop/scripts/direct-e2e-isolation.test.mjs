import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const script = join(scriptsDir, 'direct-e2e-windows.ps1');
const artifactDir = join(scriptsDir, '..', 'artifacts');
const skip = process.platform !== 'win32' && 'Windows PowerShell only';

function powershell(args) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function listen() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('direct E2E script parses and uses isolated defaults', { skip }, () => {
  const result = powershell([
    '-Command',
    `$e=$null;$t=$null;$a=[Management.Automation.Language.Parser]::ParseFile('${script.replace(/'/g, "''")}',[ref]$t,[ref]$e);` +
      `if($e.Count){$e|ForEach-Object{$_.Message};exit 1};` +
      `$p=$a.ParamBlock.Parameters|Where-Object{$_.Name.VariablePath.UserPath -eq 'Port'};` +
      `Write-Output $p.DefaultValue.Value`,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), '9342');
});

test('busy CDP port fails before any artifact is created', { skip }, async () => {
  const before = existsSync(artifactDir) ? readdirSync(artifactDir).sort() : null;
  const server = await listen();
  try {
    const { port } = server.address();
    const result = powershell(['-File', script, '-Port', String(port)]);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /EADDRINUSE/);
    assert.doesNotMatch(result.stdout, /DIRECT_E2E_REPORT=/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const after = existsSync(artifactDir) ? readdirSync(artifactDir).sort() : null;
  assert.deepEqual(after, before);
});
