import { readFileSync } from 'node:fs';

const SCENARIO_GROUPS_FILE = new URL('../src/main/computer/harness/scenario-groups.json', import.meta.url);

/** Group name → scenario ids, from the file the harness itself validates its declarations against. */
export function readScenarioGroups() {
  return JSON.parse(readFileSync(SCENARIO_GROUPS_FILE, 'utf8'));
}

/** The `--only` list for one scenario group. */
export function scenarioGroupOnly(name, groups = readScenarioGroups()) {
  if (!Object.hasOwn(groups, name)) {
    throw new Error(`unknown scenario group "${name}"; known groups: ${Object.keys(groups).join(', ')}`);
  }
  return groups[name].join(',');
}

export function repeatRequiresPass(argv = process.argv, env = process.env) {
  return (
    !argv.includes('--allow-failures') ||
    argv.some((value) => value === '--require-pass' || value === '--require-pass=true') ||
    String(env.npm_config_require_pass || '').toLowerCase() === 'true'
  );
}

export function assertRepeatedScenariosPassed(summary, required) {
  const failed = Number(summary?.failed) || 0;
  if (required && failed > 0) {
    throw new Error(`${failed} repeated Computer Use scenarios failed`);
  }
}
