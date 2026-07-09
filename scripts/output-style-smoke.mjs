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

const DEFAULT_REPORT_LABELS = new Set(['\uBC14\uB010 \uC810', '\uD655\uC778\uD55C \uAC83', '\uB0A8\uC740 \uB9AC\uC2A4\uD06C/\uB2E4\uC74C \uB2E8\uACC4', '\uB2E4\uC74C \uB2E8\uACC4']);

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
  assert(!/^(?:\uB124|\uC608|\uB9DE\uC544\uC694|\uC88B\uC544\uC694|\uC54C\uACA0\uC2B5\uB2C8\uB2E4|Sure|Okay|Understood)[,.\s]/i.test(text), `${name}: acknowledgment preface found`);
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
  const sentenceMarks = withoutCode.match(/[.!?。！？]|\uB2E4\.|\uC694\./g) || [];
  assert(sentenceMarks.length <= 2, `${name}: too many sentences`);
}

const defaultStyle = readFileSync(join(root, 'src', 'output-styles', 'default.md'), 'utf8');
for (const required of [
  'name: default',
  'Concise engineering summaries',
  'Mixdog default — the most detailed style',
  'State conclusions, not reasoning',
  'Use labels such as',
  '`\uBC14\uB010 \uC810`, `\uD655\uC778\uD55C \uAC83`,',
  'Synthesize agent or retrieval results',
  'Do not hide blockers',
]) {
  assert(defaultStyle.includes(required), `default.md missing: ${required}`);
}
assert(!defaultStyle.includes('Claude Code-compact'), 'default.md must not reference the old compact style name');
assert(!defaultStyle.includes('Hard cap user-visible replies'), 'default.md must not hard-cap replies to two short sentences');
assert(!defaultStyle.includes('Be short and direct.'), 'default.md must not keep the old generic concise preset');
assert(!defaultStyle.includes('Practical concise — outcome-first handoffs'), 'default.md must not use the simple preset body');

const simpleStyle = readFileSync(join(root, 'src', 'output-styles', 'simple.md'), 'utf8');
for (const required of [
  'name: simple',
  'Outcome-first concise handoffs for coding work',
  'Practical concise — outcome-first handoffs',
  'file_path:line_number',
  'Controlled detail',
  'Synthesize agent or retrieval results',
  'Do not hide blockers',
  'verification was not run, say so once',
]) {
  assert(simpleStyle.includes(required), `simple.md missing: ${required}`);
}
assert(!simpleStyle.includes('Mixdog default — the most detailed of the three styles'), 'simple.md must not duplicate default preset body');
for (const [name, style] of Object.entries({
  default: defaultStyle,
  simple: simpleStyle,
  minimal: readFileSync(join(root, 'src', 'output-styles', 'minimal.md'), 'utf8'),
  'extreme-minimal': readFileSync(join(root, 'src', 'output-styles', 'extreme-minimal.md'), 'utf8'),
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
    agent: { profile: { title: '\uD64D\uAE38\uB3D9\uB2D8', language: 'system' } },
    outputStyle: 'custom-smoke',
  }));
  writeFileSync(join(dataDir, 'output-styles', 'custom-smoke.md'), '---\nname: custom-smoke\n---\n\n# Custom Output Style\n\ncustom smoke style\n');
  const customRules = rulesBuilder.buildInjectionContent({ PLUGIN_ROOT: join(root, 'src'), DATA_DIR: dataDir });
  assert(customRules.includes('# Custom Output Style'), 'configured outputStyle must select custom style');
  assert(!customRules.includes('Mixdog default — the most detailed of the three styles'), 'custom outputStyle should not append default style');
  const profileMeta = rulesBuilder.buildLeadMetaContent({ PLUGIN_ROOT: join(root, 'src'), DATA_DIR: dataDir });
  assert(profileMeta.includes('Use "\uD64D\uAE38\uB3D9\uB2D8" when directly addressing the user'), 'profile title must inject into Lead BP3 meta');
  assert(profileMeta.includes('do not repeat it in routine progress updates or pre-tool preambles'), 'profile title must not encourage title in preambles');
  assert(/Default user-facing response language from system locale/.test(profileMeta), 'system profile language must resolve from system locale');
  assert(profileMeta.includes('pre-tool preambles (even single-line)'), 'profile language must cover pre-tool preambles');
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

// assertCleanOutput encodes the Simple style compact contract (not Default, which may be longer).
const goodOutputs = {
  explanation: 'Simple \uC2A4\uD0C0\uC77C\uC740 \uACB0\uACFC \uD55C \uC904\uACFC \uADFC\uAC70 \uD55C \uAC00\uC9C0\uB85C \uB05D\uB0B4\uACE0, \uCD5C\uC885 handoff\uB9CC \uC9E7\uC740 bullet \uB77C\uBCA8\uC744 \uC501\uB2C8\uB2E4.',
  implementation: '- \uBC14\uB010 \uC810: `scripts/output-style-smoke.mjs`\uC758 default/simple \uBB38\uC790\uC5F4 \uAC80\uC99D\uC744 \uD604\uC7AC \uD504\uB9AC\uC14B\uC5D0 \uB9DE\uCDC4\uC2B5\uB2C8\uB2E4.\n- \uD655\uC778\uD55C \uAC83: `node scripts/output-style-smoke.mjs`\uB97C \uC2E4\uD589\uD588\uC2B5\uB2C8\uB2E4.',
  crowded: '- \uBC14\uB010 \uC810: compact guardrail\uC740 Simple handoff\uC6A9 controlled detail\uC744 \uAC80\uC99D\uD569\uB2C8\uB2E4.\n- \uD655\uC778\uD55C \uAC83: bad \uC0D8\uD50C \uAC70\uBD80 \uADDC\uCE59\uC740 \uADF8\uB300\uB85C\uC785\uB2C8\uB2E4.',
  blocker: '`scripts/output-style-smoke.mjs`\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC5B4 \uBCC0\uACBD\uC774 \uB9C9\uD614\uC2B5\uB2C8\uB2E4.',
  semicolon: '\uC2A4\uBAA8\uD06C \uC2A4\uD06C\uB9BD\uD2B8\uB97C \uAC31\uC2E0\uD588\uACE0; Simple \uACC4\uC57D\uC5D0 \uB9DE\uB294 \uC608\uC2DC \uC751\uB2F5\uB9CC \uD1B5\uACFC\uD569\uB2C8\uB2E4.',
};
for (const [name, output] of Object.entries(goodOutputs)) assertCleanOutput(name, output, { allowedLabels: DEFAULT_REPORT_LABELS });

const badOutputs = {
  heading: '## Summary\nDone.',
  label: 'Changed: updated default style.',
  koreanLabel: '\uBCC0\uACBD: default \uC2A4\uD0C0\uC77C\uC744 \uC218\uC815\uD588\uC2B5\uB2C8\uB2E4.\n\uAC80\uC99D: \uC2A4\uBAA8\uD06C\uB97C \uD1B5\uACFC\uD588\uC2B5\uB2C8\uB2E4.',
  numbered: '1. Updated style\n2. Ran smoke',
  paragraphs: 'Done.\n\nDone again.',
  nested: '- Updated\n  - Nested detail',
  ack: '\uB124, default \uC2A4\uD0C0\uC77C\uC744 \uC218\uC815\uD588\uC2B5\uB2C8\uB2E4.',
  timing: 'Mapped for 2m 32s\n\ndefault \uC2A4\uD0C0\uC77C\uC744 \uC218\uC815\uD588\uC2B5\uB2C8\uB2E4.',
  tooManySentences: '\uC218\uC815\uD588\uC2B5\uB2C8\uB2E4. \uAC80\uC99D\uD588\uC2B5\uB2C8\uB2E4. \uBCF4\uACE0\uD588\uC2B5\uB2C8\uB2E4.',
  mixed: '\uC218\uC815\uD588\uC2B5\uB2C8\uB2E4.\n- \uAC80\uC99D\uD588\uC2B5\uB2C8\uB2E4.',
  tooManyBullets: '- \uBC14\uB010 \uC810: A\n- \uD655\uC778\uD55C \uAC83: B\n- \uB2E4\uC74C \uB2E8\uACC4: C\n- \uB0A8\uC740 \uB9AC\uC2A4\uD06C/\uB2E4\uC74C \uB2E8\uACC4: D',
};
for (const [name, output] of Object.entries(badOutputs)) {
  let failed = false;
  try { assertCleanOutput(`bad:${name}`, output, { allowedLabels: DEFAULT_REPORT_LABELS }); } catch { failed = true; }
  assert(failed, `bad sample unexpectedly passed: ${name}`);
}

process.stdout.write(`output style smoke passed samples=${Object.keys(goodOutputs).length}\n`);
