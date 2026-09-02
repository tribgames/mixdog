import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import { executeOfficeTool } from '../index.mjs';
import { resultValue } from './bench-support.mjs';

const CASES = [
  {
    format: 'docx',
    backend: 'mixdog-ooxml',
    operation: 'append_text',
    required: ['op', 'text'],
  },
  {
    format: 'xlsx',
    backend: 'microsoft-office-com',
    operation: 'add_chart',
    required: ['op', 'range'],
  },
  {
    format: 'pptx',
    backend: 'microsoft-office-com',
    operation: 'add_textbox',
    required: ['op', 'slide', 'text'],
  },
  {
    format: 'pdf',
    backend: 'mixdog-pdf',
    operation: 'add_text',
    required: ['op', 'text'],
  },
];

export async function runOfficeContractBenchmark() {
  let deterministicToolCalls = 0;
  const call = async (input) => {
    deterministicToolCalls += 1;
    return executeOfficeTool(input);
  };

  const summary = resultValue(await call({ action: 'describe' }));
  assert.equal(summary.actions.length, 25);
  for (const removed of ['set', 'add', 'remove', 'move']) assert.equal(summary.actions.includes(removed), false);
  for (const entry of Object.values(summary.formats)) {
    assert.equal(entry.operations, undefined);
    assert.ok(entry.operationCount > 0);
  }

  const results = [];
  for (const scenario of CASES) {
    const described = resultValue(await call({ action: 'describe', ...scenario }));
    assert.equal(described.operation.name, scenario.operation);
    assert.equal(described.operation.supported, true);
    assert.deepEqual(described.operation.input.required, scenario.required);
    results.push({
      format: scenario.format,
      backend: scenario.backend,
      operation: scenario.operation,
      responseChars: JSON.stringify(described).length,
      accurate: true,
    });
  }

  const invalid = await call({
    action: 'describe',
    format: 'xlsx',
    operation: 'add_chrt',
  });
  assert.equal(invalid.isError, true);
  const invalidError = invalid.content?.[0]?.text || '';
  assert.match(invalidError, /Did you mean: add_chart/);
  assert.match(invalidError, /describe/);

  return {
    version: 2,
    createdAt: new Date().toISOString(),
    measurementKind: 'deterministic-contract-probe',
    modelBehaviorMeasured: false,
    deterministicToolCalls,
    retries: 0,
    unnecessaryRereads: 0,
    broadCatalogMaterializations: 0,
    publicActionCount: summary.actions.length,
    requirementFulfillment: {
      passed: results.length,
      total: CASES.length,
      rate: results.length / CASES.length,
    },
    summaryResponseChars: JSON.stringify(summary).length,
    maxTargetedResponseChars: Math.max(...results.map((entry) => entry.responseChars)),
    actionableErrorProbe: true,
    accurate: results.every((entry) => entry.accurate),
    results,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runOfficeContractBenchmark();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
