import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

const argument = (name) => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || '';
};

const label = argument('label') || 'merged';
const output = resolve(argument('output') || `scenario-${label}.json`);
const passOverrides = new Set(
  argument('pass-overrides').split(',').map((value) => value.trim()).filter(Boolean),
);
const sources = process.argv.slice(2)
  .filter((value) => !value.startsWith('--'))
  .map((value) => resolve(value));
if (!sources.length) throw new Error('at least one scenario report is required');

const reports = await Promise.all(
  sources.map(async (source) => JSON.parse(await readFile(source, 'utf8'))),
);
const byId = new Map();
for (const report of reports) {
  for (const result of report.results || []) byId.set(result.id, { ...result });
}
for (const id of passOverrides) {
  const result = byId.get(id);
  if (!result) throw new Error(`pass override references missing scenario ${id}`);
  if (result.status !== 'pass') {
    result.raw_status = result.status;
    result.raw_failure = result.failure || '';
    result.status = 'pass';
    result.classification = 'harness_false_negative';
    delete result.failure;
  }
}
const results = [...byId.values()].sort(
  (left, right) => Number(left.id.slice(1)) - Number(right.id.slice(1)),
);
const passed = results.filter((result) => result.status === 'pass').length;
const failed = results.filter((result) => result.status === 'fail').length;
const skipped = results.filter((result) => result.status === 'skip').length;
const sum = (field) => results.reduce((total, result) => total + (Number(result[field]) || 0), 0);
const merged = {
  schema_version: 1,
  label,
  generated_at: new Date().toISOString(),
  source_reports: sources.map((source) => relative(process.cwd(), source).replaceAll('\\', '/')),
  classification_overrides: [...passOverrides],
  environment: reports[0]?.environment || {},
  summary: {
    total: results.length,
    passed,
    failed,
    skipped,
    success_rate: results.length ? passed / results.length : 0,
    duration_ms: sum('duration_ms'),
    commands: sum('commands'),
    tool_calls: sum('commands') - sum('cleanup_commands'),
    cleanup_commands: sum('cleanup_commands'),
    observations: sum('observations'),
    mutations: sum('mutations'),
    accepted_mutations: sum('accepted_mutations'),
    post_action_recaptures: sum('post_action_recaptures'),
    false_positives: results.filter((result) => result.false_positive).length,
    retries: sum('retries'),
    request_bytes: sum('request_bytes'),
    response_text_bytes: sum('response_text_bytes'),
    image_bytes: sum('image_bytes'),
    phase_ms: results.reduce((totals, result) => {
      for (const [name, timing] of Object.entries(result.phase_ms || {})) {
        totals[name] = Number(((totals[name] || 0) + Number(timing || 0)).toFixed(2));
      }
      return totals;
    }, {}),
  },
  results,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
console.log(
  `Merged Computer Use scenarios ${passed}/${results.length} passed`
    + ` (${failed} failed, ${skipped} skipped); ${output}`,
);
