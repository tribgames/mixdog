// Extensions → 커넥터: which list every item belongs to, and what a pasted
// "주소 또는 명령어" is. Presentation only: server names, credentials, plugin
// ids, enabled flags and the per-agent/per-project off-lists are read as they
// are and never rewritten here.
import { CONNECTOR_CATALOG, type ConnectorCatalogEntry } from '../../../../src/runtime/shared/connector-catalog.mjs';

type Row = Record<string, unknown>;

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** A plugin that brings MCP servers is a connector package, listed under
 *  커스텀 커넥터; any other plugin (skills, hooks or commands only) stays on
 *  the 익스텐션 tab. A broken MCP declaration still counts. */
export function isConnectorPlugin(plugin: Row): boolean {
  return Boolean(
    plugin.mcpScript ||
      plugin.mcpInline ||
      (Array.isArray(plugin.mcpServers) && plugin.mcpServers.length > 0) ||
      (Array.isArray(plugin.mcpErrors) && plugin.mcpErrors.length > 0)
  );
}

export interface CatalogConnectorRow {
  entry: ConnectorCatalogEntry;
  /** The user server created for this catalog entry (`connector` marker). */
  server: Row | null;
  /** Every user server of this entry (several accounts); `server` is the first. */
  servers: Row[];
}

export interface PluginConnectorRow {
  plugin: Row;
  servers: Row[];
}

export interface ConnectorGroups {
  catalog: CatalogConnectorRow[];
  /** Raw MCP servers the user configured (stdio, remote, OAuth). */
  custom: Row[];
  /** Plugins that bundle MCP, each with its own servers. */
  packages: PluginConnectorRow[];
}

const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' });

/** Every MCP server and plugin in exactly one place. A catalog row is only
 *  ever backed by the server carrying its `connector` marker: an existing
 *  custom Notion/GitHub server stays custom. */
export function groupConnectors(servers: readonly Row[], plugins: readonly Row[]): ConnectorGroups {
  const owned = (server: Row) => text((server.owner as Row | undefined)?.kind) === 'plugin';
  const userServers = servers.filter((server) => !owned(server) && server.source !== 'plugin');
  const catalog = [...CONNECTOR_CATALOG]
    .sort((a, b) => byName(a.name, b.name))
    .map((entry) => {
      const mine = userServers.filter((server) => text(server.connector) === entry.id);
      return { entry, server: mine[0] ?? null, servers: mine };
    })
    // Own-key-only services (Google Calendar/Drive) show once a server exists:
    // the user's own key made one, or an earlier connection is still there.
    .filter((row) => !row.entry.ownKey || row.servers.length > 0);
  const custom = userServers
    .filter((server) => !CONNECTOR_CATALOG.some((entry) => entry.id === text(server.connector)))
    .sort((a, b) => byName(String(a.name), String(b.name)));
  const packages = plugins
    .filter(isConnectorPlugin)
    .map((plugin) => {
      const id = text(plugin.id) || text(plugin.name);
      return {
        plugin,
        servers: servers.filter((server) => owned(server) && text((server.owner as Row | undefined)?.id) === id),
      };
    })
    .sort((a, b) => byName(text(a.plugin.title) || text(a.plugin.name), text(b.plugin.title) || text(b.plugin.name)));
  return { catalog, custom, packages };
}

/** The server name a new connector gets: the catalog id (so the curated
 *  deferred-tool line applies), or `<id>-2`… when a custom server holds it. */
export function uniqueServerName(base: string, taken: readonly string[]): string {
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'mcp';
  const used = new Set(taken.map((name) => name.toLowerCase()));
  if (!used.has(slug)) return slug;
  for (let n = 2; ; n += 1) if (!used.has(`${slug}-${n}`)) return `${slug}-${n}`;
}

/** The catalog connector id a server name belongs to: the inverse of
 *  uniqueServerName (`gmail-2` → `gmail`); any other name is returned as is. */
export function baseConnectorId(serverName: string): string {
  const base = serverName.replace(/-\d+$/, '');
  return base !== serverName && CONNECTOR_CATALOG.some((entry) => entry.id === base) ? base : serverName;
}

/** A sign-in session's phase (connector-connect.ts): `starting` (the click
 *  landed), `browser` (waiting for the sign-in page), `connecting` (the
 *  callback arrived), `tools` (signed in; connecting and listing tools),
 *  `connected` (just confirmed by the host), `failed`. */
export type ConnectorLoginPhase = 'starting' | 'browser' | 'connecting' | 'tools' | 'connected' | 'failed';
/** `connect` (연결), `reauth` (다시 인증), `switch` (계정 바꾸기), `reenable` (다시 켜기). */
export type ConnectorLoginMode = 'connect' | 'reauth' | 'switch' | 'reenable';
export const PENDING_LOGIN_PHASES: ReadonlySet<ConnectorLoginPhase> = new Set([
  'starting',
  'browser',
  'connecting',
  'tools',
]);

/** What one connector row (and its detail) shows. `pending` carries the
 *  current step and offers only 취소; `connected` never carries a step. */
export type ConnectorRowStatus =
  | 'pending'
  | 'connected'
  | 'failed'
  | 'disabled'
  | 'needs-reauth'
  | 'needs-connect'
  | 'error'
  | 'idle';

export interface ConnectorRowView {
  status: ConnectorRowStatus;
  step: ConnectorLoginPhase | null;
  mode: ConnectorLoginMode;
  /** The host confirmed it a moment ago (the row's brief highlight). */
  justConnected: boolean;
  error: string;
  reason: string;
  /** A pending session the server status already shows as connected: the
   *  sign-in is over and its pending state is to be dropped. */
  finished: boolean;
}

/**
 * One row's state from the host's server row and the sign-in session, in one
 * place so they never disagree: a running session decides the row (its step,
 * 취소), except that a server the host already reports connected finishes it
 * (a 계정 바꾸기 keeps running beside the working connection). 연결됨 is never
 * shown with a pending step or 취소.
 */
export function connectorRowView(
  server: Row | null,
  login: { phase: ConnectorLoginPhase; mode?: ConnectorLoginMode; error?: string; reason?: string } | null
): ConnectorRowView {
  const mode = login?.mode ?? 'connect';
  const base = { step: null, mode, justConnected: false, error: '', reason: '', finished: false };
  const serverConnected = server?.connected === true;
  if (login && PENDING_LOGIN_PHASES.has(login.phase)) {
    if (!serverConnected || mode === 'switch') return { ...base, status: 'pending', step: login.phase };
    return { ...base, status: 'connected', finished: true };
  }
  if (login?.phase === 'connected') return { ...base, status: 'connected', justConnected: true };
  if (serverConnected) return { ...base, status: 'connected' };
  if (login?.phase === 'failed') {
    return { ...base, status: 'failed', error: login.error ?? '', reason: login.reason ?? '' };
  }
  if (!server) return { ...base, status: 'idle' };
  if (server.enabled === false) return { ...base, status: 'disabled' };
  if (server.authRequired === true) {
    const signedIn = (server.oauth as Row | undefined)?.signedIn === true;
    return { ...base, status: signedIn ? 'needs-reauth' : 'needs-connect' };
  }
  if (server.error) return { ...base, status: 'error', error: text(server.error) };
  return { ...base, status: 'idle' };
}

/** "account · workspace" of a signed-in server, or '' when the provider named
 *  nobody (the caller says so; an identity is never invented). */
export function connectorIdentity(server: Row | null): string {
  const oauth = (server?.oauth as Row | undefined) ?? {};
  // Gmail on an app password names its account itself.
  const appPassword = (server?.appPassword as Row | undefined) ?? {};
  return [text(oauth.account) || text(appPassword.account), text(oauth.workspace)].filter(Boolean).join(' · ');
}

export type ConnectorSourceKind = 'mcp-url' | 'mcp-command' | 'plugin';

export interface DetectedConnectorSource {
  kind: ConnectorSourceKind;
  /** Other kinds the paste could also be: the user confirms one. */
  alternatives: ConnectorSourceKind[];
  /** Suggested server name (MCP kinds). */
  name: string;
  url?: string;
  command?: string;
  args?: string[];
  /** Plugin source as typed. */
  source?: string;
}

/** Shell-like split: quotes group, nothing is expanded or executed. */
export function splitCommandLine(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}

const LAUNCHERS = new Set([
  'npx',
  'uvx',
  'bunx',
  'pnpm',
  'yarn',
  'node',
  'python',
  'python3',
  'uv',
  'docker',
  'deno',
  'bun',
]);
const CODE_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org']);

function urlName(url: URL): string {
  const labels = url.hostname.split('.').filter(Boolean);
  if (labels.length > 1) labels.pop();
  const meaningful = labels.filter((label) => !['mcp', 'www', 'api', 'app'].includes(label));
  return meaningful.at(-1) || labels.at(-1) || 'mcp';
}

function commandName(args: readonly string[], command: string): string {
  const target = args.find((arg) => !arg.startsWith('-') && !['run', 'dlx', 'exec', 'x'].includes(arg)) || command;
  const base = target.split(/[\\/]/).pop() || target;
  return (
    base
      .replace(/^@[^/]+\//, '')
      .replace(/@[^@]*$/, '')
      .replace(/\.(?:m?js|py|exe|cmd)$/i, '') || 'mcp'
  );
}

/** What a pasted "주소 또는 명령어" is. Detection only parses: a command is
 *  split into exec + args, never run. null when nothing is recognised. */
export function detectConnectorSource(input: string): DetectedConnectorSource | null {
  const value = input.trim();
  if (!value) return null;
  if (/^git@[^:\s]+:\S+$/.test(value)) return { kind: 'plugin', alternatives: [], name: '', source: value };
  if (/^(?:https?|wss?):\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    const segments = url.pathname.split('/').filter(Boolean);
    const mcpLike = /mcp|sse/i.test(url.hostname) || /(?:^|\/)(?:mcp|sse)(?:\/|$)/i.test(url.pathname);
    const repoLike =
      /\.git$/i.test(url.pathname) || (CODE_HOSTS.has(url.hostname.toLowerCase()) && segments.length >= 2);
    const mcp = { kind: 'mcp-url' as const, name: urlName(url), url: value };
    if (/^wss?:/i.test(url.protocol) || (mcpLike && !repoLike)) return { ...mcp, alternatives: [] };
    if (repoLike && !mcpLike) return { kind: 'plugin', alternatives: [], name: '', source: value };
    // Neither clearly an MCP endpoint nor clearly a repository: ask.
    return { ...mcp, alternatives: ['plugin'], source: value };
  }
  const tokens = splitCommandLine(value);
  const [command = '', ...args] = tokens;
  const exec = (command.split(/[\\/]/).pop() || '').toLowerCase().replace(/\.(?:cmd|exe)$/, '');
  if (LAUNCHERS.has(exec)) {
    return { kind: 'mcp-command', alternatives: [], name: commandName(args, exec), command, args };
  }
  if (tokens.length === 1 && /^[\w.-]+\/[\w.-]+$/.test(value)) {
    return { kind: 'plugin', alternatives: [], name: '', source: value };
  }
  const path = /^(?:[a-zA-Z]:[\\/]|[\\/]|~[\\/]|\.{1,2}[\\/])/.test(command);
  if (path && tokens.length === 1) {
    // A folder is a local plugin; a program is a stdio server. Ask.
    return {
      kind: 'plugin',
      alternatives: ['mcp-command'],
      name: commandName([], command),
      source: value,
      command,
      args: [],
    };
  }
  if (path || tokens.length > 1) {
    return { kind: 'mcp-command', alternatives: [], name: commandName(args, command), command, args };
  }
  return null;
}
