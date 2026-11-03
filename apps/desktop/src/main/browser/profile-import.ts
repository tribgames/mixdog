import { createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { app, safeStorage, type Session } from 'electron';
import type { BrowserCookieJar } from './cookie-jar';
import { clearPendingPauses, readVaultFile } from './credential-vault-file';
import { CredentialVault, maskedCredentialLabel, secureOrigin } from './credential-vault';
import {
  NATIVE_FAILURE,
  nativeBrowserImporterPath,
  resolvePackagedBrowserImporter,
  type NativeBrowserImporter,
} from './profile-import-native';
import {
  CookieImportError,
  importBrowserCookies,
  parseBrowserCookieReport,
  type NativeAppBoundKey,
} from './profile-import-cookies';
import {
  APP_BOUND_KEY_FILE,
  AppBoundKeyStore,
  SavedKeyUnavailableError,
  base64Bytes,
  readAppBoundBlobSha256,
  type KeyEncryption,
} from './profile-import-key';
import { CookieAutoImportStateStore, type AutoCookieImportOutcome } from './profile-import-auto';
import { type BrowserHistoryEntry, importChromeHistory } from './profile-import-history';
import { requireSensitiveImportApproval } from './profile-import-approval';
export type { BrowserImportCookie } from './profile-import-cookies';
export type { BrowserHistoryEntry } from './profile-import-history';

const CHROME_SOURCE_ID = 'chrome';
const HISTORY_SEARCH_LIMIT = 12;
const NATIVE_OUTPUT_LIMIT = 64 * 1024 * 1024;
const NATIVE_IMPORT_TIMEOUT_MS = 120_000;
const CHROME_CLOSE_TIMEOUT_MS = 30_000;
const CAPABILITY_PROBE_TIMEOUT_MS = 5_000;
/** Automatic runs back the cookie jar up like any import; only this many of their snapshots are kept. */
const AUTOMATIC_BACKUPS_KEPT = 3;
const AUTOMATIC_JOB_ID = 'automatic-cookie-import';
const AUTO_STATE_FILE = 'browser-cookie-auto-import.json';
const execFileAsync = promisify(execFile);
const unsealVault = (sealed: Buffer): string => safeStorage.decryptString(sealed);

type BrowserImportItem = 'passwords' | 'cookies' | 'history';
type BrowserImportItemState = 'running' | 'completed' | 'failed';

interface BrowserImportProfile {
  id: string;
  name: string;
  accountEmail?: string;
}

export interface BrowserImportSource {
  id: string;
  name: string;
  profiles: BrowserImportProfile[];
  supports: Record<BrowserImportItem, boolean>;
  supportReasons?: Partial<Record<BrowserImportItem, string>>;
  passwordSupportReason?: string;
}

export interface BrowserImportRequest {
  jobId: string;
  sourceId: string;
  profileId: string;
  items: BrowserImportItem[];
  administratorApproved: boolean;
}

export interface BrowserImportProgress {
  jobId: string;
  item: BrowserImportItem;
  state: BrowserImportItemState;
  count?: number;
  error?: string;
}

export interface BrowserImportResult {
  jobId: string;
  counts: Record<BrowserImportItem, number>;
  errors: Partial<Record<BrowserImportItem, string>>;
}

export interface BrowserCredentialSuggestion {
  id: string;
  label: string;
}

export interface BrowserCredentialValue {
  username: string;
  password: string;
}

interface StoredBrowserCredential extends BrowserCredentialValue {
  id: string;
  url: string;
  note: string;
}

interface ChromeProfileCacheEntry {
  name?: unknown;
  user_name?: unknown;
}

interface ChromeLocalState {
  profile?: {
    info_cache?: Record<string, ChromeProfileCacheEntry>;
  };
}

interface NativeCredential {
  url?: unknown;
  username?: unknown;
  password?: unknown;
  note?: unknown;
  /** Chrome's last use of the login (ms since the Unix epoch); absent from an older importer. */
  lastUsedAt?: unknown;
}

interface BrowserProfileImportOptions {
  userDataDirectory: string;
  temporaryDirectory: string;
  partition: Session;
  cookieJar?: BrowserCookieJar;
  nativeImporterPath?: string;
  chromeExecutablePath?: string;
  chromeUserDataDirectory?: string;
  prepareChromeForImport?: () => Promise<void>;
  readNativeCredentials?: (profileId: string) => Promise<NativeCredential[]>;
  readNativeCookies?: (profileId: string, route: NativeCookieRoute) => Promise<unknown>;
  /** Test seam: the native importer to run instead of the packaged one. */
  nativeImporterOverride?: NativeBrowserImporter;
  /** Test seam: OS encryption for the saved Chrome key; defaults to `safeStorage`. */
  keyEncryption?: KeyEncryption;
}

/** How one native cookie import may obtain Chrome's App-Bound key. */
export interface NativeCookieRoute {
  /** The saved key, sent over stdin so the elevated helper is not needed. Wiped after the call. */
  savedKey?: Buffer;
  /** Whether the elevated helper (a UAC prompt) may run. Automatic runs never allow it. */
  allowElevation: boolean;
  /** Ask the importer to hand back a freshly unwrapped key to keep. */
  returnKey: boolean;
}

interface BrowserProcessCloseTarget {
  imageName: string;
  timeoutMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanError(error: unknown): string {
  return errorMessage(error)
    .replace(/[A-Za-z]:\\[^\r\n"]+/g, '[local path]')
    .slice(0, 600);
}

function uniqueItems(items: BrowserImportItem[]): BrowserImportItem[] {
  const allowed = new Set<BrowserImportItem>(['passwords', 'cookies', 'history']);
  return [...new Set(items)].filter((item) => allowed.has(item));
}

function chromeExecutableCandidates(explicit?: string): string[] {
  const local = String(process.env.LOCALAPPDATA || '');
  const programFiles = String(process.env.ProgramFiles || '');
  const programFilesX86 = String(process.env['ProgramFiles(x86)'] || '');
  return [
    explicit || '',
    local && join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    programFiles && join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    programFilesX86 && join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
}

/** `tasklist` lists processes in well under a second; this only bounds a hang. */
const TASKLIST_TIMEOUT_MS = 5_000;
/** One PowerShell start (Add-Type compile) plus the WM_CLOSE posts. */
const CLOSE_REQUEST_TIMEOUT_MS = 10_000;
/** How often the wait for Chrome to exit re-lists its processes. */
const CHROME_EXIT_POLL_MS = 200;

function chromeUserDataDirectory(): string {
  const local = String(process.env.LOCALAPPDATA || '');
  if (!local) throw new Error('Chrome profile location is unavailable on this Windows account.');
  return join(local, 'Google', 'Chrome', 'User Data');
}

async function browserProcessIds(tasklist: string, imageName: string): Promise<number[]> {
  const { stdout } = await execFileAsync(tasklist, ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'], {
    windowsHide: true,
    timeout: TASKLIST_TIMEOUT_MS,
    maxBuffer: 256 * 1024,
  });
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.toLowerCase().startsWith(`"${imageName.toLowerCase()}","`))
    .map((line) => Number(line.match(/^"[^"]+","(\d+)"/)?.[1]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

export async function prepareChromeForImport(
  target: BrowserProcessCloseTarget = {
    imageName: 'chrome.exe',
  }
): Promise<void> {
  if (process.platform !== 'win32') return;
  if (!/^[a-zA-Z0-9._-]{1,120}\.exe$/i.test(target.imageName)) {
    throw new Error('Browser process identity is invalid.');
  }
  const systemRoot = String(process.env.SystemRoot || 'C:\\Windows');
  const tasklist = join(systemRoot, 'System32', 'tasklist.exe');
  const initialProcessIds = await browserProcessIds(tasklist, target.imageName);
  if (!initialProcessIds.length) return;
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const closeScript = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class MixdogBrowserWindowClose {
  private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", SetLastError = true)] private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  public static int Close(uint[] processIds) {
    var allowed = new HashSet<uint>(processIds);
    var closed = 0;
    EnumWindows((hwnd, ignored) => {
      uint processId;
      GetWindowThreadProcessId(hwnd, out processId);
      if (allowed.Contains(processId) && PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero)) {
        closed += 1;
      }
      return true;
    }, IntPtr.Zero);
    return closed;
  }
}
'@
$processIds = [uint32[]](ConvertFrom-Json -InputObject $env:MIXDOG_BROWSER_IMPORT_PROCESS_IDS)
[MixdogBrowserWindowClose]::Close($processIds) | Out-Null
`;
  let closeRequestFailed = false;
  try {
    await execFileAsync(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', closeScript],
      {
        windowsHide: true,
        timeout: CLOSE_REQUEST_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
        env: {
          ...process.env,
          MIXDOG_BROWSER_IMPORT_PROCESS_IDS: JSON.stringify(initialProcessIds),
        },
      }
    );
  } catch {
    closeRequestFailed = true;
    // A process can disappear while its top-level windows are enumerated. The
    // bounded wait below is the source of truth and never force-terminates it.
  }
  const deadline = Date.now() + Math.max(1_000, Math.min(120_000, target.timeoutMs ?? CHROME_CLOSE_TIMEOUT_MS));
  while (Date.now() < deadline) {
    if (!(await browserProcessIds(tasklist, target.imageName)).length) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, CHROME_EXIT_POLL_MS));
  }
  if (closeRequestFailed) {
    throw new Error('Browser close request failed.');
  }
  throw new Error('Google Chrome이 정상 종료되지 않아 가져오기를 중단했습니다. 열린 작업을 확인한 뒤 다시 시도하세요.');
}

/** Whether any Chrome process is alive (while one is, it holds the Cookies
 *  database). One short `tasklist` call, cheap enough to poll every few minutes. */
export async function isChromeRunning(imageName = 'chrome.exe'): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const tasklist = join(String(process.env.SystemRoot || 'C:\\Windows'), 'System32', 'tasklist.exe');
  return (await browserProcessIds(tasklist, imageName)).length > 0;
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function exactProfileDirectory(userDataDirectory: string, profileId: string): string {
  if (!profileId || basename(profileId) !== profileId || /[\\/]/.test(profileId)) {
    throw new Error('Chrome profile id is invalid.');
  }
  const root = resolve(userDataDirectory);
  const target = resolve(root, profileId);
  if (target === root || !target.startsWith(`${root}${sep}`)) {
    throw new Error('Chrome profile escaped its user-data directory.');
  }
  return target;
}

function exactTemporaryJob(root: string, jobId: string): string {
  if (!/^[a-zA-Z0-9_-]{8,120}$/.test(jobId)) throw new Error('Import job id is invalid.');
  const base = resolve(root, 'mixdog-browser-import');
  const target = resolve(base, `job-${jobId}`);
  if (!target.startsWith(`${base}${sep}`)) throw new Error('Import job escaped its temporary root.');
  return target;
}

/** Runs the child with `input` on stdin. Settles on the child's `close` (the
 *  process has exited and its stdio is drained), never on `exit`, which can
 *  fire while stdout still holds unread data. A spawn that throws synchronously
 *  rejects this promise like any other failure. */
async function runNativeChild(
  executable: string,
  args: string[],
  input: Buffer
): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer; stdoutBytes: number }> {
  const child = spawn(executable, args, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise<number>((resolveClose, rejectClose) => {
    const timer = setTimeout(() => {
      child.kill();
      rejectClose(new Error('Native browser importer timed out.'));
    }, NATIVE_IMPORT_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectClose(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveClose(code ?? 1);
    });
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > NATIVE_OUTPUT_LIMIT) {
      child.kill();
      return;
    }
    stdout.push(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= 16_384) stderr.push(chunk);
  });
  child.stdin?.end(input);
  const exitCode = await closed;
  return { exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), stdoutBytes };
}

/** `createTransportKey` is a test seam: the default is the production key.
 *  `savedKey` (the Chrome v20 key, with `--v20-key-stdin`) follows the
 *  transport key on a second stdin line: never in arguments or the environment. */
export async function readEncryptedChildJson(
  executable: string,
  args: string[],
  expectedSha256: string,
  createTransportKey: () => Buffer = () => randomBytes(32),
  savedKey?: Buffer
): Promise<unknown> {
  if ((await sha256File(executable)) !== expectedSha256) {
    throw new Error('Native browser importer changed after signature verification.');
  }
  const transportKey = createTransportKey();
  try {
    // Built from bytes, not strings, so every copy of the keys can be wiped.
    const encodedTransport = base64Bytes(transportKey);
    const encodedSaved = savedKey ? base64Bytes(savedKey) : Buffer.alloc(0);
    const input = savedKey ? Buffer.concat([encodedTransport, Buffer.from('\n'), encodedSaved]) : encodedTransport;
    let child: Awaited<ReturnType<typeof runNativeChild>>;
    try {
      child = await runNativeChild(executable, args, input);
    } finally {
      input.fill(0);
      encodedTransport.fill(0);
      encodedSaved.fill(0);
    }
    if (child.stdoutBytes > NATIVE_OUTPUT_LIMIT) throw new Error('Native browser importer returned too much data.');
    if (child.exitCode !== 0) {
      throw new Error(
        child.stderr.toString('utf8').trim() || `Native browser importer exited with code ${child.exitCode}.`
      );
    }
    const envelope = JSON.parse(child.stdout.toString('utf8')) as Record<string, unknown>;
    if (envelope.version !== 1) throw new Error('Native password importer returned an invalid envelope.');
    const nonce = Buffer.from(String(envelope.nonce || ''), 'base64');
    const sealed = Buffer.from(String(envelope.ciphertext || ''), 'base64');
    if (nonce.length !== 12 || sealed.length < 16) {
      throw new Error('Native password importer returned an invalid envelope.');
    }
    const ciphertext = sealed.subarray(0, sealed.length - 16);
    const authTag = sealed.subarray(sealed.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', transportKey, nonce);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    try {
      return JSON.parse(plaintext.toString('utf8'));
    } finally {
      plaintext.fill(0);
    }
  } finally {
    transportKey.fill(0);
  }
}

export class BrowserProfileImportService {
  private readonly historyFile: string;
  private readonly keyStore: AppBoundKeyStore;
  private readonly autoState: CookieAutoImportStateStore;
  private readonly keyReuseSupport = new Map<string, boolean>();
  private activeJobId = '';

  constructor(private readonly options: BrowserProfileImportOptions) {
    this.historyFile = join(options.userDataDirectory, 'browser-imported-history.json');
    this.keyStore = new AppBoundKeyStore(
      join(options.userDataDirectory, APP_BOUND_KEY_FILE),
      options.keyEncryption ?? safeStorage
    );
    this.autoState = new CookieAutoImportStateStore(join(options.userDataDirectory, AUTO_STATE_FILE));
  }

  /** The record of the latest automatic/manual cookie imports (no secrets). */
  get cookieAutoImportState(): CookieAutoImportStateStore {
    return this.autoState;
  }

  /** Whether a Chrome key is saved for Chrome's current key, and whether the OS can protect one. */
  async savedKeyStatus(): Promise<{ available: boolean; saved: boolean }> {
    const available = this.keyStore.available();
    const blob = await this.currentKeyBinding();
    const key = available && blob ? await this.keyStore.load(blob) : null;
    key?.fill(0);
    return { available, saved: key !== null };
  }

  /** The hash a saved key must be bound to now: Chrome's current `app_bound_encrypted_key`.
   *  Undefined when Chrome has none (older Chrome) or its Local State is not readable. */
  private async currentKeyBinding(): Promise<string | undefined> {
    try {
      return await readAppBoundBlobSha256(join(this.chromeUserData(), 'Local State'));
    } catch {
      // This account has no Chrome profile location: nothing to match a key against.
      return undefined;
    }
  }

  async forgetSavedKey(): Promise<void> {
    await this.keyStore.forget();
  }

  /** Delete everything an import copied out of Chrome: the password vault,
   *  the history list and the backups of cookies an import replaced. */
  async clearImportedData(): Promise<void> {
    if (this.activeJobId) throw new Error('A browser import is running; clear its data after it finishes.');
    const root = this.options.userDataDirectory;
    // The vault's last-good copy and any damaged copy kept aside hold the same passwords.
    // Only a missing directory is empty; any other failure must not report the copies as gone.
    const entries = await readdir(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const vaultCopies = entries.filter(
      (name) => name === 'browser-password-vault.bin.bak' || name.startsWith('browser-password-vault.bin.corrupt-')
    );
    await Promise.all([
      rm(join(root, 'browser-password-vault.bin'), { force: true }),
      clearPendingPauses(join(root, 'browser-password-vault.bin')),
      ...vaultCopies.map((name) => rm(join(root, name), { force: true })),
      rm(this.historyFile, { force: true }),
      rm(join(root, 'browser-import-backups'), { recursive: true, force: true }),
      // The saved Chrome key is imported data too; the import record goes with it.
      this.keyStore.forget(),
      this.autoState.clear(),
    ]);
  }

  private chromeUserData(): string {
    return this.options.chromeUserDataDirectory || chromeUserDataDirectory();
  }

  private async nativeImporter(item: 'passwords' | 'cookies'): Promise<NativeBrowserImporter | undefined> {
    if (this.options.nativeImporterOverride) return this.options.nativeImporterOverride;
    if (
      (item === 'passwords' && this.options.readNativeCredentials) ||
      (item === 'cookies' && this.options.readNativeCookies)
    ) {
      return { executable: '[test seam]', sha256: '' };
    }
    return await resolvePackagedBrowserImporter({
      isPackaged: app.isPackaged,
      platform: process.platform,
      resourcesPath: process.resourcesPath,
      requestedPath: this.options.nativeImporterPath,
    });
  }

  async sources(): Promise<BrowserImportSource[]> {
    if (process.platform !== 'win32') return [];
    const chromeExecutable = chromeExecutableCandidates(this.options.chromeExecutablePath).find((candidate) =>
      existsSync(candidate)
    );
    const userData = this.chromeUserData();
    const localStatePath = join(userData, 'Local State');
    if (!chromeExecutable || !existsSync(localStatePath)) return [];
    const localState = JSON.parse(await readFile(localStatePath, 'utf8')) as ChromeLocalState;
    const profiles = Object.entries(localState.profile?.info_cache || {})
      .filter(([profileId]) => {
        try {
          return existsSync(exactProfileDirectory(userData, profileId));
        } catch {
          return false;
        }
      })
      .map(([profileId, value]) => ({
        id: profileId,
        name: String(value?.name || profileId).trim() || profileId,
        ...(String(value?.user_name || '').trim() ? { accountEmail: String(value?.user_name || '').trim() } : {}),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (!profiles.length) return [];
    const [passwordImporter, cookieImporter] = await Promise.all([
      this.nativeImporter('passwords'),
      this.nativeImporter('cookies'),
    ]);
    const passwordSupport = Boolean(passwordImporter && safeStorage.isEncryptionAvailable());
    const cookieSupport = Boolean(cookieImporter);
    let passwordSupportReason: string | undefined;
    if (!passwordImporter) passwordSupportReason = 'The native password importer is not installed in this build.';
    else if (!safeStorage.isEncryptionAvailable()) passwordSupportReason = 'Credential encryption is unavailable.';
    const cookieSupportReason = !cookieImporter
      ? 'The native cookie importer is not installed in this build.'
      : undefined;
    return [
      {
        id: CHROME_SOURCE_ID,
        name: 'Google Chrome',
        profiles,
        supports: {
          passwords: passwordSupport,
          cookies: cookieSupport,
          history: true,
        },
        supportReasons: {
          ...(passwordSupportReason ? { passwords: passwordSupportReason } : {}),
          ...(cookieSupportReason ? { cookies: cookieSupportReason } : {}),
        },
        ...(passwordSupportReason ? { passwordSupportReason } : {}),
      },
    ];
  }

  async searchHistory(query: string, limit = HISTORY_SEARCH_LIMIT): Promise<BrowserHistoryEntry[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized || !existsSync(this.historyFile)) return [];
    try {
      const entries = JSON.parse(await readFile(this.historyFile, 'utf8')) as BrowserHistoryEntry[];
      return entries
        .filter(
          (entry) => entry.url.toLowerCase().includes(normalized) || entry.title.toLowerCase().includes(normalized)
        )
        .slice(0, Math.max(1, Math.min(30, Math.trunc(limit))));
    } catch {
      return [];
    }
  }

  async credentialSuggestions(url: string): Promise<BrowserCredentialSuggestion[]> {
    const origin = secureOrigin(url);
    if (!origin) return [];
    const credentials = await this.readCredentialVault();
    return credentials
      .filter((credential) => secureOrigin(credential.url) === origin)
      .map((credential) => ({
        id: credential.id,
        label: maskedCredentialLabel(credential.username),
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  /** Resolve an agent-supplied account (exact username or its masked label)
   *  to the stored login for the page origin. Errors list only masked labels,
   *  so a wrong guess never reveals which usernames the vault holds. */
  async useCredentialByAccount<T>(
    url: string,
    account: string,
    use: (credential: Readonly<BrowserCredentialValue>, id: string) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    signal?.throwIfAborted();
    const origin = secureOrigin(url);
    if (!origin) throw new Error('Stored credentials are available only on secure HTTPS pages.');
    const wanted = account.trim();
    if (!wanted) throw new Error('savedAccount requires the account name or its masked label.');
    const candidates = (await this.readCredentialVault(signal)).filter(
      (credential) => secureOrigin(credential.url) === origin
    );
    if (!candidates.length) throw new Error(`No stored login for ${origin}.`);
    const matches = candidates.filter(
      (credential) =>
        credential.username.trim().toLowerCase() === wanted.toLowerCase() ||
        maskedCredentialLabel(credential.username) === wanted
    );
    // Usernames that differ only by case are different logins (the vault keeps
    // them apart), so the exact username wins over a case variant of it.
    const exact = matches.filter((credential) => credential.username.trim() === wanted);
    const named = exact.length ? exact : matches;
    // Chrome keeps one row per sign-in URL, so the same account can appear
    // more than once for one origin; identical usernames are one login.
    const usernames = new Set(named.map((credential) => credential.username.trim()));
    if (usernames.size === 1) return await this.useCredential(url, named[0].id, use, signal);
    const labels = [...new Set(candidates.map((credential) => maskedCredentialLabel(credential.username)))]
      .sort()
      .join(', ');
    throw new Error(
      matches.length
        ? `savedAccount "${wanted}" matches several stored logins for ${origin}; stored: ${labels}`
        : `savedAccount "${wanted}" is not a stored login for ${origin}; stored: ${labels}`
    );
  }

  async useCredential<T>(
    url: string,
    credentialId: string,
    use: (credential: Readonly<BrowserCredentialValue>, id: string) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    signal?.throwIfAborted();
    const origin = secureOrigin(url);
    if (!origin) throw new Error('Stored credentials are available only on secure HTTPS pages.');
    if (!/^[a-f0-9]{24}$/.test(credentialId)) throw new Error('Stored credential id is invalid.');
    const credential = (await this.readCredentialVault(signal)).find((candidate) => candidate.id === credentialId);
    if (!credential || secureOrigin(credential.url) !== origin) {
      throw new Error('The stored credential does not match the current page origin.');
    }
    signal?.throwIfAborted();
    return await use(
      {
        username: credential.username,
        password: credential.password,
      },
      credential.id
    );
  }

  private async readCredentialVault(signal?: AbortSignal): Promise<StoredBrowserCredential[]> {
    signal?.throwIfAborted();
    const vaultPath = join(this.options.userDataDirectory, 'browser-password-vault.bin');
    if (!existsSync(vaultPath)) return [];
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Credential encryption is unavailable.');
    }
    let parsed: unknown;
    try {
      parsed = await readVaultFile(vaultPath, unsealVault);
      signal?.throwIfAborted();
    } catch {
      signal?.throwIfAborted();
      throw new Error('The stored browser credential vault could not be opened.');
    }
    const entries =
      parsed && typeof parsed === 'object' && Array.isArray((parsed as { credentials?: unknown }).credentials)
        ? (parsed as { credentials: unknown[] }).credentials
        : [];
    if (entries.length > 100_000) throw new Error('Stored browser credential vault is too large.');
    return entries.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const value = entry as Record<string, unknown>;
      const id = String(value.id || '');
      const url = String(value.url || '');
      const username = String(value.username || '');
      const password = String(value.password || '');
      if (!/^[a-f0-9]{24}$/.test(id) || !secureOrigin(url) || !username || !password) return [];
      return [
        {
          id,
          url,
          username,
          password,
          note: typeof value.note === 'string' ? value.note : '',
        },
      ];
    });
  }

  async importProfile(
    request: BrowserImportRequest,
    onProgress: (progress: BrowserImportProgress) => void
  ): Promise<BrowserImportResult> {
    if (this.activeJobId) throw new Error('Another browser import is already running.');
    this.activeJobId = request.jobId || 'pending';
    try {
      const items = uniqueItems(request.items);
      if (!items.length) throw new Error('Select at least one browser data type to import.');
      const sources = await this.sources();
      const source = sources.find((candidate) => candidate.id === request.sourceId);
      const profile = source?.profiles.find((candidate) => candidate.id === request.profileId);
      if (!source || !profile) throw new Error('The selected Chrome profile is no longer available.');
      for (const item of items) {
        if (!source.supports[item]) throw new Error(`${item} import is unavailable in this build.`);
      }
      requireSensitiveImportApproval({
        hasSensitiveItem: items.includes('passwords') || items.includes('cookies'),
        administratorApproved: request.administratorApproved,
      });
      await (this.options.prepareChromeForImport || prepareChromeForImport)();
      const counts: Record<BrowserImportItem, number> = {
        passwords: 0,
        cookies: 0,
        history: 0,
      };
      const errors: Partial<Record<BrowserImportItem, string>> = {};
      for (const item of items) onProgress({ jobId: request.jobId, item, state: 'running' });
      // Passwords and cookies both drive the elevated helper over a single
      // fixed-name pipe, so items must run sequentially. Running them together
      // makes the second helper launch collide on the pipe (first_pipe_instance)
      // and fail, dropping only the second item of a combined import.
      for (const item of items) {
        try {
          let count: number;
          if (item === 'cookies') count = await this.importCookies(profile.id);
          else if (item === 'history') count = await this.importHistory(profile.id, request.jobId);
          else count = await this.importPasswords(profile.id);
          counts[item] = count;
          onProgress({ jobId: request.jobId, item, state: 'completed', count });
        } catch (error) {
          if (error instanceof CookieImportError) counts[item] = error.imported;
          const message = cleanError(error);
          errors[item] = message;
          onProgress({ jobId: request.jobId, item, state: 'failed', count: counts[item], error: message });
        }
      }
      return { jobId: request.jobId, counts, errors };
    } finally {
      this.activeJobId = '';
    }
  }

  /** One cookie import with no window: for the scheduler, which only calls it
   *  while Chrome is closed. It never launches the elevated helper (no UAC
   *  prompt) and records how it went for the settings page. */
  async runAutomaticCookieImport(profileId: string): Promise<AutoCookieImportOutcome> {
    if (this.activeJobId) return { state: 'skipped', reason: 'busy' };
    this.activeJobId = AUTOMATIC_JOB_ID;
    try {
      const source = (await this.sources()).find((candidate) => candidate.id === CHROME_SOURCE_ID);
      if (!source?.profiles.some((profile) => profile.id === profileId) || !source.supports.cookies) {
        throw new Error('The selected Chrome profile is no longer available for cookie import.');
      }
      return { state: 'imported', count: await this.importCookies(profileId, true) };
    } catch (error) {
      return await this.recordAutomaticFailure(error);
    } finally {
      this.activeJobId = '';
      // Housekeeping only: a leftover snapshot is harmless and the next run prunes again.
      await this.pruneAutomaticBackups().catch(() => undefined);
    }
  }

  private async recordAutomaticFailure(error: unknown): Promise<AutoCookieImportOutcome> {
    if (error instanceof SavedKeyUnavailableError) {
      await this.autoState.update({ needsManualImport: true, lastError: undefined });
      return { state: 'needs-manual-import' };
    }
    // Chrome opened after the process check: not a failure, the next run retries.
    if (errorMessage(error) === NATIVE_FAILURE.chromeRunning) return { state: 'skipped', reason: 'chrome-running' };
    const message = cleanError(error);
    await this.autoState.update({ lastError: message });
    return { state: 'failed', error: message };
  }

  private async pruneAutomaticBackups(): Promise<void> {
    const directory = join(this.options.userDataDirectory, 'browser-import-backups');
    const names = (await readdir(directory).catch(() => [] as string[]))
      .filter((name) => /^cookies-auto-\d+-/.test(name))
      .sort();
    await Promise.all(names.slice(0, -AUTOMATIC_BACKUPS_KEPT).map((name) => rm(join(directory, name), { force: true })));
  }

  private async importCookies(profileId: string, automatic = false): Promise<number> {
    const report = parseBrowserCookieReport(await this.readCookieReport(profileId, automatic));
    if (report.appBoundKey) {
      const grant = report.appBoundKey;
      // Drop the report's reference so the key text is not kept for the rest of the import.
      delete report.appBoundKey;
      await this.keepAppBoundKey(grant);
    }
    const encryption = this.options.keyEncryption ?? safeStorage;
    const imported = await importBrowserCookies(
      { cookies: this.options.cookieJar || this.options.partition.cookies },
      report.cookies,
      async (existing) => {
        if (!encryption.isEncryptionAvailable()) {
          throw new Error('Credential encryption is unavailable; cookie import was not started.');
        }
        const backupDirectory = join(this.options.userDataDirectory, 'browser-import-backups');
        await mkdir(backupDirectory, { recursive: true });
        await writeFile(
          join(backupDirectory, `cookies-${automatic ? 'auto-' : ''}${Date.now()}-${randomUUID()}.bin`),
          encryption.encryptString(JSON.stringify({ version: 1, cookies: existing })),
          { mode: 0o600, flag: 'wx' }
        );
      },
      report.failures
    );
    // Status for the settings page; failing to write it must not undo an import that worked.
    await this.autoState
      .update({ lastImportAt: Date.now(), lastCount: imported, lastError: undefined, needsManualImport: false })
      .catch(() => undefined);
    return imported;
  }

  /** The native cookie report, using the saved Chrome key whenever one still
   *  fits so no UAC prompt appears. A key Chrome rotated, or one that decrypts
   *  nothing, is discarded: a manual import then elevates once (and saves the
   *  new key), while an automatic one stops and asks for that manual import. */
  private async readCookieReport(profileId: string, automatic: boolean): Promise<unknown> {
    const read = (route: NativeCookieRoute): Promise<unknown> =>
      this.options.readNativeCookies
        ? this.options.readNativeCookies(profileId, route)
        : this.readNativeCookies(profileId, route);
    const importer = await this.nativeImporter('cookies');
    if (!importer) throw new Error('The packaged native browser importer is not installed.');
    if (!this.options.readNativeCookies && !(await this.importerReusesKeys(importer))) {
      // An importer built before key reuse always elevates, so it cannot run unattended.
      if (automatic) throw new Error('The installed browser importer cannot reuse a saved key; update the app.');
      return await read({ allowElevation: true, returnKey: false });
    }
    const blob = await this.currentKeyBinding();
    const saved = blob ? await this.keyStore.load(blob) : null;
    try {
      if (saved) {
        try {
          return await read({ savedKey: saved, allowElevation: false, returnKey: false });
        } catch (error) {
          if (errorMessage(error) !== NATIVE_FAILURE.savedKeyRejected) throw error;
          await this.keyStore.forget();
          if (automatic) throw new SavedKeyUnavailableError();
        }
      }
      return await read({ allowElevation: !automatic, returnKey: !automatic && this.keyStore.available() });
    } catch (error) {
      if (automatic && errorMessage(error) === NATIVE_FAILURE.savedKeyRequired) throw new SavedKeyUnavailableError();
      throw error;
    } finally {
      saved?.fill(0);
    }
  }

  /** Keep a key the elevated unwrap just produced and the importer proved correct. */
  private async keepAppBoundKey(grant: NativeAppBoundKey): Promise<void> {
    const key = Buffer.from(grant.key, 'base64');
    try {
      await this.keyStore.save(grant.blobSha256, key);
    } catch {
      // Only costs the next import another prompt; the cookies themselves were read.
    } finally {
      key.fill(0);
    }
  }

  /** Whether the importer build can take a saved key. Only a definitive answer
   *  is cached per binary: a build that answers, or one that rejects the
   *  `capabilities` command with an exit code (older builds). A timeout or a
   *  failure to start is transient: it fails this import and the next one probes again. */
  private async importerReusesKeys(importer: NativeBrowserImporter): Promise<boolean> {
    const known = this.keyReuseSupport.get(importer.sha256);
    if (known !== undefined) return known;
    let supported: boolean;
    try {
      const { stdout } = await execFileAsync(importer.executable, ['capabilities'], {
        windowsHide: true,
        timeout: CAPABILITY_PROBE_TIMEOUT_MS,
        maxBuffer: 4096,
      });
      supported = (JSON.parse(stdout) as { savedAppBoundKey?: unknown }).savedAppBoundKey === 1;
    } catch (error) {
      const failure = error as { code?: unknown; killed?: unknown; signal?: unknown };
      if (typeof failure.code !== 'number' || failure.killed || failure.signal) throw error;
      supported = false;
    }
    this.keyReuseSupport.set(importer.sha256, supported);
    return supported;
  }

  private async readNativeCookies(profileId: string, route: NativeCookieRoute): Promise<unknown> {
    const importer = await this.nativeImporter('cookies');
    if (!importer) {
      throw new Error('The packaged native browser importer is not installed.');
    }
    const args = ['import-cookies', '--browser', 'chrome', '--profile', profileId, '--json'];
    if (route.savedKey) args.push('--v20-key-stdin');
    if (!route.allowElevation) args.push('--no-elevation');
    if (route.returnKey) args.push('--return-v20-key');
    return await readEncryptedChildJson(importer.executable, args, importer.sha256, undefined, route.savedKey);
  }

  private async importHistory(profileId: string, jobId: string): Promise<number> {
    const sourceProfile = exactProfileDirectory(this.chromeUserData(), profileId);
    const sourceHistory = join(sourceProfile, 'History');
    if (!existsSync(sourceHistory)) return 0;
    const jobRoot = exactTemporaryJob(this.options.temporaryDirectory, `${jobId}-history`);
    return await importChromeHistory(sourceHistory, jobRoot, this.historyFile);
  }

  private async importPasswords(profileId: string): Promise<number> {
    const nativeImporter = await this.nativeImporter('passwords');
    if (!nativeImporter) {
      throw new Error('The packaged native password importer is not installed.');
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Credential encryption is unavailable.');
    }
    const output = this.options.readNativeCredentials
      ? await this.options.readNativeCredentials(profileId)
      : await readEncryptedChildJson(
          nativeImporter.executable,
          ['import-passwords', '--browser', 'chrome', '--profile', profileId, '--json'],
          nativeImporter.sha256
        );
    if (!Array.isArray(output)) throw new Error('Native password importer returned an invalid result.');
    if (output.length > 100_000) throw new Error('Native password importer returned too many credentials.');
    const entries = output
      .map((entry) => entry as NativeCredential)
      .filter(
        (entry) =>
          typeof entry.url === 'string' && typeof entry.username === 'string' && typeof entry.password === 'string'
      )
      .map((entry) => ({
        url: String(entry.url),
        username: String(entry.username),
        password: String(entry.password),
        note: typeof entry.note === 'string' ? entry.note : '',
        ...(typeof entry.lastUsedAt === 'number' && entry.lastUsedAt > 0 ? { lastUsedAt: entry.lastUsedAt } : {}),
      }));
    // Merge, never replace: a login Chrome no longer has stays, and a login
    // saved from a chat or 설정 keeps everything but its password.
    return await new CredentialVault({ userDataDirectory: this.options.userDataDirectory }).mergeImport(
      'chrome',
      entries
    );
  }
}

export function defaultNativeBrowserImporterPath(): string {
  return nativeBrowserImporterPath({
    isPackaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    cwd: process.cwd(),
  });
}
