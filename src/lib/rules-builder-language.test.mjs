import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  _buildLeadLanguageContext,
  _buildLeadMetaContext,
  _buildLeadRules,
  _buildSharedRules,
} from '../runtime/agent/orchestrator/session/manager/rules-cache.mjs';

function renderLeadPrompt(language) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-language-rules-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  try {
    writeFileSync(
      join(dataDir, 'mixdog-config.json'),
      JSON.stringify({
        agent: {
          profile: { language },
        },
      })
    );
    // Production composes these split layers. The language block stays last,
    // after shared policy, meta, and the Lead role.
    return [_buildSharedRules(), _buildLeadMetaContext(), _buildLeadRules(), _buildLeadLanguageContext()]
      .filter(Boolean)
      .join('\n\n');
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test('Lead prompt keeps the configured response language authoritative', () => {
  const korean = renderLeadPrompt('ko');
  assert.match(korean, /Always respond in Korean, including pre-tool preambles/);
  assert.match(korean, /progress updates, questions, reports, and notices/);
  assert.match(korean, /do not change this language, even when the immediately preceding text is English/);
  assert.match(korean, /the user's latest explicit language request takes precedence/);
  // The language block trails every rule block: no persona/general English
  // rule may follow it, and it is absent from the meta (BP2) layer.
  assert.ok(korean.indexOf('# Language') > korean.indexOf('# Lead'));
  assert.equal(korean.indexOf('# Language'), korean.lastIndexOf('# Language'));

  const japanese = renderLeadPrompt('ja');
  assert.match(japanese, /Always respond in Japanese \(日本語\),/);
});

test('unknown language ids use system language, not inherited object properties', () => {
  const languageBlock = (language) => renderLeadPrompt(language).match(/# Language[\s\S]*$/)?.[0] || '';
  const expected = languageBlock('system');
  for (const language of ['unknown-language', '__proto__', 'constructor', 'toString']) {
    assert.equal(languageBlock(language), expected);
  }
});
