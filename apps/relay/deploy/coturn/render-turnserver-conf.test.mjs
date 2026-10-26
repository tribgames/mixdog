import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bash =
  process.platform === 'win32'
    ? join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'bin', 'bash.exe')
    : 'bash';
const here = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url)).replaceAll('\\', '/');

const VALUES = {
  TURN_PORT: '3478',
  TURN_TLS_PORT: '5349',
  TURN_MIN_PORT: '49152',
  TURN_MAX_PORT: '65535',
  TURN_PUBLIC_IP: '198.51.100.7',
  TURN_REALM: 'relay.example.com',
  TURN_USER_QUOTA: '12',
  TURN_AUTH_SECRET: 'not-a-marker-@TURN_PORT@-secret',
};

/** Sources the renderer under `set -Eeuo pipefail` (as provision-coturn.sh
 *  runs) and renders `template` with `values`. */
function render(values, template = here('turnserver.conf.template')) {
  const script = [
    'set -Eeuo pipefail',
    `source '${here('render-turnserver-conf.sh')}'`,
    ...Object.entries(values).map(([name, value]) => `${name}='${value}'`),
    `render_turnserver_conf '${template}'`,
  ].join('\n');
  return spawnSync(bash, ['--noprofile', '--norc', '-c', script], { encoding: 'utf8', timeout: 15000 });
}

const lines = (text) => text.split('\n');

test('every marker of the template is filled', () => {
  const result = render(VALUES);
  assert.equal(result.status, 0, result.stderr);
  const conf = lines(result.stdout);
  for (const line of [
    'listening-port=3478',
    'tls-listening-port=5349',
    'min-port=49152',
    'max-port=65535',
    'external-ip=198.51.100.7',
    'realm=relay.example.com',
    'user-quota=12',
    // A marker-like text inside the secret is left as it is.
    'static-auth-secret=not-a-marker-@TURN_PORT@-secret',
  ]) {
    assert.ok(conf.includes(line), `missing: ${line}`);
  }
  // No relay-load limit is configured (the template says why).
  for (const option of ['max-bps', 'bps-capacity', 'total-quota']) {
    assert.equal(conf.some((line) => line.startsWith(`${option}=`)), false, option);
  }
  assert.equal(
    conf.filter((line) => !line.startsWith('static-auth-secret=')).some((line) => /@TURN_[A-Z_]+@/u.test(line)),
    false
  );
});

test('a variable left unset fails instead of rendering an empty value', () => {
  const { TURN_USER_QUOTA: _unset, ...rest } = VALUES;
  const result = render(rest);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
});

test('a missing template stops provisioning when rendered inside a command substitution', () => {
  // provision-coturn.sh calls the renderer as CONF="$(render_turnserver_conf ...)",
  // where bash turns errexit off for the function body.
  const script = [
    'set -Eeuo pipefail',
    `source '${here('render-turnserver-conf.sh')}'`,
    ...Object.entries(VALUES).map(([name, value]) => `${name}='${value}'`),
    `CONF="$(render_turnserver_conf '${here('missing-turnserver.conf.template')}')"`,
    'echo "continued conf-length=${#CONF}"',
  ].join('\n');
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c', script], { encoding: 'utf8', timeout: 15000 });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes('continued'), false);
});

test('a template marker the renderer does not know fails the render, without the secret in the error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-coturn-template-'));
  try {
    const template = join(directory, 'turnserver.conf.template');
    await writeFile(template, 'static-auth-secret=@TURN_AUTH_SECRET@\nunknown=@TURN_UNKNOWN@\n');
    const result = render(VALUES, template.replaceAll('\\', '/'));
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /@TURN_UNKNOWN@/u);
    assert.equal(result.stderr.includes(VALUES.TURN_AUTH_SECRET), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
