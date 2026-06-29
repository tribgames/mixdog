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

const DEFAULT_REPORT_LABELS = new Set(['바뀐 점', '확인한 것', '남은 리스크/다음 단계', '다음 단계']);

function assertCleanOutput(name, value, { maxLines = 3, maxBullets = 3, allowedLabels = new Set() } = {}) {
  const text = String(value || '').trim();
  assert(text, `${name}: empty output`);
  assert(!/\n\s*\n/.test(text), `${name}: multiple paragraphs are not compact`);
  assert(!/^\s*#{1,6}\s/m.test(text), `${name}: heading found`);
  assert(!/^\s*\d+[.)]\s/m.test(text), `${name}: numbered list found`);
  assert(!/^\s{2,}[-*]\s/m.test(text), `${name}: nested bullet found`);
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*]\s+)?([\p{L}\p{N}][\p{L}\p{N} _/-]{0,30}):\s/u);
    if (match) assert(allowedLabels.has(match[1]), `${name}: disallowed report label found`);
  }
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
  'Be short and direct.',
  'Lead with the answer or action',
  'For code work, report what changed and decisive verification',
  'Relax brevity for security',
]) {
  assert(defaultStyle.includes(required), `default.md missing: ${required}`);
}
assert(!defaultStyle.includes('Claude Code-compact'), 'default.md must not reference the old compact style name');
assert(!defaultStyle.includes('Hard cap user-visible replies'), 'default.md must not hard-cap replies to two short sentences');
assert(!defaultStyle.includes('Default final reports use 2-3 flat bullets'), 'default.md must not remain the report preset');

const simpleStyle = readFileSync(join(root, 'src', 'output-styles', 'simple.md'), 'utf8');
for (const required of [
  'name: simple',
  'Concise engineering summaries',
  'Use labels such as',
  '`바뀐 점`, `확인한 것`,',
  'Synthesize agent or retrieval results',
  'Do not hide blockers',
]) {
  assert(simpleStyle.includes(required), `simple.md missing: ${required}`);
}
for (const [name, style] of Object.entries({
  default: defaultStyle,
  simple: simpleStyle,
  extreme: readFileSync(join(root, 'src', 'output-styles', 'extreme-simple.md'), 'utf8'),
})) {
  assert(!style.includes('pre-tool preamble'), `${name} output style must not own language preamble rules`);
  assert(!style.includes('selected/default user language'), `${name} output style must not duplicate profile language rules`);
}

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-output-style-smoke-'));
try {
  writeFileSync(join(dataDir, 'user-workflow.md'), 'workflow context should not override output style\n');
  const leadRules = rulesBuilder.buildInjectionContent({ PLUGIN_ROOT: join(root, 'src'), DATA_DIR: dataDir });
  const outputStyleIndex = leadRules.lastIndexOf('# Output Style');
  assert(outputStyleIndex >= 0, 'Lead output style missing');
  assert(outputStyleIndex > leadRules.lastIndexOf('# User Workflow'), 'Lead output style must be injected after workflow/user context');

  mkdirSync(join(dataDir, 'output-styles'), { recursive: true });
  writeFileSync(join(dataDir, 'mixdog-config.json'), JSON.stringify({
    agent: { profile: { title: '재영님', language: 'system' } },
    outputStyle: 'custom-smoke',
  }));
  writeFileSync(join(dataDir, 'output-styles', 'custom-smoke.md'), '---\nname: custom-smoke\n---\n\n# Custom Output Style\n\ncustom smoke style\n');
  const customRules = rulesBuilder.buildInjectionContent({ PLUGIN_ROOT: join(root, 'src'), DATA_DIR: dataDir });
  assert(customRules.includes('# Custom Output Style'), 'configured outputStyle must select custom style');
  assert(!customRules.includes('Mixdog default — the standard concise tone'), 'custom outputStyle should not append default style');
  const profileMeta = rulesBuilder.buildLeadMetaContent({ PLUGIN_ROOT: join(root, 'src'), DATA_DIR: dataDir });
  assert(profileMeta.includes('Use "재영님" when directly addressing the user'), 'profile title must inject into Lead BP3 meta');
  assert(profileMeta.includes('Do not repeat it in routine progress updates or pre-tool preambles'), 'profile title must not encourage title in preambles');
  assert(/Default user-facing response language from system locale/.test(profileMeta), 'system profile language must resolve from system locale');
  assert(profileMeta.includes('including pre-tool preambles'), 'profile language must cover pre-tool preambles');
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

const goodOutputs = {
  explanation: '기본 출력은 간단 질문에 1-2문장으로 답하고, 작업 보고는 근거가 있는 짧은 bullet로 정리합니다.',
  implementation: '- 바뀐 점: default 출력 스타일을 2-3개 플랫 bullet 중심으로 복구했습니다.\n- 확인한 것: `npm run smoke:output`이 예시 응답 모양을 검증합니다.',
  crowded: '- 바뀐 점: default 스타일은 필요한 내용을 자르지 않고 2-3개 항목으로 나눕니다.\n- 확인한 것: 상세/후보 요청이 있을 때만 목록을 더 펼칩니다.',
  blocker: '`src/output-styles/default.md`를 찾을 수 없어 변경이 막혔습니다.',
  semicolon: '`default.md`를 다듬었고; 출력 스모크가 예시 응답 모양을 검증합니다.',
};
for (const [name, output] of Object.entries(goodOutputs)) assertCleanOutput(name, output, { allowedLabels: DEFAULT_REPORT_LABELS });

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
  tooManyBullets: '- 바뀐 점: A\n- 확인한 것: B\n- 다음 단계: C\n- 남은 리스크/다음 단계: D',
};
for (const [name, output] of Object.entries(badOutputs)) {
  let failed = false;
  try { assertCleanOutput(`bad:${name}`, output, { allowedLabels: DEFAULT_REPORT_LABELS }); } catch { failed = true; }
  assert(failed, `bad sample unexpectedly passed: ${name}`);
}

process.stdout.write(`output style smoke passed samples=${Object.keys(goodOutputs).length}\n`);
