const VALUE_OPTIONS = new Set(['--provider', '--model', '--effort', '--workflow']);
const FLAG_OPTIONS = new Set([
  '--readonly', '--help', '-h', '--plain', '--react', '--remote', '--onboarding', '--fast',
]);
const HEADLESS_ROLE_ALIASES = new Map([
  ['explorer', 'explore'], ['explore', 'explore'],
  ['maint', 'maintainer'], ['maintenance', 'maintainer'], ['maintainer', 'maintainer'],
  ['worker', 'worker'],
  ['heavy', 'heavy-worker'], ['heavyworker', 'heavy-worker'], ['heavy-worker', 'heavy-worker'],
  ['review', 'reviewer'], ['reviewer', 'reviewer'],
  ['debug', 'debugger'], ['debugger', 'debugger'],
  ['web', 'web-researcher'], ['web-researcher', 'web-researcher'],
]);
const HEADLESS_WORKFLOW_ERROR = 'option --workflow is not supported for headless role commands';

function roleKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function argvIndicatesHeadlessRole(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? '');
    if (VALUE_OPTIONS.has(arg)) {
      const value = argv[index + 1];
      if (value !== undefined && value !== '' && !String(value).startsWith('-')) {
        if (HEADLESS_ROLE_ALIASES.has(roleKey(value))) return true;
        index += 1;
      }
      continue;
    }
    if (FLAG_OPTIONS.has(arg) || arg.startsWith('-')) continue;
    return HEADLESS_ROLE_ALIASES.has(roleKey(arg));
  }
  return false;
}

function parseTokens(argv, { strictValues = true } = {}) {
  const positional = [];
  const values = {};
  const allowHeadlessIntent = strictValues && !argv.includes('--react');
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? '');
    if (VALUE_OPTIONS.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value === '' || String(value).startsWith('-')) {
        if (strictValues) {
          return {
            error: `option ${arg} requires a non-option value`,
            skipHostPrelude: arg === '--provider' || arg === '--model',
          };
        }
        continue;
      }
      const valueKey = roleKey(value);
      if (allowHeadlessIntent && arg === '--workflow' && HEADLESS_ROLE_ALIASES.has(valueKey)) {
        return {
          error: HEADLESS_WORKFLOW_ERROR,
          skipHostPrelude: true,
        };
      }
      if (allowHeadlessIntent
        && (arg === '--provider' || arg === '--model' || arg === '--effort')
        && HEADLESS_ROLE_ALIASES.has(valueKey)) {
        return {
          error: `option ${arg} requires a route value before headless role ${JSON.stringify(String(value))}`,
          skipHostPrelude: true,
        };
      }
      if (!(arg in values)) values[arg] = String(value);
      index += 1;
      continue;
    }
    if (FLAG_OPTIONS.has(arg)) continue;
    if (arg.startsWith('-')) {
      return {
        error: `unknown option ${arg}`,
        ...(allowHeadlessIntent
          && argvIndicatesHeadlessRole(argv)
          ? { skipHostPrelude: true }
          : {}),
      };
    }
    positional.push(arg);
  }
  return { positional, values };
}

function headlessFromPositional(positional) {
  if (!positional.length) return null;
  if (String(positional[0]).toLowerCase() === 'role') {
    return { error: 'usage: mixdog <role> <message...>' };
  }
  const key = roleKey(positional[0]);
  const agent = HEADLESS_ROLE_ALIASES.get(key) || null;
  if (!agent) return null;
  const message = positional.slice(1).join(' ').trim();
  if (!message) return { error: `usage: mixdog ${positional[0]} <message...>` };
  return { agent, message };
}

export function classifyCliInvocation(argv = []) {
  const hasHelp = argv.includes('--help') || argv.includes('-h');
  const hasPlain = argv.includes('--plain');
  const parsed = parseTokens(argv, { strictValues: !hasHelp && !hasPlain });
  if (parsed.error) return { kind: 'error', ...parsed };
  const options = {
    provider: parsed.values['--provider'],
    model: parsed.values['--model'],
    effort: parsed.values['--effort'],
    fast: argv.includes('--fast'),
    toolMode: argv.includes('--readonly') ? 'readonly' : 'full',
    remote: argv.includes('--remote'),
    forceOnboarding: argv.includes('--onboarding'),
  };
  if (hasHelp) return { kind: 'help', options };
  if (hasPlain) return { kind: 'plain', options };
  if (argv.includes('--react')) return { kind: 'react', options };
  const headless = headlessFromPositional(parsed.positional);
  if (headless?.error) {
    return { kind: 'error', error: headless.error, skipHostPrelude: true };
  }
  if (headless) {
    if (parsed.values['--workflow'] !== undefined) {
      return {
        kind: 'error',
        error: HEADLESS_WORKFLOW_ERROR,
        skipHostPrelude: true,
      };
    }
    return { kind: 'headless', headless, options, skipHostPrelude: true };
  }
  return { kind: 'general', options };
}

export function parseHeadlessRoleCommand(argv = []) {
  const invocation = classifyCliInvocation(argv);
  if (invocation.kind === 'error') return { error: invocation.error };
  return invocation.kind === 'headless' ? invocation.headless : null;
}
