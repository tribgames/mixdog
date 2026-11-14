/**
 * The page-state and session methods of the engine lane: `host/browser/cookies`,
 * `storage`, `initScripts`, `intercept`, `performance`, `emulation` and
 * `downloads`. Each answers data, not text: the engine in the core words the
 * report. Every secret stays on this side of the wire (cookie values, the
 * values of sensitive storage keys), and every mutation goes through
 * `page.guarded` so the `expect` the core decided against is checked in the
 * same synchronous step as the send.
 *
 * `createInterceptTable` is the rule table the CDP fetch router consults
 * (`interceptFetchPatterns`, `matchInterceptRule`) and these handlers edit.
 */
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type { Session, WebContents } from 'electron';

import type {
  DownloadItem,
  EmulationSpec,
  InterceptRule,
  Precondition,
} from '../../../../../../packages/protocol/src/index.ts';
import type { BrowserFetchPattern, BrowserInterceptRule } from '../../browser/intercept';
import type { GuestSlot } from '../../browser/guest-state';
import { downloadMimeType, MAX_BROWSER_DOWNLOAD_BYTES, type TrackedBrowserDownload } from '../../browser/downloads';
import type { BrowserEmulationOwner } from '../../browser/host-policy';
import { BrowserPerformanceTrace, type ActiveBrowserPerformanceTrace } from '../../browser/performance';
import { redactBrowserUrl } from '../../browser/redaction';
import { browserStorageKeyIsSensitive } from '../../browser/page-state';
import { BrowserTraceExport } from '../../browser/trace-file';
import { type BrowserUrlPolicy, normalizeAgentUrl } from '../../browser/url-policy';
import { HOST_INVALID_PARAMS, type HostConnection, HostRpcError } from '../connection';
import { uploadBlob } from './blob-upload';
import type { EngineContext } from './context';
import { registerEngineMethod, registerEngineSessionMethod, type EngineParams } from './registry';

const MAX_INIT_SCRIPTS_PER_PAGE = 10;
const MAX_INIT_SCRIPT_CHARS = 20_000;
const MAX_INTERCEPT_RULES_PER_PAGE = 10;
const MAX_INTERCEPT_BODY_CHARS = 64 * 1024;
const MAX_INTERCEPT_PATTERN_CHARS = 400;
const MAX_COOKIES_REPORTED = 200;
const TRACE_COMPLETION_TIMEOUT_MS = 10_000;
const TRACE_CATEGORIES = 'devtools.timeline,v8.execute,blink.user_timing,loading,disabled-by-default-v8.cpu_profiler';
const REDACTED = '[REDACTED]';

/** A cookie as the engine sees it: everything but the value. */
function cookieMetadata(cookie: Electron.Cookie): Record<string, unknown> {
  return {
    name: cookie.name,
    value: REDACTED,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    session: cookie.session,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate,
  };
}

function invalid(message: string): HostRpcError {
  return new HostRpcError(HOST_INVALID_PARAMS, message);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  const found = allowed.find((candidate) => candidate.toLowerCase() === text);
  if (!found) throw invalid(`${what} must be ${allowed.join(', ')}`);
  return found;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectOf(fields: EngineParams): Precondition | undefined {
  return isObject(fields.expect) ? (fields.expect as unknown as Precondition) : undefined;
}

/** Wildcard pattern to anchored matcher. A pattern without a wildcard is
 *  treated as a substring, which is how a caller reads "*\/api\/*" anyway. */
function patternMatcher(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (character) =>
    character === '*' ? '\u0000' : `\\${character}`
  );
  return new RegExp(`^${escaped.split('\u0000').join('.*')}$`, 'i');
}

function normalizedPattern(raw: string): string {
  const pattern = raw.trim();
  if (!pattern) throw new Error('intercept add requires url');
  if (pattern.length > MAX_INTERCEPT_PATTERN_CHARS) {
    throw new Error(`intercept url pattern is limited to ${MAX_INTERCEPT_PATTERN_CHARS} characters`);
  }
  return pattern.includes('*') ? pattern : `*${pattern}*`;
}

function ruleReport(rule: BrowserInterceptRule): InterceptRule {
  return {
    id: rule.id,
    pattern: rule.pattern,
    resourceTypes: rule.resourceTypes,
    abort: rule.abort,
    body: rule.body,
    hits: rule.hits,
  };
}

/** The intercept rules of every page: edited by the `intercept` method, read
 *  by the CDP fetch router for each paused request. */
export function createInterceptTable() {
  const byGuest = new WeakMap<WebContents, Map<string, BrowserInterceptRule>>();
  let sequence = 0;

  function rulesFor(guest: WebContents): Map<string, BrowserInterceptRule> {
    let rules = byGuest.get(guest);
    if (!rules) {
      rules = new Map();
      byGuest.set(guest, rules);
    }
    return rules;
  }

  /** Applies `change`, pushes the patterns, and puts the table back when the push fails. */
  async function mutate(guest: WebContents, change: () => void, apply: () => Promise<void>): Promise<void> {
    const rules = rulesFor(guest);
    const previous = new Map(rules);
    change();
    try {
      await apply();
    } catch (error) {
      rules.clear();
      for (const [id, rule] of previous) rules.set(id, rule);
      throw error;
    }
  }

  return {
    rules: (guest: WebContents): InterceptRule[] => [...rulesFor(guest).values()].map(ruleReport),

    /** Patterns the host hands to Fetch.enable. Resource types stay out of them
     *  on purpose: CDP spells them differently from the tool surface, and the
     *  match filters the paused request anyway. */
    interceptFetchPatterns: (guest: WebContents): BrowserFetchPattern[] =>
      [...rulesFor(guest).values()].map((rule) => ({
        urlPattern: rule.pattern,
        // A refusal must land before the request leaves, while a mock is applied
        // once Chromium already holds a response to replace.
        requestStage: rule.abort ? ('Request' as const) : ('Response' as const),
      })),

    matchInterceptRule(guest: WebContents, url: string, resourceType: string): BrowserInterceptRule | undefined {
      const type = String(resourceType || '').toLowerCase();
      for (const rule of rulesFor(guest).values()) {
        if (!rule.matcher.test(url)) continue;
        if (rule.resourceTypes.length && !rule.resourceTypes.includes(type)) continue;
        rule.hits += 1;
        return rule;
      }
      return undefined;
    },

    hasInterceptRules: (guest: WebContents): boolean => rulesFor(guest).size > 0,

    async add(guest: WebContents, spec: InterceptRule, apply: () => Promise<void>): Promise<string> {
      const rules = rulesFor(guest);
      if (rules.size >= MAX_INTERCEPT_RULES_PER_PAGE) {
        throw new Error(
          `this page already holds ${MAX_INTERCEPT_RULES_PER_PAGE} intercept rules; remove one before adding another`
        );
      }
      const pattern = normalizedPattern(String(spec.pattern ?? ''));
      const abort = spec.abort === true;
      const body = abort ? '' : String(spec.body ?? '');
      if (body.length > MAX_INTERCEPT_BODY_CHARS) {
        throw new Error(`intercept body is limited to ${MAX_INTERCEPT_BODY_CHARS} characters`);
      }
      sequence += 1;
      const id = `i${sequence}`;
      await mutate(guest, () => {
        rules.set(id, {
          id,
          pattern,
          matcher: patternMatcher(pattern),
          resourceTypes: (spec.resourceTypes ?? []).map((type) => String(type).toLowerCase()),
          abort,
          body,
          hits: 0,
        });
      }, apply);
      return id;
    },

    async remove(guest: WebContents, id: string, apply: () => Promise<void>): Promise<void> {
      if (!rulesFor(guest).has(id)) {
        throw new Error(`unknown intercept rule ${id || '(empty)'}; list intercept to see current ids`);
      }
      await mutate(guest, () => rulesFor(guest).delete(id), apply);
    },

    async clear(guest: WebContents, apply: () => Promise<void>): Promise<void> {
      await mutate(guest, () => rulesFor(guest).clear(), apply);
    },
  };
}

export type InterceptTable = ReturnType<typeof createInterceptTable>;

interface InitScript {
  /** Chromium's own handle, needed to remove the script again. */
  identifier: string;
  source: string;
}

export interface SessionDeps {
  /** The partition every agent page shares, and where its cookies live. */
  partitionSession: Pick<Session, 'cookies'>;
  /** Read at call time: the policy can change while the host runs. */
  urlPolicy(): BrowserUrlPolicy;
  evaluate<T>(guest: WebContents, script: string, signal?: AbortSignal): Promise<T>;
  /** Writing state invalidates refs the agent may still be holding. */
  invalidateInteractionState(guest: WebContents): void;
  intercept: InterceptTable;
  /** Pushes the intercept patterns to the root and every child session. */
  applyFetchPatterns(guest: WebContents, signal?: AbortSignal): Promise<void>;
  /** Shared with the CDP listener that feeds and completes a running trace. */
  tracesByGuest: GuestSlot<ActiveBrowserPerformanceTrace>;
  /** Resident memory of the process painting the page (the JS heap alone misses images and layers). */
  processMemoryMb?(guest: WebContents): number | undefined;
  pause(ms: number, signal?: AbortSignal): Promise<void>;
  emulation: Pick<BrowserEmulationOwner, 'applyAgent'>;
  /** Where a saved trace goes when the core asks for one without choosing the directory (`saveTrace`). */
  traceDirectory?(): string;
  /** The session's downloads, newest first (`createBrowserDownloadLedger().downloadsForSession`). */
  downloads(sessionId: string): TrackedBrowserDownload[];
}

function downloadItem(entry: TrackedBrowserDownload): DownloadItem {
  return { ...entry, url: redactBrowserUrl(entry.url) };
}

/** What a finished download reads as: the bytes, refused if the file changed while they were read. */
async function readDownload(entry: TrackedBrowserDownload, signal: AbortSignal): Promise<Buffer> {
  const handle = await open(entry.path, 'r');
  try {
    signal.throwIfAborted();
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`download ${entry.id} is not a readable file`);
    if (info.size > MAX_BROWSER_DOWNLOAD_BYTES) {
      throw new Error(`download ${entry.id} is ${info.size} bytes; the limit is ${MAX_BROWSER_DOWNLOAD_BYTES} bytes`);
    }
    const data = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < data.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== info.size || offset !== info.size) {
      throw new Error(`download ${entry.id} changed while it was being read; retry`);
    }
    return data;
  } finally {
    await handle.close();
  }
}

export function registerSession(connection: HostConnection, ctx: EngineContext, deps: SessionDeps): void {
  const { partitionSession, intercept, tracesByGuest } = deps;
  const initScripts = new WeakMap<WebContents, Map<string, InitScript>>();
  /** Where a running trace with an export is saved when it stops. */
  const exportDirectories = new WeakMap<WebContents, string>();
  let initScriptSequence = 0;

  const initScriptsOf = (guest: WebContents): Map<string, InitScript> => {
    let scripts = initScripts.get(guest);
    if (!scripts) {
      scripts = new Map();
      initScripts.set(guest, scripts);
    }
    return scripts;
  };

  // Cookies

  registerEngineMethod(connection, ctx, 'host/browser/cookies', async (params, _signal, page) => {
    const op = oneOf(params.op, ['get', 'set', 'delete', 'clear'], 'cookies op');
    const cookie = isObject(params.cookie) ? params.cookie : {};
    const policy = deps.urlPolicy();
    const urls = (
      Array.isArray(params.urls) && params.urls.length
        ? params.urls.map((url) => normalizeAgentUrl(String(url), policy))
        : [page.guest.getURL()]
    ).filter(Boolean);
    const name = typeof params.name === 'string' && params.name ? params.name : String(cookie.name ?? '');
    const expect = expectOf(params);

    if (op === 'get') {
      const found = new Map<string, Electron.Cookie>();
      // A page with no URL yet reads the whole partition, as the old command did.
      for (const url of urls.length ? urls : ['']) {
        const cookies = await partitionSession.cookies.get({
          ...(url ? { url } : {}),
          ...(name ? { name } : {}),
          ...(typeof cookie.domain === 'string' && cookie.domain ? { domain: cookie.domain } : {}),
        });
        for (const entry of cookies) found.set(`${entry.name}|${entry.domain}|${entry.path}`, entry);
      }
      return {
        cookies: [...found.values()].slice(0, MAX_COOKIES_REPORTED).map(cookieMetadata),
        total: found.size,
      };
    }

    if (op === 'set') {
      if (!name || cookie.value === undefined) throw new Error('cookies set requires name and value');
      const sameSite = cookie.sameSite
        ? (String(cookie.sameSite).toLowerCase() as Electron.CookiesSetDetails['sameSite'])
        : undefined;
      if (sameSite && !['unspecified', 'no_restriction', 'lax', 'strict'].includes(sameSite)) {
        throw new Error('sameSite must be unspecified, no_restriction, lax, or strict');
      }
      const url = typeof cookie.url === 'string' && cookie.url ? normalizeAgentUrl(cookie.url, policy) : urls[0];
      await page.guarded(expect, () =>
        partitionSession.cookies.set({
          url,
          name,
          value: String(cookie.value),
          ...(typeof cookie.domain === 'string' && cookie.domain ? { domain: cookie.domain } : {}),
          ...(typeof cookie.path === 'string' && cookie.path ? { path: cookie.path } : {}),
          ...(typeof cookie.secure === 'boolean' ? { secure: cookie.secure } : {}),
          ...(typeof cookie.httpOnly === 'boolean' ? { httpOnly: cookie.httpOnly } : {}),
          ...(sameSite ? { sameSite } : {}),
          ...(Number.isFinite(cookie.expirationDate) ? { expirationDate: Number(cookie.expirationDate) } : {}),
        })
      );
      return {};
    }

    if (op === 'delete') {
      if (!name) throw new Error('cookies delete requires name');
      await page.guarded(expect, async () => {
        for (const url of urls) await partitionSession.cookies.remove(url, name);
      });
      return {};
    }

    // clear: the cookies of each url go, and what went is reported.
    const removed: Electron.Cookie[] = [];
    await page.guarded(expect, async () => {
      for (const url of urls) {
        const cookies = await partitionSession.cookies.get({ url });
        for (const entry of cookies) {
          const host = String(entry.domain || new URL(url).hostname).replace(/^\./, '');
          await partitionSession.cookies.remove(`${entry.secure ? 'https' : 'http'}://${host}${entry.path || '/'}`, entry.name);
          removed.push(entry);
        }
      }
    });
    return { cookies: removed.map(cookieMetadata) };
  });

  // Web storage

  registerEngineMethod(connection, ctx, 'host/browser/storage', async (params, signal, page) => {
    const op = oneOf(params.op, ['get', 'set', 'remove', 'clear'], 'storage op');
    const area = oneOf(params.area, ['local', 'session'], 'storage area');
    const key = typeof params.key === 'string' ? params.key : '';
    const value = typeof params.value === 'string' ? params.value : '';
    if ((op === 'set' || op === 'remove') && !key) throw new Error(`storage ${op} requires key`);
    const script = `(() => {
      const store = ${area === 'local' ? 'localStorage' : 'sessionStorage'};
      const operation = ${JSON.stringify(op)};
      const key = ${JSON.stringify(key)};
      const value = ${JSON.stringify(value)};
      const clip = (entry, limit) => typeof entry === 'string' && entry.length > limit
        ? entry.slice(0, limit) + '\\n[truncated in page]'
        : entry;
      if (operation === 'get' && !key) {
        const entries = [];
        let chars = 0;
        for (let index = 0; index < store.length && entries.length < 200; index += 1) {
          const entry = store.key(index);
          if (!entry) continue;
          const item = [clip(entry, 512), clip(store.getItem(entry), 4096)];
          const itemChars = String(item[0]).length + String(item[1] || '').length;
          if (chars + itemChars > 64000) break;
          chars += itemChars;
          entries.push(item);
        }
        return { total: store.length, entries, omitted: Math.max(0, store.length - entries.length) };
      }
      if (operation === 'get') return clip(store.getItem(key), 24000);
      if (operation === 'set') { store.setItem(key, value); return true; }
      if (operation === 'remove') { store.removeItem(key); return true; }
      const count = store.length;
      store.clear();
      return count;
    })()`;
    const run = () => deps.evaluate<unknown>(page.guest, script, signal);
    const read = op === 'get' ? await run() : await page.guarded(expectOf(params), run);
    if (op !== 'get') deps.invalidateInteractionState(page.guest);
    if (op === 'set') return { entries: browserStorageKeyIsSensitive(key) ? REDACTED : value };
    if (op !== 'get') return { entries: read };
    if (key) return { entries: browserStorageKeyIsSensitive(key) ? REDACTED : read };
    const listing = read as { entries: Array<[string, unknown]> };
    return {
      entries: {
        ...listing,
        entries: listing.entries.map(([entry, entryValue]) => [
          entry,
          browserStorageKeyIsSensitive(entry) ? REDACTED : entryValue,
        ]),
      },
    };
  });

  // Init scripts

  const initScriptList = (guest: WebContents) =>
    [...initScriptsOf(guest)].map(([id, script]) => ({ id, source: script.source }));

  registerEngineMethod(connection, ctx, 'host/browser/initScripts', async (params, signal, page) => {
    const op = oneOf(params.op, ['add', 'remove', 'list', 'clear'], 'initScripts op');
    const scripts = initScriptsOf(page.guest);
    if (op === 'list') return { scripts: initScriptList(page.guest) };

    if (op === 'add') {
      const source = String(params.source ?? '');
      if (!source.trim()) throw new Error('init_script add requires script');
      if (source.length > MAX_INIT_SCRIPT_CHARS) {
        throw new Error(`init_script source is limited to ${MAX_INIT_SCRIPT_CHARS} characters`);
      }
      if (scripts.size >= MAX_INIT_SCRIPTS_PER_PAGE) {
        throw new Error(
          `this page already holds ${MAX_INIT_SCRIPTS_PER_PAGE} init scripts; remove one before adding another`
        );
      }
      const { identifier } = await page.guarded(expectOf(params), () =>
        ctx.cdp.call<{ identifier: string }>(
          page.guest,
          'Page.addScriptToEvaluateOnNewDocument',
          { source, runImmediately: false },
          signal
        )
      );
      initScriptSequence += 1;
      const id = `is${initScriptSequence}`;
      scripts.set(id, { identifier, source });
      return { id, scripts: initScriptList(page.guest) };
    }

    const removeScript = async (id: string, identifier: string) => {
      try {
        await page.guarded(expectOf(params), () =>
          ctx.cdp.call(page.guest, 'Page.removeScriptToEvaluateOnNewDocument', { identifier }, signal)
        );
      } catch (error) {
        if (signal.aborted) throw signal.reason || error;
        // Chromium uses this exact message for an absent script. Missing CDP
        // sessions or targets are not proof that the script was removed.
        if (!(error instanceof Error) || error.message !== 'Script not found') throw error;
      }
      scripts.delete(id);
    };

    if (op === 'clear') {
      // Every script is tried; the ones that could not be removed stay listed and are named.
      const removed = scripts.size;
      const failures: Error[] = [];
      for (const [id, script] of [...scripts]) {
        try {
          await removeScript(id, script.identifier);
        } catch (error) {
          if (signal.aborted) throw signal.reason || error;
          failures.push(new Error(`${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
        }
      }
      if (failures.length) {
        throw new AggregateError(
          failures,
          `removed ${removed - failures.length} init script(s), but ${failures.length} could not be removed; retry clear\n` +
            failures.map((error) => error.message).join('\n')
        );
      }
      return { scripts: initScriptList(page.guest) };
    }

    const id = String(params.id ?? '').trim();
    const script = scripts.get(id);
    if (!script) throw new Error(`unknown init script ${id || '(empty)'}; list init_script to see current ids`);
    await removeScript(id, script.identifier);
    return { id, scripts: initScriptList(page.guest) };
  });

  // Request interception

  registerEngineMethod(connection, ctx, 'host/browser/intercept', async (params, signal, page) => {
    const op = oneOf(params.op, ['add', 'remove', 'list', 'clear'], 'intercept op');
    const { guest } = page;
    const apply = () => deps.applyFetchPatterns(guest, signal);
    const expect = expectOf(params);
    if (op === 'list') return { rules: intercept.rules(guest) };
    if (op === 'add') {
      if (!isObject(params.rule)) throw invalid('intercept add needs a rule');
      const spec = params.rule as unknown as InterceptRule;
      const id = await page.guarded(expect, () => intercept.add(guest, spec, apply));
      return { id, rules: intercept.rules(guest) };
    }
    if (op === 'remove') {
      const id = String(params.id ?? '').trim();
      await page.guarded(expect, () => intercept.remove(guest, id, apply));
      return { id, rules: intercept.rules(guest) };
    }
    await page.guarded(expect, () => intercept.clear(guest, apply));
    return { rules: [] };
  });

  // Performance

  registerEngineMethod(connection, ctx, 'host/browser/performance', async (params, signal, page) => {
    const op = oneOf(params.op, ['start', 'stop', 'metrics'], 'performance op');
    const { guest } = page;
    const cdp = ctx.cdp;

    if (op === 'metrics') {
      await cdp.call(guest, 'Performance.enable', {}, signal);
      const result = await cdp.call<{ metrics?: Array<{ name?: string; value?: number }> }>(
        guest,
        'Performance.getMetrics',
        {},
        signal
      );
      return { metrics: { metrics: result.metrics || [], processMemoryMb: deps.processMemoryMb?.(guest) ?? null } };
    }

    if (op === 'start') {
      if (tracesByGuest.has(guest)) throw new Error('a performance trace is already running for this page');
      const chosen = typeof params.exportPath === 'string' && params.exportPath ? params.exportPath : undefined;
      if (chosen && !isAbsolute(chosen)) throw invalid('performance exportPath must be an absolute directory');
      if (!chosen && params.saveTrace === true && !deps.traceDirectory) throw new Error('browser trace export is unavailable');
      const exportPath = chosen ?? (params.saveTrace === true ? deps.traceDirectory?.() : undefined);
      const categories =
        Array.isArray(params.categories) && params.categories.length
          ? params.categories.map(String).join(',')
          : TRACE_CATEGORIES;
      let resolveComplete = () => {};
      const complete = new Promise<void>((resolve) => {
        resolveComplete = resolve;
      });
      const raw = exportPath
        ? new BrowserTraceExport((value) => ctx.redactKnown(page.pageId, value))
        : undefined;
      tracesByGuest.set(guest, {
        trace: new BrowserPerformanceTrace(200_000, 2_000, raw),
        complete,
        resolveComplete,
        raw,
      });
      if (exportPath) exportDirectories.set(guest, exportPath);
      try {
        await cdp.call(
          guest,
          'Tracing.start',
          { categories, options: 'sampling-frequency=10000', transferMode: 'ReportEvents' },
          signal
        );
      } catch (error) {
        tracesByGuest.delete(guest);
        exportDirectories.delete(guest);
        throw error;
      }
      return {};
    }

    const active = tracesByGuest.get(guest);
    if (!active) return {};
    // Aborting this releases the timeout timer once the trace completes first.
    const timeout = new AbortController();
    try {
      await cdp.call(guest, 'Tracing.end', {}, signal);
      const timeoutSignal = AbortSignal.any([signal, timeout.signal]);
      await Promise.race([
        active.complete,
        deps.pause(TRACE_COMPLETION_TIMEOUT_MS, timeoutSignal).then(
          () => {
            throw new Error('performance trace completion timed out');
          },
          (error) => {
            // Our own release is not a failure; a caller cancellation is.
            if (!timeout.signal.aborted) throw error;
            return new Promise<never>(() => {});
          }
        ),
      ]);
      const directory = exportDirectories.get(guest);
      const file = active.raw && directory ? active.raw.save(directory) : undefined;
      return { summary: active.trace.summary(), ...(file ? { exportedTo: file.path } : {}) };
    } finally {
      timeout.abort();
      tracesByGuest.delete(guest);
      exportDirectories.delete(guest);
    }
  });

  // Emulation

  registerEngineMethod(connection, ctx, 'host/browser/emulation', async (params, signal, page) => {
    if (params.overrides !== null && params.overrides !== undefined && !isObject(params.overrides)) {
      throw invalid('emulation overrides must be an object or null');
    }
    const overrides = (params.overrides ?? null) as EmulationSpec | null;
    let labels: string[] | undefined;
    const applied = await page.guarded(expectOf(params), () =>
      deps.emulation.applyAgent(page.guest, overrides, signal, (configured) => {
        labels = configured;
      })
    );
    return { applied, ...(labels ? { labels } : {}) };
  });

  // Downloads (per session, not per page)

  registerEngineSessionMethod(connection, ctx, 'host/browser/downloads', async (params, signal) => {
    const op = oneOf(params.op, ['list', 'take'], 'downloads op');
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
    if (!sessionId) throw invalid('host/browser/downloads needs a sessionId.');
    const recorded = deps.downloads(sessionId);
    if (op === 'list') {
      const since = Number.isFinite(params.since) ? Number(params.since) : undefined;
      const changed = (entry: TrackedBrowserDownload) =>
        since === undefined || Math.max(entry.startedAt, entry.completedAt ?? 0) > since;
      return { items: recorded.filter(changed).map(downloadItem) };
    }
    const id = typeof params.id === 'string' && params.id ? params.id : undefined;
    const selected = id ? recorded.find((entry) => entry.id === id) : recorded.find((entry) => entry.state === 'completed');
    if (!selected) throw new Error(id ? `unknown download ${id}` : 'no completed download is available to take');
    if (selected.state !== 'completed') {
      throw new Error(`download ${selected.id} is ${selected.state}; wait for completion before taking it`);
    }
    const bytes = await readDownload(selected, signal);
    const blob = await uploadBlob(connection, bytes, selected.mimeType);
    // The attached file reads as the type its extension names (the old attach's rule), else Chromium's.
    return { items: [{ ...downloadItem(selected), mimeType: downloadMimeType(selected.file, selected.mimeType) }], blob };
  });
}
