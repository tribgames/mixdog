import { createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';
import { promisify } from 'node:util';
import { app, safeStorage, type Session } from 'electron';
import {
  nativeBrowserImporterPath,
  resolvePackagedBrowserImporter,
  type NativeBrowserImporter,
} from './profile-import-native';

const CHROME_SOURCE_ID = 'chrome';
const HISTORY_LIMIT = 10_000;
const HISTORY_SEARCH_LIMIT = 12;
const NATIVE_OUTPUT_LIMIT = 64 * 1024 * 1024;
const NATIVE_IMPORT_TIMEOUT_MS = 120_000;
const CHROME_CLOSE_TIMEOUT_MS = 30_000;
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;
const execFileAsync = promisify(execFile);

export type BrowserImportItem = 'passwords' | 'cookies' | 'history';
export type BrowserImportItemState = 'running' | 'completed' | 'failed';

export interface BrowserImportProfile {
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

export interface BrowserHistoryEntry {
  url: string;
  title: string;
  lastVisitAt: number;
  visitCount: number;
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

export interface BrowserImportCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  expires?: unknown;
  httpOnly?: unknown;
  secure?: unknown;
  session?: unknown;
  sameSite?: unknown;
}

interface NativeCredential {
  url?: unknown;
  username?: unknown;
  password?: unknown;
  note?: unknown;
}

export interface BrowserProfileImportOptions {
  userDataDirectory: string;
  temporaryDirectory: string;
  partition: Session;
  nativeImporterPath?: string;
  chromeExecutablePath?: string;
  chromeUserDataDirectory?: string;
  prepareChromeForImport?: () => Promise<void>;
  readNativeCredentials?: (profileId: string) => Promise<NativeCredential[]>;
  readNativeCookies?: (profileId: string) => Promise<BrowserImportCookie[]>;
}

export interface BrowserProcessCloseTarget {
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

function secureOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function maskedCredentialLabel(username: string): string {
  const value = username.trim();
  if (!value) return '저장된 계정';
  const at = value.lastIndexOf('@');
  if (at > 0 && at < value.length - 1) {
    const local = value.slice(0, at);
    const masked = local.length < 3
      ? `${local[0] || ''}•••`
      : `${local[0]}•••${local.at(-1)}`;
    return `${masked}@${value.slice(at + 1)}`;
  }
  if (value.length < 3) return '저장된 계정';
  return `${value[0]}•••${value.at(-1)}`;
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

function chromeUserDataDirectory(): string {
  const local = String(process.env.LOCALAPPDATA || '');
  if (!local) throw new Error('Chrome profile location is unavailable on this Windows account.');
  return join(local, 'Google', 'Chrome', 'User Data');
}

async function browserProcessIds(tasklist: string, imageName: string): Promise<number[]> {
  const { stdout } = await execFileAsync(tasklist, [
    '/FI',
    `IMAGENAME eq ${imageName}`,
    '/FO',
    'CSV',
    '/NH',
  ], {
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 256 * 1024,
  });
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.toLowerCase().startsWith(`"${imageName.toLowerCase()}","`))
    .map((line) => Number(line.match(/^"[^"]+","(\d+)"/)?.[1]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

export async function prepareChromeForImport(target: BrowserProcessCloseTarget = {
  imageName: 'chrome.exe',
}): Promise<void> {
  if (process.platform !== 'win32') return;
  if (!/^[a-zA-Z0-9._-]{1,120}\.exe$/i.test(target.imageName)) {
    throw new Error('Browser process identity is invalid.');
  }
  const systemRoot = String(process.env.SystemRoot || 'C:\\Windows');
  const tasklist = join(systemRoot, 'System32', 'tasklist.exe');
  const initialProcessIds = await browserProcessIds(tasklist, target.imageName);
  if (!initialProcessIds.length) return;
  const powershell = join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const closeScript = String.raw`
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
    await execFileAsync(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      closeScript,
    ], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 256 * 1024,
      env: {
        ...process.env,
        MIXDOG_BROWSER_IMPORT_PROCESS_IDS: JSON.stringify(initialProcessIds),
      },
    });
  } catch {
    closeRequestFailed = true;
    // A process can disappear while its top-level windows are enumerated. The
    // bounded wait below is the source of truth and never force-terminates it.
  }
  const deadline = Date.now() + Math.max(
    1_000,
    Math.min(120_000, target.timeoutMs ?? CHROME_CLOSE_TIMEOUT_MS),
  );
  while (Date.now() < deadline) {
    if (!(await browserProcessIds(tasklist, target.imageName)).length) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  if (closeRequestFailed) {
    throw new Error('Browser close request failed.');
  }
  throw new Error('Google Chrome이 정상 종료되지 않아 가져오기를 중단했습니다. 열린 작업을 확인한 뒤 다시 시도하세요.');
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
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

async function snapshotSqlite(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(database, destination);
  } finally {
    database.close();
  }
}

function chromeTimeToUnixMilliseconds(value: unknown): number {
  if (typeof value === 'bigint') {
    if (value <= 0n) return 0;
    return Math.max(0, Number(value / 1_000n) - CHROME_EPOCH_OFFSET_MS);
  }
  const micros = Number(value);
  if (!Number.isFinite(micros) || micros <= 0) return 0;
  return Math.max(0, Math.trunc(micros / 1_000 - CHROME_EPOCH_OFFSET_MS));
}

function cookieSameSite(value: unknown): Electron.CookiesSetDetails['sameSite'] | undefined {
  switch (String(value || '').toLowerCase()) {
    case 'strict': return 'strict';
    case 'lax': return 'lax';
    case 'none': return 'no_restriction';
    default: return undefined;
  }
}

async function readEncryptedChildJson(
  executable: string,
  args: string[],
  expectedSha256: string,
): Promise<unknown> {
  if (await sha256File(executable) !== expectedSha256) {
    throw new Error('Native browser importer changed after signature verification.');
  }
  const transportKey = randomBytes(32);
  const child = spawn(executable, args, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exitCodePromise = new Promise<number>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill();
      rejectExit(new Error('Native browser importer timed out.'));
    }, NATIVE_IMPORT_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code ?? 1);
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
  child.stdin?.end(transportKey.toString('base64'));
  try {
    const exitCode = await exitCodePromise;
    if (stdoutBytes > NATIVE_OUTPUT_LIMIT) throw new Error('Native browser importer returned too much data.');
    if (exitCode !== 0) {
      throw new Error(
        Buffer.concat(stderr).toString('utf8').trim()
        || `Native browser importer exited with code ${exitCode}.`,
      );
    }
    const envelope = JSON.parse(Buffer.concat(stdout).toString('utf8')) as Record<string, unknown>;
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
  private activeJobId = '';

  constructor(private readonly options: BrowserProfileImportOptions) {
    this.historyFile = join(options.userDataDirectory, 'browser-imported-history.json');
  }

  private chromeUserData(): string {
    return this.options.chromeUserDataDirectory || chromeUserDataDirectory();
  }

  private async nativeImporter(
    item: 'passwords' | 'cookies',
  ): Promise<NativeBrowserImporter | undefined> {
    if (
      (item === 'passwords' && this.options.readNativeCredentials)
      || (item === 'cookies' && this.options.readNativeCookies)
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
    const chromeExecutable = chromeExecutableCandidates(this.options.chromeExecutablePath)
      .find((candidate) => existsSync(candidate));
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
        ...(String(value?.user_name || '').trim()
          ? { accountEmail: String(value?.user_name || '').trim() }
          : {}),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (!profiles.length) return [];
    const [passwordImporter, cookieImporter] = await Promise.all([
      this.nativeImporter('passwords'),
      this.nativeImporter('cookies'),
    ]);
    const passwordSupport = Boolean(passwordImporter && safeStorage.isEncryptionAvailable());
    const cookieSupport = Boolean(cookieImporter);
    const passwordSupportReason = !passwordImporter
      ? 'The native password importer is not installed in this build.'
      : !safeStorage.isEncryptionAvailable()
        ? 'Windows credential encryption is unavailable.'
        : undefined;
    const cookieSupportReason = !cookieImporter
      ? 'The native cookie importer is not installed in this build.'
      : undefined;
    return [{
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
    }];
  }

  async searchHistory(query: string, limit = HISTORY_SEARCH_LIMIT): Promise<BrowserHistoryEntry[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized || !existsSync(this.historyFile)) return [];
    try {
      const entries = JSON.parse(await readFile(this.historyFile, 'utf8')) as BrowserHistoryEntry[];
      return entries
        .filter((entry) =>
          entry.url.toLowerCase().includes(normalized)
          || entry.title.toLowerCase().includes(normalized))
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

  async useCredential<T>(
    url: string,
    credentialId: string,
    use: (credential: Readonly<BrowserCredentialValue>) => Promise<T>,
  ): Promise<T> {
    const origin = secureOrigin(url);
    if (!origin) throw new Error('Stored credentials are available only on secure HTTPS pages.');
    if (!/^[a-f0-9]{24}$/.test(credentialId)) throw new Error('Stored credential id is invalid.');
    const credential = (await this.readCredentialVault())
      .find((candidate) => candidate.id === credentialId);
    if (!credential || secureOrigin(credential.url) !== origin) {
      throw new Error('The stored credential does not match the current page origin.');
    }
    return await use({
      username: credential.username,
      password: credential.password,
    });
  }

  private async readCredentialVault(): Promise<StoredBrowserCredential[]> {
    const vaultPath = join(this.options.userDataDirectory, 'browser-password-vault.bin');
    if (!existsSync(vaultPath)) return [];
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows credential encryption is unavailable.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(safeStorage.decryptString(await readFile(vaultPath)));
    } catch {
      throw new Error('The stored browser credential vault could not be opened.');
    }
    const entries = parsed && typeof parsed === 'object'
      && Array.isArray((parsed as { credentials?: unknown }).credentials)
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
      return [{
        id,
        url,
        username,
        password,
        note: typeof value.note === 'string' ? value.note : '',
      }];
    });
  }

  async importProfile(
    request: BrowserImportRequest,
    onProgress: (progress: BrowserImportProgress) => void,
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
    if (
      (items.includes('passwords') || items.includes('cookies'))
      && !request.administratorApproved
    ) {
      throw new Error('Password and cookie import require explicit administrator approval.');
    }
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
      // and fail — which is why a combined import dropped only the second item.
      for (const item of items) {
        try {
          const count = item === 'cookies'
            ? await this.importCookies(profile.id)
            : item === 'history'
              ? await this.importHistory(profile.id, request.jobId)
              : await this.importPasswords(profile.id);
          counts[item] = count;
          onProgress({ jobId: request.jobId, item, state: 'completed', count });
        } catch (error) {
          const message = cleanError(error);
          errors[item] = message;
          onProgress({ jobId: request.jobId, item, state: 'failed', error: message });
        }
      }
      return { jobId: request.jobId, counts, errors };
    } finally {
      this.activeJobId = '';
    }
  }

  private async importCookies(profileId: string): Promise<number> {
    const cookies = this.options.readNativeCookies
      ? await this.options.readNativeCookies(profileId)
      : await this.readNativeCookies(profileId);
    let imported = 0;
    for (const cookie of cookies) {
      const name = String(cookie.name || '');
      const value = String(cookie.value || '');
      const domain = String(cookie.domain || '');
      const cookiePath = String(cookie.path || '/') || '/';
      const host = domain.replace(/^\./, '');
      if (!name || !host || !/^[a-z0-9.-]+$/i.test(host)) continue;
      const secure = cookie.secure === true;
      const sameSite = cookieSameSite(cookie.sameSite);
      try {
        await this.options.partition.cookies.set({
          url: `${secure ? 'https' : 'http'}://${host}${cookiePath.startsWith('/') ? cookiePath : '/'}`,
          name,
          value,
          domain,
          path: cookiePath,
          secure,
          httpOnly: cookie.httpOnly === true,
          ...(sameSite ? { sameSite } : {}),
          ...(cookie.session !== true && Number(cookie.expires) > 0
            ? { expirationDate: Number(cookie.expires) }
            : {}),
        });
        imported += 1;
      } catch {
        // One invalid/expired cookie must not discard the rest of the profile.
      }
    }
    await this.options.partition.flushStorageData();
    return imported;
  }

  private async readNativeCookies(profileId: string): Promise<BrowserImportCookie[]> {
    const importer = await this.nativeImporter('cookies');
    if (!importer) {
      throw new Error('The packaged native browser importer is not installed.');
    }
    const output = await readEncryptedChildJson(importer.executable, [
      'import-cookies',
      '--browser',
      'chrome',
      '--profile',
      profileId,
      '--json',
    ], importer.sha256);
    if (!Array.isArray(output)) {
      throw new Error('Native cookie importer returned an invalid result.');
    }
    if (output.length > 1_000_000) {
      throw new Error('Native cookie importer returned too many cookies.');
    }
    return output as BrowserImportCookie[];
  }

  private async importHistory(profileId: string, jobId: string): Promise<number> {
    const sourceProfile = exactProfileDirectory(this.chromeUserData(), profileId);
    const sourceHistory = join(sourceProfile, 'History');
    if (!existsSync(sourceHistory)) return 0;
    const jobRoot = exactTemporaryJob(this.options.temporaryDirectory, `${jobId}-history`);
    const snapshot = join(jobRoot, 'History');
    try {
      await rm(jobRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await snapshotSqlite(sourceHistory, snapshot);
      const database = new DatabaseSync(snapshot, { readOnly: true });
      let imported: BrowserHistoryEntry[];
      try {
        const statement = database.prepare(`
          SELECT url, title, last_visit_time, visit_count
          FROM urls
          WHERE hidden = 0 AND (url LIKE 'http://%' OR url LIKE 'https://%')
          ORDER BY last_visit_time DESC
          LIMIT ?
        `);
        statement.setReadBigInts(true);
        const rows = statement.all(BigInt(HISTORY_LIMIT)) as Array<Record<string, unknown>>;
        imported = rows.map((row) => ({
          url: String(row.url || ''),
          title: String(row.title || ''),
          lastVisitAt: chromeTimeToUnixMilliseconds(row.last_visit_time),
          visitCount: Math.max(0, Number(row.visit_count) || 0),
        })).filter((entry) => Boolean(entry.url));
      } finally {
        database.close();
      }
      let existing: BrowserHistoryEntry[] = [];
      try {
        existing = JSON.parse(await readFile(this.historyFile, 'utf8')) as BrowserHistoryEntry[];
      } catch {
        existing = [];
      }
      const merged = new Map<string, BrowserHistoryEntry>();
      for (const entry of [...imported, ...existing]) {
        const current = merged.get(entry.url);
        if (!current || entry.lastVisitAt > current.lastVisitAt) merged.set(entry.url, entry);
      }
      const history = [...merged.values()]
        .sort((left, right) => right.lastVisitAt - left.lastVisitAt)
        .slice(0, HISTORY_LIMIT);
      const temporary = `${this.historyFile}.tmp-${randomUUID()}`;
      await mkdir(dirname(this.historyFile), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(history)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.historyFile);
      return imported.length;
    } finally {
      await rm(jobRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    }
  }

  private async importPasswords(profileId: string): Promise<number> {
    const nativeImporter = await this.nativeImporter('passwords');
    if (!nativeImporter) {
      throw new Error('The packaged native password importer is not installed.');
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows credential encryption is unavailable.');
    }
    const output = this.options.readNativeCredentials
      ? await this.options.readNativeCredentials(profileId)
      : await readEncryptedChildJson(nativeImporter.executable, [
        'import-passwords',
        '--browser',
        'chrome',
        '--profile',
        profileId,
        '--json',
      ], nativeImporter.sha256);
    if (!Array.isArray(output)) throw new Error('Native password importer returned an invalid result.');
    if (output.length > 100_000) throw new Error('Native password importer returned too many credentials.');
    const credentials = output
      .map((entry) => entry as NativeCredential)
      .filter((entry) =>
        typeof entry.url === 'string'
        && typeof entry.username === 'string'
        && typeof entry.password === 'string')
      .map((entry) => ({
        id: createHash('sha256')
          .update(`${entry.url}\0${entry.username}`)
          .digest('hex')
          .slice(0, 24),
        url: String(entry.url),
        username: String(entry.username),
        password: String(entry.password),
        note: typeof entry.note === 'string' ? entry.note : '',
      }));
    const plaintext = JSON.stringify({ version: 1, credentials });
    const encrypted = safeStorage.encryptString(plaintext);
    const vaultPath = join(this.options.userDataDirectory, 'browser-password-vault.bin');
    const temporary = `${vaultPath}.tmp-${randomUUID()}`;
    await writeFile(temporary, encrypted, { mode: 0o600 });
    await rename(temporary, vaultPath);
    return credentials.length;
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
