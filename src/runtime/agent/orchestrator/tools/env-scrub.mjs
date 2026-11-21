const LOADER_VARS = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'PYTHONPATH',
  'RUBYLIB',
  'PERL5LIB',
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'GLOBIGNORE',
  'CDPATH',
  'PROMPT_COMMAND',
  'BASHOPTS',
  'IFS',
  'SSH_AUTH_SOCK',
  'GPG_AGENT_INFO',
  'GNUPGHOME',
];

const SECRET_SUFFIX_RE =
  /(_SECRET_ACCESS_KEY|_ACCESS_KEY|_SESSION_TOKEN|_AUTH_TOKEN|_API_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS|_PRIVATE_KEY|_PAT)$/;
const PUBLIC_PREFIX_RE =
  /^(?:NEXT_PUBLIC_|NUXT_PUBLIC_|VITE_|REACT_APP_|VUE_APP_|EXPO_PUBLIC_|GATSBY_|STORYBOOK_|PUBLIC_)/;
const SECRET_EXACT = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'DATABASE_URL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GITHUB_PAT',
  'STRIPE_SECRET_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NPM_CONFIG__AUTH',
  'npm_config__auth',
]);

export function scrubLoaderVars(env) {
  if (!env || typeof env !== 'object') return env;
  for (const k of LOADER_VARS) delete env[k];
  for (const k of Object.keys(env)) {
    if (/^DYLD_/.test(k) || /^LD_/.test(k)) delete env[k];
  }
  return env;
}

export function applyShellEgressPolicy(env) {
  return env;
}

export function scrubProviderSecrets(env) {
  if (!env || typeof env !== 'object') return env;
  for (const k of Object.keys(env)) {
    if (!PUBLIC_PREFIX_RE.test(k) && (SECRET_EXACT.has(k) || SECRET_SUFFIX_RE.test(k))) {
      delete env[k];
    }
  }
  return env;
}

export function scrubRuntimeRootVars(env) {
  if (!env || typeof env !== 'object') return env;
  delete env.MIXDOG_ROOT;
  delete env.NODE_ENV;
  delete env.MIXDOG_DAEMON_HOST;
  delete env.MIXDOG_WORKER_MODE;
  delete env.MIXDOG_DAEMON_SPAWNED_FOR;
  delete env.MIXDOG_SUPERVISOR_PID;
  delete env.MIXDOG_SERVER_PID;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
