#!/usr/bin/env node
// A scripted stand-in for a formatter/linter binary. Usage: `node fake-engine.mjs <scenario.json> <flags…>`.
// The scenario is `{ log, responses: [{ when?, call?, stdout?, stderr?, code?, report?, sleepMs? }] }`; the
// first response whose `when` is one of the flags and whose `call` is this invocation's index answers.
// Every invocation appends `{ argv, stdin, env }` to `log` (the `--report` value is replaced by REPORT),
// so a recorder and a Rust twin can compare what the runner asked for, not only what it made of the answer.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const [, , scenarioPath, ...flags] = process.argv;
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
let stdin = null;
try {
  stdin = readFileSync(0, 'utf8');
} catch {
  /* stdin is not piped */
}
let index = 0;
try {
  index = readFileSync(scenario.log, 'utf8').split('\n').filter(Boolean).length;
} catch {
  /* first call */
}
appendFileSync(
  scenario.log,
  `${JSON.stringify({
    argv: flags.map((flag, at) => (flags[at - 1] === '--report' ? 'REPORT' : flag)),
    stdin,
    env: { write: process.env.MIXDOG_TIDY_PSSA_WRITE ?? null, module: process.env.MIXDOG_TIDY_PSSA_MODULE ?? null },
  })}\n`
);
const response = scenario.responses.find((r) => (r.when === undefined || flags.includes(r.when)) && (r.call === undefined || r.call === index)) ?? {};
const reportAt = flags.indexOf('--report');
if (response.report !== undefined && reportAt >= 0) writeFileSync(flags[reportAt + 1], response.report);
process.stdout.write(response.stdout ?? '');
process.stderr.write(response.stderr ?? '');
if (response.sleepMs) await new Promise((resolve) => setTimeout(resolve, response.sleepMs));
process.exitCode = response.code ?? 0;
