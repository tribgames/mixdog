import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const rulesBuilder = require('./rules-builder.cjs');
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function renderLeadPrompt(language) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-language-rules-'));
  try {
    writeFileSync(
      join(dataDir, 'mixdog-config.json'),
      JSON.stringify({
        agent: {
          profile: { language },
        },
      }),
    );
    return rulesBuilder.buildInjectionContent({
      PLUGIN_ROOT: pluginRoot,
      DATA_DIR: dataDir,
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test('Lead prompt keeps the configured response language authoritative', () => {
  const korean = renderLeadPrompt('ko');
  assert.match(korean, /Always respond in Korean\./);
  assert.match(korean, /user-facing text: pre-tool preamble/);
  assert.match(korean, /write the preamble and progress lines in Korean even when the text just before them is English/);
  assert.match(korean, /Preamble and reply language follow this setting and the user's latest instruction only/);
  // The language block trails every rule block: no persona/general English
  // rule may follow it, and it is absent from the meta (BP2) layer.
  assert.ok(korean.indexOf('# Language') > korean.indexOf('# Persona'));
  assert.equal(korean.indexOf('# Language'), korean.lastIndexOf('# Language'));

  const japanese = renderLeadPrompt('ja');
  assert.match(japanese, /Always respond in Japanese \(日本語\)\./);
});
