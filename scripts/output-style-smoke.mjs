#!/usr/bin/env node
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const rulesBuilder = require('../src/lib/rules-builder.cjs');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertCleanOutput(name, value, { maxLines = 2, maxBullets = 3 } = {}) {
  const text = String(value || '').trim();
  assert(text, `${name}: empty output`);
  assert(!/\n\s*\n/.test(text), `${name}: multiple paragraphs are not compact`);
  assert(!/^\s*#{1,6}\s/m.test(text), `${name}: heading found`);
  assert(!/^\s*\d+[.)]\s/m.test(text), `${name}: numbered list found`);
  assert(!/^\s{2,}[-*]\s/m.test(text), `${name}: nested bullet found`);
  assert(!/^\s*[\p{L}\p{N}][\p{L}\p{N} _-]{0,30}:\s/um.test(text), `${name}: report label found`);
  assert(!/\b(?:tool trace|session metadata|model metadata|searched-path list)\b/i.test(text), `${name}: tool/meta trace found`);
  assert(!/\b(?:Mapped|Searched|Read|Called) for \d/i.test(text), `${name}: timing/tool status found`);
  assert(!/^(?:네|예|맞아요|좋아요|알겠습니다|Sure|Okay|Understood)[,.\s]/i.test(text), `${name}: acknowledgment preface found`);
  assert(!/(.+)(?:\n|\s{2,})\1/.test(text), `${name}: repeated conclusion found`);

  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const bulletLines = lines.filter((line) => /^\s*[-*]\s+/.test(line));
  if (bulletLines.length > 0) {
    assert(bulletLines.length === lines.length, `${name}: mixed prose and bullets`);
    assert(bulletLines.length <= maxBullets, `${name}: too many bullets`);
    return;
  }
  assert(lines.length <= maxLines, `${name}: too many lines`);

  const withoutCode = text.replace(/`[^`]*`/g, '');
  const sentenceMarks = withoutCode.match(/[.!?。！？]|다\.|요\./g) || [];
  assert(sentenceMarks.length <= 2, `${name}: too many sentences`);
}

const defaultStyle = readFileSync(join(root, 'src', 'output-styles', 'default.md'), 'utf8');
for (const required of [
  'name: default',
  'Uniformity beats local cleverness.',
  'One answer only.',
  'Hard cap user-visible replies at 2 short sentences',
  'Explore/retrieval results are evidence only',
  'Do not use label prefixes',
]) {
  assert(defaultStyle.includes(required), `default.md missing: ${required}`);
}
assert(!defaultStyle.includes('Claude Code-compact'), 'default.md must not reference the old compact style name');

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-output-style-smoke-'));
try {
  writeFileSync(join(dataDir, 'user-workflow.md'), 'workflow context should not override output style\n');
  const leadRules = rulesBuilder.buildInjectionContent({ PLUGIN_ROOT: join(root, 'src'), DATA_DIR: dataDir });
  const outputStyleIndex = leadRules.lastIndexOf('# Output Style');
  assert(outputStyleIndex >= 0, 'Lead output style missing');
  assert(outputStyleIndex > leadRules.lastIndexOf('# User Workflow'), 'Lead output style must be injected after workflow/user context');

  mkdirSync(join(dataDir, 'output-styles'), { recursive: true });
  writeFileSync(join(dataDir, 'mixdog-config.json'), JSON.stringify({ outputStyle: 'custom-smoke' }));
  writeFileSync(join(dataDir, 'output-styles', 'custom-smoke.md'), '---\nname: custom-smoke\n---\n\n# Custom Output Style\n\ncustom smoke style\n');
  const customRules = rulesBuilder.buildInjectionContent({ PLUGIN_ROOT: join(root, 'src'), DATA_DIR: dataDir });
  assert(customRules.includes('# Custom Output Style'), 'configured outputStyle must select custom style');
  assert(!customRules.includes('Default concise engineering replies'), 'custom outputStyle should not append default style');
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

const goodOutputs = {
  explanation: '기본 출력은 한 문장으로 결론만 말하고, 추가 설명은 사용자가 요청할 때만 붙입니다.',
  implementation: 'default 출력 스타일을 한 문장 우선으로 조였고 `npm run smoke:output`으로 확인했습니다.',
  crowded: '- default 스타일은 한 문장 우선입니다.\n- 상세/후보 요청이 있을 때만 목록을 펼칩니다.',
  blocker: '`src/output-styles/default.md`를 찾을 수 없어 변경이 막혔습니다.',
  semicolon: '`default.md`를 다듬었고; 출력 스모크가 예시 응답 모양을 검증합니다.',
};
for (const [name, output] of Object.entries(goodOutputs)) assertCleanOutput(name, output);

const badOutputs = {
  heading: '## Summary\nDone.',
  label: 'Changed: updated default style.',
  koreanLabel: '변경: default 스타일을 수정했습니다.\n검증: 스모크를 통과했습니다.',
  numbered: '1. Updated style\n2. Ran smoke',
  paragraphs: 'Done.\n\nDone again.',
  nested: '- Updated\n  - Nested detail',
  ack: '네, default 스타일을 수정했습니다.',
  timing: 'Mapped for 2m 32s\n\ndefault 스타일을 수정했습니다.',
  tooManySentences: '수정했습니다. 검증했습니다. 보고했습니다.',
  mixed: '수정했습니다.\n- 검증했습니다.',
};
for (const [name, output] of Object.entries(badOutputs)) {
  let failed = false;
  try { assertCleanOutput(`bad:${name}`, output); } catch { failed = true; }
  assert(failed, `bad sample unexpectedly passed: ${name}`);
}

process.stdout.write(`output style smoke passed samples=${Object.keys(goodOutputs).length}\n`);
