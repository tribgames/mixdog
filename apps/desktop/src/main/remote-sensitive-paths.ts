// The hard deny every remote (paired-device) file lane applies, whatever the
// provenance: a registered project, a reply's link or a tool row's path never
// makes a secret-bearing file reachable. One rule, enforced where the lanes
// resolve a path (remote-methods, remote-file-preview, remote-local-page,
// remote-visualize, file-downloads incl. folder zips).
//
// Matching is on SEGMENTS of the canonical (realpath) path, lower-cased on
// every platform, so a link or junction cannot reach a denied place under an
// innocent name, and a denied name cannot hide behind letter case, trailing
// dots/spaces or an NTFS stream suffix. Callers pass the canonical path;
// `isSensitivePath` / `assertNotSensitive` canonicalize (through the nearest
// existing ancestor for a file that is not there yet) and also test the
// lexical name.
import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { LocalAccessDeniedError } from './local-access-denied';

export const SENSITIVE_PATH_MESSAGE =
  'This file can hold credentials or secrets, so it cannot be accessed from a remote device.';

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
const SECRET_SEQUENCES: readonly (readonly string[])[] = [
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
/** Dotenv files: `.env`, `.env.<stage>[.<more>]` and `<stage>.env`. */
const ENV_FILE = /^(?:\.env(?:\.[^.]{1,64}){0,4}|[^.]{1,64}(?:\.[^.]{1,64}){0,3}\.env)$/;
/** The exact dotenv templates checked in on purpose; they hold no secrets.
 *  Nothing else is exempt, whatever it ends with. */
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist']);
/** OpenSSH private keys (`id_ed25519`, `id_rsa_work`, `id_ecdsa_sk`): no
 *  extension, so the public `.pub` half and documents named after a key
 *  type (`id_rsa_notes.md`) are not keys. */
const SSH_PRIVATE_KEY = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:[_-][^._-]{1,32}){0,2}$/;
/** A copy an editor or tool leaves beside a file (`x.bak`, `x.old`, `x~`,
 *  `x.1`): it holds what the original holds. */
const BACKUP_SUFFIX = /(?:\.(?:bak|backup|old|orig|prev|save|sav|swp|swo|tmp|copy|\d{1,3})|~)$/;
const MAX_BACKUP_SUFFIXES = 3;

/** The name a backup copy was made of (`.npmrc.bak.1` → `.npmrc`). */
function backupOriginal(name: string): string {
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
function secretFileName(name: string): boolean {
  const original = backupOriginal(name);
  if (CREDENTIAL_FILES.has(original)) return true;
  if (ENV_FILE.test(original)) return !ENV_TEMPLATES.has(original);
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

function mixdogSecret(rest: readonly string[]): boolean {
  if (rest.some((segment) => MIXDOG_SECRET_DIRECTORIES.has(segment))) return true;
  const name = rest[rest.length - 1] ?? '';
  const dot = name.lastIndexOf('.');
  return MIXDOG_SECRET_FILE.test(name) || MIXDOG_SECRET_EXTENSIONS.has(dot >= 0 ? name.slice(dot) : '');
}

/** Folders the process registers as wholly private (the Electron profile
 *  holds cookies, device and pairing keys), minus the named subfolders. */
const registeredRoots = new Map<string, readonly string[]>();

/** Marks `root` (an app-private folder) as denied except the subfolders named
 *  in `except`. */
export function registerSensitiveRoot(root: string, except: readonly string[] = []): void {
  registeredRoots.set(
    resolve(root),
    except.map((name) => name.toLowerCase())
  );
}

/** The segments of a path as the rules compare them: no extended-path prefix,
 *  no NTFS stream suffix, no trailing dots or spaces, lower case. */
function segmentsOf(path: string): string[] {
  return path
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

function hasRun(segments: readonly string[], run: readonly string[]): boolean {
  for (let start = 0; start + run.length <= segments.length; start += 1) {
    if (run.every((segment, offset) => segments[start + offset] === segment)) return true;
  }
  return false;
}

/** The path with every existing link resolved; the part that does not exist
 *  yet hangs off the nearest existing ancestor. */
async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(await canonicalPath(parent), absolute.slice(parent.length).replace(/^[\\/]+/, ''));
  }
}

// A synchronous lookup is what a snapshot built for the wire can afford, and
// a long transcript names the same few files over and over. The answers are
// kept briefly and the table is capped, so a link re-pointed after it was
// looked up is seen again within seconds and the table cannot grow with the
// transcript.
const REALPATH_CACHE_MAX_ENTRIES = 1_024;
const REALPATH_CACHE_TTL_MS = 5_000;
const realpathCache = new Map<string, { at: number; value: string | null }>();

/** `realpath` of an absolute path, null when it cannot be resolved (gone,
 *  no access, a link loop). */
function cachedRealpath(absolute: string): string | null {
  const now = Date.now();
  const hit = realpathCache.get(absolute);
  if (hit && now - hit.at < REALPATH_CACHE_TTL_MS) return hit.value;
  let value: string | null;
  try {
    value = realpathSync.native(absolute);
  } catch {
    value = null;
  }
  realpathCache.delete(absolute);
  realpathCache.set(absolute, { at: now, value });
  if (realpathCache.size > REALPATH_CACHE_MAX_ENTRIES) {
    realpathCache.delete(realpathCache.keys().next().value as string);
  }
  return value;
}

/** canonicalPath without waiting: the same resolution, through the cache. */
function canonicalPathSync(path: string): string {
  const absolute = resolve(path);
  const real = cachedRealpath(absolute);
  if (real !== null) return real;
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(canonicalPathSync(parent), absolute.slice(parent.length).replace(/^[\\/]+/, ''));
}

interface Scope {
  root: string[];
  /** Subfolders of the root that stay reachable. */
  except: readonly string[];
  /** Whole tree (a registered private root) or Mixdog's secret subset. */
  whole: boolean;
}

/** Everything the deny list knows beyond names, as plain data: Mixdog's home
 *  and data folders and the registered private roots. It is read in the
 *  process that registered them and handed to work done elsewhere (a search
 *  in the operation service), which then needs no state of its own. */
export interface SensitivePolicy {
  home: string;
  data: string;
  registered: Array<[path: string, except: string[]]>;
}

/** This process's policy (registerSensitiveRoot, MIXDOG_HOME, MIXDOG_DATA_DIR). */
export function sensitivePolicy(): SensitivePolicy {
  const home = process.env.MIXDOG_HOME || join(homedir(), '.mixdog');
  return {
    home,
    data: process.env.MIXDOG_DATA_DIR || join(home, 'data'),
    registered: [...registeredRoots].map(([path, except]) => [path, [...except]]),
  };
}

/** A policy received from another process, or a TypeError: a malformed one
 *  never degrades into a deny list without its roots. */
export function requiredSensitivePolicy(value: unknown): SensitivePolicy {
  const policy = value as Partial<SensitivePolicy> | null;
  const text = (entry: unknown): entry is string => typeof entry === 'string' && entry.length > 0;
  if (
    !policy ||
    typeof policy !== 'object' ||
    !text(policy.home) ||
    !text(policy.data) ||
    !Array.isArray(policy.registered) ||
    !policy.registered.every(
      (root) =>
        Array.isArray(root) &&
        root.length === 2 &&
        text(root[0]) &&
        Array.isArray(root[1]) &&
        root[1].every((name) => typeof name === 'string')
    )
  ) {
    throw new TypeError('The sensitive-path policy is invalid.');
  }
  return {
    home: policy.home,
    data: policy.data,
    registered: policy.registered.map(([path, except]) => [path, [...except]]),
  };
}

function scopeRoots(policy: SensitivePolicy): Array<{ path: string; except: readonly string[]; whole: boolean }> {
  return [
    { path: policy.home, except: [], whole: false },
    { path: policy.data, except: [], whole: false },
    ...policy.registered.map(([path, except]) => ({
      path: resolve(path),
      except: except.map((name) => name.toLowerCase()),
      whole: true,
    })),
  ];
}

async function scopes(policy: SensitivePolicy): Promise<Scope[]> {
  const roots = scopeRoots(policy);
  const found: Scope[] = [];
  for (const { path, except, whole } of roots) {
    for (const form of new Set([resolve(path), await canonicalPath(path)])) {
      found.push({ root: segmentsOf(form), except, whole });
    }
  }
  return found;
}

function matches(path: string, within: readonly Scope[]): boolean {
  const segments = segmentsOf(resolve(path));
  const name = segments[segments.length - 1] ?? '';
  if (segments.some((segment) => SECRET_DIRECTORIES.has(segment))) return true;
  if (secretFileName(name) || SECRET_SEQUENCES.some((run) => hasRun(segments, run))) return true;
  const containing = within.filter(
    ({ root }) => root.length > 0 && root.every((segment, index) => segments[index] === segment)
  );
  // Mixdog's home and data folders follow Mixdog's own rule even inside a
  // registered private root: a dev or isolated profile keeps them in the app
  // profile, and the tool output and media there stay reachable.
  const own = containing.filter(({ whole }) => !whole);
  if (own.length) return own.some(({ root }) => mixdogSecret(segments.slice(root.length)));
  return containing.some(({ root, except }) => {
    const rest = segments.slice(root.length);
    return rest.length > 0 && !except.includes(rest[0]);
  });
}

/** A predicate over CANONICAL paths (a folder walk's entries), under
 *  `policy` (this process's by default). Resolve it once per operation; it is
 *  synchronous afterwards. */
export async function sensitivePathMatcher(
  policy: SensitivePolicy = sensitivePolicy()
): Promise<(canonicalPath: string) => boolean> {
  const within = await scopes(policy);
  return (path) => matches(path, within);
}

/** The synchronous form of isSensitivePath, for callers that cannot await (a
 *  snapshot built for the wire): the path's own name and what its links lead
 *  to, under this process's policy. The links are resolved with a cached,
 *  bounded `realpath`; a path that cannot be resolved (deleted since) is
 *  judged by its own name and its nearest existing ancestor. */
export function isSensitivePathSync(path: string): boolean {
  const within = scopeRoots(sensitivePolicy()).flatMap(({ path: root, except, whole }) =>
    [...new Set([resolve(root), canonicalPathSync(root)])].map((form) => ({ root: segmentsOf(form), except, whole }))
  );
  return matches(path, within) || matches(canonicalPathSync(path), within);
}

/** A check of any path — its own name and what its links lead to — under
 *  this process's policy, resolved once for every path it is asked about. */
async function sensitivePathCheck(): Promise<(path: string) => Promise<boolean>> {
  const denied = await sensitivePathMatcher();
  return async (path) => denied(path) || denied(await canonicalPath(path));
}

/** Whether `path` — its own name or what its links lead to — is denied. */
export async function isSensitivePath(path: string): Promise<boolean> {
  return (await sensitivePathCheck())(path);
}

/** Refuses a denied path with the same explicit denial the other remote file
 *  lanes raise. */
export async function assertNotSensitive(path: string): Promise<void> {
  await assertNoneSensitive([path]);
}

/** assertNotSensitive for many paths, the policy resolved once. */
export async function assertNoneSensitive(paths: readonly string[]): Promise<void> {
  const denied = await sensitivePathCheck();
  for (const path of paths) {
    if (await denied(path)) throw new LocalAccessDeniedError(SENSITIVE_PATH_MESSAGE);
  }
}

export const DIFF_SECTION = /^diff --(?:git|cc|combined) /;
const DIFF_PATH_LINE = /^(?:--- |\+\+\+ |rename from |rename to |copy from |copy to )(.+)$/;

/** A path as git writes it in a diff header: C-quoted when it has special
 *  characters (octal UTF-8 bytes included); null when it cannot be read. */
function diffHeaderPath(raw: string): string | null {
  const text = raw.replace(/\t$/, '');
  if (!text.startsWith('"')) return text;
  if (!text.endsWith('"') || text.length < 2) return null;
  const bytes: number[] = [];
  const body = text.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = body[index + 1] ?? '';
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1))?.[0];
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
      continue;
    }
    const escaped = { n: '\n', t: '\t', '"': '"', '\\': '\\', a: '\x07', b: '\b', f: '\f', r: '\r', v: '\v' }[next];
    if (escaped === undefined) return null;
    bytes.push(escaped.charCodeAt(0));
    index += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The paths one file section of a diff names (each also without its `a/`
 *  or `b/` prefix); null when its header cannot be read. */
export function diffSectionPaths(section: readonly string[]): string[] | null {
  const paths: string[] = [];
  const add = (raw: string): boolean => {
    const path = diffHeaderPath(raw);
    if (path === null) return false;
    if (path !== '/dev/null') paths.push(path, path.replace(/^[ab]\//, ''));
    return true;
  };
  for (const line of section.slice(1)) {
    // Header lines end at the first hunk; a removed `-- x` line is content.
    if (line.startsWith('@@')) break;
    const match = DIFF_PATH_LINE.exec(line);
    if (match && !add(match[1])) return null;
  }
  // `diff --git a/P b/P`: the only names a new, deleted or mode-only file
  // section without `---`/`+++` lines carries.
  const header = section[0].replace(DIFF_SECTION, '');
  if (header.startsWith('"')) {
    const split = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|\S.*)$/.exec(header);
    if (!split || !add(split[1]) || !add(split[2])) return paths.length ? paths : null;
  } else {
    const half = (header.length - 1) / 2;
    if (Number.isInteger(half) && header[half] === ' ') {
      add(header.slice(0, half));
      add(header.slice(half + 1));
    } else if (!paths.length) {
      return null;
    }
  }
  return paths;
}

const DIFF_TEXT = /(?:^|\n)diff --(?:git|cc|combined) /;
const REVIEW_DEPTH = 8;

/** A turn or session review answer (getTurnReviewDiff, getTurnChanges, the
 *  file-patch reads) without what it shows of denied files: every listed file
 *  entry whose `path` or `oldPath` is denied is dropped, every diff text loses
 *  those files' sections, and a single-file answer for a denied file keeps no
 *  patch. Relative paths are judged against the nearest `root` the answer
 *  names, else `base`. */
export async function withoutSensitiveReviewFiles(value: unknown, base: string): Promise<unknown> {
  const denied = await sensitivePathCheck();
  const deniedPath = async (root: string, path: unknown): Promise<boolean> =>
    typeof path === 'string' && path !== '' && (await denied(resolve(root, path)));
  const namesDenied = async (root: string, entry: Record<string, unknown>): Promise<boolean> =>
    (await deniedPath(root, entry.path)) || (await deniedPath(root, entry.oldPath));
  const visit = async (node: unknown, root: string, depth: number): Promise<unknown> => {
    if (typeof node === 'string') return DIFF_TEXT.test(node) ? withoutSensitiveDiffSections(node, root) : node;
    if (!node || typeof node !== 'object') return node;
    // Nothing a review nests this deep: left out rather than unread.
    if (depth > REVIEW_DEPTH) return null;
    if (Array.isArray(node)) {
      const kept: unknown[] = [];
      for (const entry of node) {
        const record =
          entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
        if (record && (await namesDenied(root, record))) continue;
        kept.push(await visit(entry, root, depth + 1));
      }
      return kept;
    }
    const record = node as Record<string, unknown>;
    const scope = typeof record.root === 'string' && record.root ? resolve(root, record.root) : root;
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(record)) out[key] = await visit(field, scope, depth + 1);
    if (typeof out.patch === 'string' && (await namesDenied(scope, record))) out.patch = '';
    return out;
  };
  return visit(value, base, 0);
}

/** `patch` (git diff output) without the file sections that name a denied
 *  path, judged relative to `base`; a section whose names cannot be read is
 *  left out too. Everything before the first section is kept. */
export async function withoutSensitiveDiffSections(patch: string, base: string): Promise<string> {
  if (typeof patch !== 'string' || !patch) return patch;
  const sections: string[][] = [[]];
  for (const line of patch.split('\n')) {
    if (DIFF_SECTION.test(line)) sections.push([line]);
    else sections[sections.length - 1].push(line);
  }
  const denied = await sensitivePathCheck();
  const deniedPath = (path: string): Promise<boolean> => denied(resolve(base, path));
  const kept = [sections[0]];
  for (const section of sections.slice(1)) {
    const paths = diffSectionPaths(section);
    if (!paths) continue;
    if (!(await Promise.all(paths.map(deniedPath))).includes(true)) kept.push(section);
  }
  return kept.flat().join('\n');
}
