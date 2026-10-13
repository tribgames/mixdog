// Address suggestions: the Host aliases of the user's ~/.ssh/config.
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { DesktopSshConfigHost } from '../../shared/contract-ssh';
import { parseSshTarget } from './ssh-command';

/** Host aliases with the `user@host[:port]` they resolve to. Wildcard and
 *  negated patterns and aliases ssh could not be given are skipped. */
export function parseSshConfigHosts(text: string): DesktopSshConfigHost[] {
  const hosts: DesktopSshConfigHost[] = [];
  let block: Array<{ alias: string; hostname: string; user: string; port: string }> = [];
  const flush = (): void => {
    for (const entry of block) {
      const port = entry.port && entry.port !== '22' ? `:${entry.port}` : '';
      hosts.push({
        alias: entry.alias,
        detail: `${entry.user ? `${entry.user}@` : ''}${entry.hostname || entry.alias}${port}`,
      });
    }
    block = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(\w+)(?:\s*=\s*|\s+)(.+)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2]
      .replace(/\s+#.*$/, '')
      .trim()
      .replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      flush();
      for (const alias of value.split(/\s+/)) {
        if (
          /[*?!]/.test(alias) ||
          hosts.some((host) => host.alias === alias) ||
          block.some((entry) => entry.alias === alias)
        )
          continue;
        try {
          parseSshTarget(alias);
        } catch {
          continue;
        }
        block.push({ alias, hostname: '', user: '', port: '' });
      }
    } else if (key === 'match') {
      flush();
    } else if (key === 'hostname' || key === 'user' || key === 'port') {
      for (const entry of block) entry[key] ||= value;
    }
  }
  flush();
  return hosts;
}

/** What Include needs from the file system. */
export interface ConfigFiles {
  readText(path: string): string | null;
  /** File names in a directory; empty when it does not exist. */
  listNames(directory: string): string[];
}

const nodeFiles: ConfigFiles = {
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  listNames: (directory) => {
    try {
      return readdirSync(directory);
    } catch {
      return [];
    }
  },
};

const MAX_INCLUDE_DEPTH = 8;

function includeTargets(argument: string, userDir: string, home: string, files: ConfigFiles): string[] {
  const targets: string[] = [];
  for (const match of argument.matchAll(/"([^"]*)"|(\S+)/g)) {
    const raw = match[1] ?? match[2];
    let expanded: string;
    if (raw === '~' || /^~[\\/]/.test(raw)) expanded = join(home, raw.slice(1));
    else if (/^([A-Za-z]:)?[\\/]/.test(raw)) expanded = raw;
    else expanded = join(userDir, raw);
    const split = Math.max(expanded.lastIndexOf('/'), expanded.lastIndexOf('\\'));
    const directory = expanded.slice(0, split);
    const name = expanded.slice(split + 1);
    if (!/[*?]/.test(name)) {
      targets.push(expanded);
      continue;
    }
    const pattern = new RegExp(
      `^${name
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')}$`
    );
    for (const entry of files.listNames(directory).sort())
      if (pattern.test(entry)) targets.push(join(directory, entry));
  }
  return targets;
}

/** The config text with every `Include` line replaced by the files it names
 *  (relative paths resolve against ~/.ssh, wildcards in the file name expand,
 *  loops and deep chains are cut). */
export function expandSshConfigIncludes(
  text: string,
  { home = homedir(), files = nodeFiles }: { home?: string; files?: ConfigFiles } = {},
  depth = 0,
  active: ReadonlySet<string> = new Set()
): string {
  const userDir = join(home, '.ssh');
  return text
    .split(/\r?\n/)
    .map((line) => {
      const match = /^\s*include(?:\s*=\s*|\s+)(.+?)\s*$/i.exec(line);
      if (!match) return line;
      if (depth >= MAX_INCLUDE_DEPTH) return '';
      const parts: string[] = [];
      for (const path of includeTargets(match[1], userDir, home, files)) {
        if (active.has(path)) continue;
        const included = files.readText(path);
        if (included !== null)
          parts.push(expandSshConfigIncludes(included, { home, files }, depth + 1, new Set([...active, path])));
      }
      return parts.join('\n');
    })
    .join('\n');
}

export async function readSshConfigHosts(
  file = join(homedir(), '.ssh', 'config'),
  options: { home?: string; files?: ConfigFiles } = {}
): Promise<DesktopSshConfigHost[]> {
  const files = options.files ?? nodeFiles;
  const text = files.readText(file);
  return text === null
    ? []
    : parseSshConfigHosts(expandSshConfigIncludes(text, { home: options.home, files }, 0, new Set([file])));
}
