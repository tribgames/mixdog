export function repeatRequiresPass(argv = process.argv, env = process.env) {
  return argv.some((value) =>
    value === '--require-pass' || value === '--require-pass=true')
    || String(env.npm_config_require_pass || '').toLowerCase() === 'true';
}

export function assertRepeatedScenariosPassed(summary, required) {
  const failed = Number(summary?.failed) || 0;
  if (required && failed > 0) {
    throw new Error(`${failed} repeated Computer Use scenarios failed`);
  }
}
