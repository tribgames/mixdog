// Records the goldens of the tail reminder rules (session/tail-reminder-rules.mjs).
//
//   node native/core/fixtures/agent/record-tail-reminder.mjs [path-to-node-checkout]
//
// Each case is run through the real `matchTailReminder` and `modelFamilyId`;
// results are written to `tail_reminder/cases.json`, which
// `tests/tail_rules.rs` replays.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const nodeRoot = resolve(process.argv[2] || process.env.MIXDOG_NODE_ROOT || 'C:/Project/mixdog');
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-tail-'));
const { matchTailReminder, modelFamilyId } = await import(
  pathToFileURL(join(nodeRoot, 'src/runtime/agent/orchestrator/session/tail-reminder-rules.mjs')).href
);

const models = [
  'claude-opus-5-5',
  'claude-opus-5.5',
  'anthropic/claude-opus-5.5',
  'claude-opus-5-5-20260101',
  'us.anthropic.claude-opus-5-5-v1:0',
  'claude-opus-5-5-thinking',
  'claude-opus-5-5@20260101',
  'openrouter/anthropic/claude-opus-5-5:thinking',
  '  Claude-Opus-5-5  ',
  'vendor/gpt-6',
  'gpt-6.1-mini',
  'claude-sonnet-5',
  '',
];
const ko = { id: 'ko', name: 'Korean' };
const en = { id: 'en', name: 'English' };
const contexts = [];
for (const model of ['claude-opus-5-5', 'anthropic/claude-opus-5.5', 'claude-sonnet-5', 'gpt-6'])
  for (const language of [ko, en, null])
    for (const role of ['lead', 'bot', 'worker'])
      for (const provider of ['anthropic', 'anthropic-oauth', 'openai', ''])
        contexts.push({ provider, model, language, role });

const out = {
  families: models.map((model) => ({ model, id: modelFamilyId(model) })),
  matches: contexts.map((context) => ({ context, text: matchTailReminder(context) })),
};
const dir = join(here, 'tail_reminder');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'cases.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(out.families.map((f) => `${JSON.stringify(f.model)} -> ${f.id}`).join('\n'));
console.log(out.matches.filter((m) => m.text).length, 'of', out.matches.length, 'matched');
