// The credential / secret file deny list of the runtime's attachment
// hand-offs between bots and agents (session-runtime/handoff-attachments.mjs):
// an automatic transfer never carries a secret-bearing file. A paired device
// is the user's own and gets no such list (it opens what the desktop opens).
//
// Matching is on SEGMENTS of a path, lower-cased on every platform, so a
// denied name cannot hide behind letter case, trailing dots/spaces or an NTFS
// stream suffix. Callers pass the canonical (realpath) form as well as the
// lexical one, so a link cannot reach a denied place under an innocent name.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** A directory with this name anywhere on the path holds credentials. `.git`
 *  is one of them: its config carries remotes with embedded tokens and
 *  credential helpers, and its objects hold every secret ever committed. */
const SECRET_DIRECTORIES = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.mozilla',
  '.password-store',
  '.git',
]);

/** Consecutive segments anywhere on the path that name a credential store:
 *  CLI configs, browser profiles and OS credential stores. */
const SECRET_SEQUENCES = [
  // Tool credentials in the user's home.
  ['.docker', 'config.json'],
  ['.config', 'gcloud'],
  ['appdata', 'roaming', 'gcloud'],
  ['.config', 'gh'],
  ['appdata', 'roaming', 'github cli'],
  ['.config', 'git', 'credentials'],
  ['.cargo', 'credentials'],
  ['.cargo', 'credentials.toml'],
  ['.terraform.d', 'credentials.tfrc.json'],
  ['.claude', '.credentials.json'],
  ['.codex', 'auth.json'],
  ['.gemini', 'oauth_creds.json'],
  // Browser profiles: cookies, saved logins, session tokens.
  ['google', 'chrome', 'user data'],
  ['microsoft', 'edge', 'user data'],
  ['bravesoftware', 'brave-browser'],
  ['chromium', 'user data'],
  ['vivaldi', 'user data'],
  ['opera software'],
  ['mozilla', 'firefox'],
  ['application support', 'google', 'chrome'],
  ['application support', 'microsoft edge'],
  ['application support', 'firefox'],
  ['application support', 'chromium'],
  ['application support', 'bravesoftware'],
  ['application support', 'vivaldi'],
  ['library', 'safari'],
  ['library', 'cookies'],
  ['.config', 'google-chrome'],
  ['.config', 'chromium'],
  ['.config', 'microsoft-edge'],
  ['.config', 'bravesoftware'],
  ['.config', 'vivaldi'],
  ['snap', 'firefox'],
  ['snap', 'chromium'],
  ['.var', 'app', 'org.mozilla.firefox'],
  ['.var', 'app', 'com.google.chrome'],
  // OS credential stores.
  ['microsoft', 'credentials'],
  ['microsoft', 'protect'],
  ['microsoft', 'vault'],
  ['windows', 'system32', 'config'],
  ['library', 'keychains'],
  ['.local', 'share', 'keyrings'],
  ['.local', 'share', 'kwalletd'],
  ['etc', 'shadow'],
  ['etc', 'gshadow'],
  ['etc', 'ssh'],
  ['etc', 'ssl', 'private'],
];

const KEY_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.p8',
  '.ppk',
  '.jks',
  '.keystore',
  '.kdbx',
  '.keychain',
  '.keychain-db',
]);
const CREDENTIAL_FILES = new Set([
  '.netrc',
  '_netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.pgpass',
  '.vault-token',
  '.htpasswd',
  '.dockercfg',
  '.envrc',
  '.s3cfg',
  'kubeconfig',
]);
/** Environment files: every `.env*` name (`.env`, `.env.local`, `.envrc`,
 *  `.environment`, and the `.env.example` templates too — a template is
 *  checked in often enough with real values that no name is exempt) and
 *  `<stage>.env`. */
const ENV_FILE = /^(?:\.env.*|[^.]{1,64}(?:\.[^.]{1,64}){0,3}\.env)$/;
/** Credential JSON a cloud or OAuth client writes or downloads:
 *  `credentials.json`, `*credentials*.json`, `service-account*.json`,
 *  `client_secret*.json`. */
const CREDENTIAL_JSON = /^(?:.*credential.*|service[-_ ]?account.*|client[-_]?secret.*)\.json$/;
/** OpenSSH private keys (`id_ed25519`, `id_rsa_work`, `id_ecdsa_sk`, any
 *  `id_<type>`): no extension, so the public `.pub` half and documents named
 *  after a key type (`id_rsa_notes.md`) are not keys. */
const SSH_PRIVATE_KEY = /^id_[a-z0-9]{2,16}(?:[_-][^._-]{1,32}){0,3}$/;
/** A copy an editor or tool leaves beside a file (`x.bak`, `x.old`, `x~`,
 *  `x.1`): it holds what the original holds. */
const BACKUP_SUFFIX = /(?:\.(?:bak|backup|old|orig|prev|save|sav|swp|swo|tmp|copy|\d{1,3})|~)$/;
const MAX_BACKUP_SUFFIXES = 3;

/** The name a backup copy was made of (`.npmrc.bak.1` → `.npmrc`). */
function backupOriginal(name) {
  let original = name;
  for (let strip = 0; strip < MAX_BACKUP_SUFFIXES; strip += 1) {
    const next = original.replace(BACKUP_SUFFIX, '');
    if (next === original || !next) break;
    original = next;
  }
  return original;
}

/** A file whose own name says it holds a secret, wherever it lives: a
 *  credential file, a dotenv file, a key or keystore, or a backup of one. */
function secretFileName(name) {
  const original = backupOriginal(name);
  if (CREDENTIAL_FILES.has(original) || CREDENTIAL_JSON.test(original) || ENV_FILE.test(original)) return true;
  const dot = original.lastIndexOf('.');
  if (dot >= 0 && KEY_EXTENSIONS.has(original.slice(dot))) return true;
  return SSH_PRIVATE_KEY.test(original);
}

// Mixdog's own state. Its home and data folders also hold what tools write
// (tool results, shell output, media), which stay reachable; only the files
// and folders that carry provider tokens, API keys, pairing and bridge secrets
// are denied.
const MIXDOG_SECRET_DIRECTORIES = new Set([
  'secrets',
  'mcp-oauth',
  'provider-accounts',
  'telegram',
  'relay-data',
  'dev-profile',
]);
const MIXDOG_SECRET_FILE =
  /^\.?(mixdog-config|provider-accounts|relay-hook-device|auth\.json|[a-z0-9-]+-oauth(-credentials)?\.json|[a-z0-9-]+-bridge\.json)/;
const MIXDOG_SECRET_EXTENSIONS = new Set(['.dpapi', '.token']);

function mixdogSecret(rest) {
  if (rest.some((segment) => MIXDOG_SECRET_DIRECTORIES.has(segment))) return true;
  const name = rest[rest.length - 1] ?? '';
  const dot = name.lastIndexOf('.');
  return MIXDOG_SECRET_FILE.test(name) || MIXDOG_SECRET_EXTENSIONS.has(dot >= 0 ? name.slice(dot) : '');
}

/** The segments of a path as the rules compare them: no extended-path prefix,
 *  no NTFS stream suffix, no trailing dots or spaces, lower case. */
function sensitivePathSegments(path) {
  return String(path)
    .replace(/^[\\/]{2}[?.][\\/]/, '')
    .split(/[\\/]+/)
    .map((segment) =>
      segment
        .split(':')[0]
        .replace(/[. ]+$/, '')
        .toLowerCase()
    )
    .filter(Boolean);
}

function hasRun(segments, run) {
  for (let start = 0; start + run.length <= segments.length; start += 1) {
    if (run.every((segment, offset) => segments[start + offset] === segment)) return true;
  }
  return false;
}

/**
 * Whether `path` is denied under `within`: scopes `{ root: segments }` —
 * Mixdog's home and data folders, where only their secret subset is denied.
 * Pass both the lexical and canonical form.
 */
export function matchesSensitivePath(path, within = []) {
  const segments = sensitivePathSegments(resolve(path));
  const name = segments[segments.length - 1] ?? '';
  if (segments.some((segment) => SECRET_DIRECTORIES.has(segment))) return true;
  if (secretFileName(name) || SECRET_SEQUENCES.some((run) => hasRun(segments, run))) return true;
  return within.some(
    ({ root }) =>
      root.length > 0 &&
      root.every((segment, index) => segments[index] === segment) &&
      mixdogSecret(segments.slice(root.length))
  );
}

function realOrSelf(path) {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realOrSelf(parent), path.slice(parent.length).replace(/^[\\/]+/, ''));
  }
}

/** Mixdog's home and data folders (MIXDOG_HOME / MIXDOG_DATA_DIR, plus any
 *  extra data folder the caller names) as `matchesSensitivePath` scopes. */
export function mixdogSensitiveScopes(extraData = []) {
  const home = process.env.MIXDOG_HOME || join(homedir(), '.mixdog');
  const roots = [home, process.env.MIXDOG_DATA_DIR || join(home, 'data'), ...extraData].filter(Boolean);
  const scopes = [];
  for (const root of roots) {
    for (const form of new Set([resolve(root), realOrSelf(resolve(root))])) {
      scopes.push({ root: sensitivePathSegments(form) });
    }
  }
  return scopes;
}

/** Whether `path` — its own name or what its links lead to — is a
 *  credential/secret file under the shared deny list and Mixdog's own scopes. */
export function isSensitiveLocalPath(path, { extraData = [] } = {}) {
  const within = mixdogSensitiveScopes(extraData);
  const absolute = resolve(path);
  return matchesSensitivePath(absolute, within) || matchesSensitivePath(realOrSelf(absolute), within);
}
