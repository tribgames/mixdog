// R11: scrub dangerous loader/execution env vars from a model-spawned
// subprocess environment. Defense-in-depth on top of R5's secret scrub
// (provider/cloud tokens). These vars let an attacker (or model error)
// inject code before the user's command runs — NODE_OPTIONS can preload
// arbitrary --require modules, LD_PRELOAD / DYLD_INSERT_LIBRARIES inject
// shared libraries, PYTHONPATH / RUBYLIB / PERL5LIB hijack imports,
// BASH_ENV / ENV runs a script on shell startup, SHELLOPTS toggles
// dangerous shell flags, GLOBIGNORE silently hides files from expansion.
// CDPATH redirects `cd` to attacker-controlled dirs, PROMPT_COMMAND runs
// arbitrary code on every prompt, BASHOPTS toggles shell options, IFS
// rewrites word splitting, SSH_AUTH_SOCK / GPG_AGENT_INFO / GNUPGHOME
// expose live agent credentials to the child.
// PATH is intentionally preserved — subprocesses need it to find tools.
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

// R5: provider / cloud / secret-family scrub. Shared across all spawn
// sites so the suffix and exact lists never drift. Broad provider-family
// prefixes (AWS_/GITHUB_/NPM_/VERCEL_/…) were removed: they nuked
// non-secret config like AWS_REGION, GITHUB_WORKSPACE, NPM_CONFIG_CACHE,
// VERCEL_ENV and broke subprocess tooling. Match instead by secret-
// shaped SUFFIX (covers `*_API_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`,
// `*_CREDENTIALS`, `*_PRIVATE_KEY`, `*_KEY`, …) and an explicit EXACT
// set for non-suffix secrets (AWS access ids, DATABASE_URL, named
// provider keys, GOOGLE_APPLICATION_CREDENTIALS).
// Secret-shaped suffixes. The bare `_KEY` suffix was dropped — it deleted
// non-secret public keys (GPG_KEY, NEXT_PUBLIC_*_KEY). `_API_KEY` is kept for
// broad provider coverage (e.g. XAI_API_KEY) but is guarded by PUBLIC_PREFIX_RE
// so client-exposed build vars (VITE_FIREBASE_API_KEY, NEXT_PUBLIC_*) survive.
const SECRET_SUFFIX_RE = /(_SECRET_ACCESS_KEY|_ACCESS_KEY|_SESSION_TOKEN|_AUTH_TOKEN|_API_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS|_PRIVATE_KEY|_PAT)$/;
// By-convention client-PUBLIC env prefixes: these are intentionally bundled to
// the browser and must never be scrubbed as secrets even with an _API_KEY/_KEY
// shape. Excludes them from the secret match below.
const PUBLIC_PREFIX_RE = /^(?:NEXT_PUBLIC_|NUXT_PUBLIC_|VITE_|REACT_APP_|VUE_APP_|EXPO_PUBLIC_|GATSBY_|STORYBOOK_|PUBLIC_)/;
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
    // Wildcard sweep: the exact-name list covers the common loader vars but
    // the DYLD_/LD_ families have many siblings (DYLD_FRAMEWORK_PATH,
    // DYLD_FALLBACK_LIBRARY_PATH, LD_AUDIT, LD_BIND_NOW, …). Delete every
    // key under those prefixes so a new variant doesn't sneak through.
    for (const k of Object.keys(env)) {
        if (/^DYLD_/.test(k) || /^LD_/.test(k)) delete env[k];
    }
    return env;
}

// R5: strip provider/cloud/secret-family keys from a spawn env in place.
// Shared by bash-session, shell-jobs, shell-snapshot, and bash-tool so
// the prefix/suffix lists never drift across spawn sites. PATH is not
// matched by any family here and is preserved.
export function scrubProviderSecrets(env) {
    if (!env || typeof env !== 'object') return env;
    for (const k of Object.keys(env)) {
        if (!PUBLIC_PREFIX_RE.test(k) && (SECRET_EXACT.has(k) || SECRET_SUFFIX_RE.test(k))) {
            delete env[k];
        }
    }
    return env;
}
