import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node.js';

import type {
  DesktopLspCapabilities,
  DesktopLspDiagnosticEvent,
  DesktopLspDocumentInput,
  DesktopLspRequestResult,
  DesktopLspServerState,
  DesktopLspStatusEvent,
} from '../shared/contract';
import { projectEntryPathIn } from './project-files';

// @ts-expect-error The shared runtime helper is plain ESM and has no declaration file.
import { shutdownStdioChild } from '../../../../src/runtime/agent/orchestrator/mcp/child-tree.mjs';

export interface LanguageServerSpec {
  id: string;
  name: string;
  command: string;
  args: string[];
  projectCandidates?: (root: string) => string[];
}

interface ServerSession {
  key: string;
  projectPath: string;
  root: string;
  spec: LanguageServerSpec;
  child: ChildProcessWithoutNullStreams;
  connection: MessageConnection;
  baseCapabilities: DesktopLspCapabilities;
  registrations: Map<string, DynamicCapabilityRegistration>;
  languageIds: Set<string>;
  documents: Map<string, { languageId: string; relPath: string; version: number }>;
  idleTimer: NodeJS.Timeout | null;
  closing: boolean;
}

interface DynamicCapabilityRegistration {
  method: string;
  registerOptions: Record<string, unknown>;
}

const TYPESCRIPT_LANGUAGE_SERVER: LanguageServerSpec = {
  id: 'typescript-language-server',
  name: 'TypeScript Language Server',
  command: 'typescript-language-server',
  args: ['--stdio'],
};
const LANGUAGE_SERVER_IDLE_MS = 30_000;

export function languageServerInitializationOptions(
  spec: Pick<LanguageServerSpec, 'id'>,
): Readonly<Record<string, unknown>> | undefined {
  if (spec.id !== TYPESCRIPT_LANGUAGE_SERVER.id) return undefined;
  return {
    hostInfo: 'mixdog',
    disableAutomaticTypingAcquisition: true,
    maxTsServerMemory: 768,
    tsserver: {
      // A separate syntax server duplicates the project graph and costs more
      // than 100 MB even for one open document. The main server retains the
      // complete semantic, navigation, completion, and diagnostics surface.
      useSyntaxServer: 'never',
    },
  };
}

const SERVER_BY_LANGUAGE: Readonly<Record<string, LanguageServerSpec>> = {
  typescript: TYPESCRIPT_LANGUAGE_SERVER,
  javascript: TYPESCRIPT_LANGUAGE_SERVER,
  python: {
    id: 'pyright',
    name: 'Pyright',
    command: 'pyright-langserver',
    args: ['--stdio'],
    projectCandidates: (root) => [
      resolve(root, 'node_modules', '.bin', process.platform === 'win32'
        ? 'pyright-langserver.cmd'
        : 'pyright-langserver'),
    ],
  },
  go: { id: 'gopls', name: 'gopls', command: 'gopls', args: [] },
  rust: { id: 'rust-analyzer', name: 'rust-analyzer', command: 'rust-analyzer', args: [] },
  c: { id: 'clangd', name: 'clangd', command: 'clangd', args: ['--background-index'] },
  cpp: { id: 'clangd', name: 'clangd', command: 'clangd', args: ['--background-index'] },
  objective_c: { id: 'clangd', name: 'clangd', command: 'clangd', args: ['--background-index'] },
  objective_cpp: { id: 'clangd', name: 'clangd', command: 'clangd', args: ['--background-index'] },
  ruby: { id: 'ruby-lsp', name: 'Ruby LSP', command: 'ruby-lsp', args: [] },
};

export function languageServerSpecFor(languageId: string): Readonly<LanguageServerSpec> | null {
  return SERVER_BY_LANGUAGE[String(languageId || '').toLowerCase()] ?? null;
}

function requiredConfigString(value: unknown, name: string, maximum = 4_096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value.trim();
}

function configStringArray(
  value: unknown,
  name: string,
  maximumEntries: number,
  maximumLength = 4_096,
): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumEntries) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value.map((entry, index) =>
    requiredConfigString(entry, `${name}[${index}]`, maximumLength));
}

/** Parse a trusted project-local `.mixdog/lsp.json` registry.
 *  The file may map any Monaco language id to a stdio language server, while
 *  executable candidates remain confined to the project root. */
export function parseProjectLanguageServerConfig(
  value: unknown,
  root: string,
): Readonly<Record<string, LanguageServerSpec>> {
  const record = objectRecord(value);
  const rawServers = record?.servers;
  const serverMap = objectRecord(rawServers);
  const rows = Array.isArray(rawServers)
    ? rawServers
    : serverMap
      ? Object.entries(serverMap).map(([id, server]) => ({
          id,
          ...(objectRecord(server) ?? {}),
        }))
      : null;
  if (!rows || rows.length > 64) throw new TypeError('LSP servers configuration is invalid.');
  const byLanguage: Record<string, LanguageServerSpec> = {};
  for (const [index, raw] of rows.entries()) {
    const server = objectRecord(raw);
    if (!server) throw new TypeError(`LSP server ${index} is invalid.`);
    const id = requiredConfigString(server.id, `LSP server ${index} id`, 128);
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new TypeError(`LSP server ${index} id is invalid.`);
    const command = requiredConfigString(server.command, `LSP server ${id} command`);
    const languages = configStringArray(server.languages, `LSP server ${id} languages`, 32, 128)
      .map((language) => language.toLowerCase());
    const args = server.args === undefined
      ? []
      : configStringArray(server.args, `LSP server ${id} args`, 64);
    const candidates = server.candidates === undefined
      ? []
      : configStringArray(server.candidates, `LSP server ${id} candidates`, 32);
    const resolvedCandidates = candidates.map((candidate) => {
      if (isAbsolute(candidate)) throw new TypeError(`LSP server ${id} candidate must be project-relative.`);
      const target = resolve(root, candidate);
      if (target !== root && !target.startsWith(`${root}${sep}`)) {
        throw new TypeError(`LSP server ${id} candidate escaped the project.`);
      }
      return target;
    });
    const spec: LanguageServerSpec = {
      id,
      name: server.name === undefined
        ? id
        : requiredConfigString(server.name, `LSP server ${id} name`, 128),
      command,
      args,
      ...(resolvedCandidates.length
        ? { projectCandidates: () => resolvedCandidates }
        : {}),
    };
    for (const language of languages) {
      if (!/^[a-z0-9_+.-]+$/.test(language)) {
        throw new TypeError(`LSP server ${id} language is invalid.`);
      }
      if (byLanguage[language]) {
        throw new TypeError(`LSP language ${language} is configured more than once.`);
      }
      byLanguage[language] = spec;
    }
  }
  return Object.freeze(byLanguage);
}

function sessionKey(root: string, spec: LanguageServerSpec): string {
  const normalized = process.platform === 'win32' ? root.toLocaleLowerCase() : root;
  return `${normalized}\0${spec.id}`;
}

function publicState(
  spec: LanguageServerSpec | null,
  status: DesktopLspServerState['status'],
  detail?: string,
  capabilities?: DesktopLspCapabilities,
): DesktopLspServerState {
  return {
    available: status === 'ready',
    status,
    server: spec?.name || '',
    ...(detail ? { detail } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function providerEnabled(value: unknown): boolean {
  return value === true || Boolean(objectRecord(value));
}

export function normalizeLanguageServerCapabilities(value: unknown): DesktopLspCapabilities {
  const initialization = objectRecord(value);
  const capabilities = objectRecord(initialization?.capabilities) ?? initialization ?? {};
  const completion = capabilities.completionProvider;
  const completionOptions = objectRecord(completion);
  const signatureHelp = capabilities.signatureHelpProvider;
  const signatureHelpOptions = objectRecord(signatureHelp);
  const rename = capabilities.renameProvider;
  const renameOptions = objectRecord(rename);
  const codeAction = capabilities.codeActionProvider;
  const codeActionOptions = objectRecord(codeAction);
  const codeLens = capabilities.codeLensProvider;
  const codeLensOptions = objectRecord(codeLens);
  const onTypeFormatting = capabilities.documentOnTypeFormattingProvider;
  const onTypeFormattingOptions = objectRecord(onTypeFormatting);
  const documentLink = capabilities.documentLinkProvider;
  const documentLinkOptions = objectRecord(documentLink);
  const semanticTokens = capabilities.semanticTokensProvider;
  const semanticTokensOptions = objectRecord(semanticTokens);
  const semanticTokensFull = semanticTokensOptions?.full;
  const semanticTokensFullOptions = objectRecord(semanticTokensFull);
  const semanticTokensLegend = objectRecord(semanticTokensOptions?.legend);
  const inlayHint = capabilities.inlayHintProvider;
  const inlayHintOptions = objectRecord(inlayHint);
  const executeCommand = objectRecord(capabilities.executeCommandProvider);
  return {
    completion: providerEnabled(completion),
    completionResolve: completionOptions?.resolveProvider === true,
    completionTriggerCharacters: Array.isArray(completionOptions?.triggerCharacters)
      ? completionOptions.triggerCharacters.filter((entry): entry is string =>
          typeof entry === 'string' && entry.length > 0 && entry.length <= 8)
      : [],
    signatureHelp: providerEnabled(signatureHelp),
    signatureHelpTriggerCharacters: boundedStrings(signatureHelpOptions?.triggerCharacters, 64),
    signatureHelpRetriggerCharacters: boundedStrings(signatureHelpOptions?.retriggerCharacters, 64),
    hover: providerEnabled(capabilities.hoverProvider),
    declaration: providerEnabled(capabilities.declarationProvider),
    definition: providerEnabled(capabilities.definitionProvider),
    typeDefinition: providerEnabled(capabilities.typeDefinitionProvider),
    implementation: providerEnabled(capabilities.implementationProvider),
    references: providerEnabled(capabilities.referencesProvider),
    documentHighlight: providerEnabled(capabilities.documentHighlightProvider),
    linkedEditingRange: providerEnabled(capabilities.linkedEditingRangeProvider),
    documentSymbol: providerEnabled(capabilities.documentSymbolProvider),
    codeLens: providerEnabled(codeLens),
    codeLensResolve: codeLensOptions?.resolveProvider === true,
    rename: providerEnabled(rename),
    prepareRename: renameOptions?.prepareProvider === true,
    codeAction: providerEnabled(codeAction),
    codeActionResolve: codeActionOptions?.resolveProvider === true,
    codeActionKinds: Array.isArray(codeActionOptions?.codeActionKinds)
      ? codeActionOptions.codeActionKinds.filter((kind): kind is string => typeof kind === 'string')
      : [],
    formatting: providerEnabled(capabilities.documentFormattingProvider),
    rangeFormatting: providerEnabled(capabilities.documentRangeFormattingProvider),
    onTypeFormatting: providerEnabled(onTypeFormatting),
    onTypeFormattingTriggerCharacters: [
      ...(typeof onTypeFormattingOptions?.firstTriggerCharacter === 'string'
        ? [onTypeFormattingOptions.firstTriggerCharacter]
        : []),
      ...boundedStrings(onTypeFormattingOptions?.moreTriggerCharacter, 64),
    ],
    documentLink: providerEnabled(documentLink),
    documentLinkResolve: documentLinkOptions?.resolveProvider === true,
    documentColor: providerEnabled(capabilities.colorProvider),
    foldingRange: providerEnabled(capabilities.foldingRangeProvider),
    selectionRange: providerEnabled(capabilities.selectionRangeProvider),
    semanticTokens: providerEnabled(semanticTokens)
      && (semanticTokensFull === true || Boolean(semanticTokensFullOptions)),
    semanticTokensRange: providerEnabled(semanticTokens) && providerEnabled(semanticTokensOptions?.range),
    semanticTokensDelta: semanticTokensFullOptions?.delta === true,
    semanticTokensLegend: {
      tokenTypes: boundedStrings(semanticTokensLegend?.tokenTypes),
      tokenModifiers: boundedStrings(semanticTokensLegend?.tokenModifiers),
    },
    inlayHint: providerEnabled(inlayHint),
    inlayHintResolve: inlayHintOptions?.resolveProvider === true,
    callHierarchy: providerEnabled(capabilities.callHierarchyProvider),
    workspaceSymbol: providerEnabled(capabilities.workspaceSymbolProvider),
    executeCommand: Array.isArray(executeCommand?.commands) && executeCommand.commands.length > 0,
  };
}

const DYNAMIC_CAPABILITY_METHODS = new Set([
  'textDocument/completion',
  'textDocument/signatureHelp',
  'textDocument/hover',
  'textDocument/declaration',
  'textDocument/definition',
  'textDocument/typeDefinition',
  'textDocument/implementation',
  'textDocument/references',
  'textDocument/documentHighlight',
  'textDocument/linkedEditingRange',
  'textDocument/documentSymbol',
  'textDocument/codeLens',
  'textDocument/rename',
  'textDocument/codeAction',
  'textDocument/formatting',
  'textDocument/rangeFormatting',
  'textDocument/onTypeFormatting',
  'textDocument/documentLink',
  'textDocument/documentColor',
  'textDocument/foldingRange',
  'textDocument/selectionRange',
  'textDocument/semanticTokens',
  'textDocument/inlayHint',
  'textDocument/prepareCallHierarchy',
  'workspace/symbol',
  'workspace/executeCommand',
]);

function boundedStrings(value: unknown, maximumEntries = 256): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maximumEntries)
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function globPatternRegExp(pattern: string): RegExp | null {
  if (!pattern || pattern.length > 4_096 || pattern.includes('\0')) return null;
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else if (character === '{') {
      const close = pattern.indexOf('}', index + 1);
      if (close > index) {
        const choices = pattern.slice(index + 1, close).split(',')
          .filter(Boolean)
          .map((choice) => choice.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&'));
        if (choices.length) {
          source += `(?:${choices.join('|')})`;
          index = close;
          continue;
        }
      }
      source += '\\{';
    } else {
      source += character.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
    }
  }
  try {
    return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '');
  } catch {
    return null;
  }
}

function dynamicRegistrationMatches(
  options: Record<string, unknown>,
  languageId: string,
  uri?: string,
): boolean {
  const selector = options.documentSelector;
  if (selector === undefined || selector === null) return true;
  if (!Array.isArray(selector) || selector.length === 0) return false;
  let documentPath = '';
  if (uri) {
    try {
      documentPath = fileURLToPath(uri).replace(/\\/g, '/');
    } catch {
      return false;
    }
  }
  return selector.some((raw) => {
    if (typeof raw === 'string') return raw === languageId;
    const filter = objectRecord(raw);
    if (!filter) return false;
    if (typeof filter.language === 'string' && filter.language !== languageId) return false;
    if (typeof filter.scheme === 'string' && filter.scheme !== 'file') return false;
    if (typeof filter.pattern === 'string') {
      if (!documentPath) return false;
      const matcher = globPatternRegExp(filter.pattern.replace(/\\/g, '/'));
      if (!matcher || !matcher.test(documentPath)) return false;
    }
    return true;
  });
}

function capabilitiesWithDynamicRegistrations(
  base: DesktopLspCapabilities,
  registrations: Iterable<DynamicCapabilityRegistration>,
  languageId: string,
  uri?: string,
): DesktopLspCapabilities {
  const capabilities: DesktopLspCapabilities = {
    ...base,
    completionTriggerCharacters: [...base.completionTriggerCharacters],
    signatureHelpTriggerCharacters: [...base.signatureHelpTriggerCharacters],
    signatureHelpRetriggerCharacters: [...base.signatureHelpRetriggerCharacters],
    codeActionKinds: [...base.codeActionKinds],
    onTypeFormattingTriggerCharacters: [...base.onTypeFormattingTriggerCharacters],
    semanticTokensLegend: {
      tokenTypes: [...base.semanticTokensLegend.tokenTypes],
      tokenModifiers: [...base.semanticTokensLegend.tokenModifiers],
    },
  };
  for (const registration of registrations) {
    const options = registration.registerOptions;
    if (!dynamicRegistrationMatches(options, languageId, uri)) continue;
    switch (registration.method) {
      case 'textDocument/completion':
        capabilities.completion = true;
        capabilities.completionResolve ||= options.resolveProvider === true;
        capabilities.completionTriggerCharacters = [...new Set([
          ...capabilities.completionTriggerCharacters,
          ...boundedStrings(options.triggerCharacters, 64),
        ])];
        break;
      case 'textDocument/signatureHelp':
        capabilities.signatureHelp = true;
        capabilities.signatureHelpTriggerCharacters = [...new Set([
          ...capabilities.signatureHelpTriggerCharacters,
          ...boundedStrings(options.triggerCharacters, 64),
        ])];
        capabilities.signatureHelpRetriggerCharacters = [...new Set([
          ...capabilities.signatureHelpRetriggerCharacters,
          ...boundedStrings(options.retriggerCharacters, 64),
        ])];
        break;
      case 'textDocument/hover': capabilities.hover = true; break;
      case 'textDocument/declaration': capabilities.declaration = true; break;
      case 'textDocument/definition': capabilities.definition = true; break;
      case 'textDocument/typeDefinition': capabilities.typeDefinition = true; break;
      case 'textDocument/implementation': capabilities.implementation = true; break;
      case 'textDocument/references': capabilities.references = true; break;
      case 'textDocument/documentHighlight': capabilities.documentHighlight = true; break;
      case 'textDocument/linkedEditingRange': capabilities.linkedEditingRange = true; break;
      case 'textDocument/documentSymbol': capabilities.documentSymbol = true; break;
      case 'textDocument/codeLens':
        capabilities.codeLens = true;
        capabilities.codeLensResolve ||= options.resolveProvider === true;
        break;
      case 'textDocument/rename':
        capabilities.rename = true;
        capabilities.prepareRename ||= options.prepareProvider === true;
        break;
      case 'textDocument/codeAction':
        capabilities.codeAction = true;
        capabilities.codeActionResolve ||= options.resolveProvider === true;
        capabilities.codeActionKinds = [...new Set([
          ...capabilities.codeActionKinds,
          ...boundedStrings(options.codeActionKinds),
        ])];
        break;
      case 'textDocument/formatting': capabilities.formatting = true; break;
      case 'textDocument/rangeFormatting': capabilities.rangeFormatting = true; break;
      case 'textDocument/onTypeFormatting':
        capabilities.onTypeFormatting = true;
        capabilities.onTypeFormattingTriggerCharacters = [...new Set([
          ...capabilities.onTypeFormattingTriggerCharacters,
          ...(typeof options.firstTriggerCharacter === 'string'
            ? [options.firstTriggerCharacter]
            : []),
          ...boundedStrings(options.moreTriggerCharacter, 64),
        ])];
        break;
      case 'textDocument/documentLink':
        capabilities.documentLink = true;
        capabilities.documentLinkResolve ||= options.resolveProvider === true;
        break;
      case 'textDocument/documentColor': capabilities.documentColor = true; break;
      case 'textDocument/foldingRange': capabilities.foldingRange = true; break;
      case 'textDocument/selectionRange': capabilities.selectionRange = true; break;
      case 'textDocument/semanticTokens': {
        const full = options.full;
        const fullOptions = objectRecord(full);
        const legend = objectRecord(options.legend);
        capabilities.semanticTokens ||= full === true || Boolean(fullOptions);
        capabilities.semanticTokensRange ||= providerEnabled(options.range);
        capabilities.semanticTokensDelta ||= fullOptions?.delta === true;
        capabilities.semanticTokensLegend = {
          tokenTypes: boundedStrings(legend?.tokenTypes),
          tokenModifiers: boundedStrings(legend?.tokenModifiers),
        };
        break;
      }
      case 'textDocument/inlayHint':
        capabilities.inlayHint = true;
        capabilities.inlayHintResolve ||= options.resolveProvider === true;
        break;
      case 'textDocument/prepareCallHierarchy': capabilities.callHierarchy = true; break;
      case 'workspace/symbol': capabilities.workspaceSymbol = true; break;
      case 'workspace/executeCommand': capabilities.executeCommand = true; break;
      default: break;
    }
  }
  return capabilities;
}

function methodSupported(method: string, capabilities: DesktopLspCapabilities): boolean {
  switch (method) {
    case 'textDocument/completion': return capabilities.completion;
    case 'completionItem/resolve': return capabilities.completionResolve;
    case 'textDocument/signatureHelp': return capabilities.signatureHelp;
    case 'textDocument/hover': return capabilities.hover;
    case 'textDocument/declaration': return capabilities.declaration;
    case 'textDocument/definition': return capabilities.definition;
    case 'textDocument/typeDefinition': return capabilities.typeDefinition;
    case 'textDocument/implementation': return capabilities.implementation;
    case 'textDocument/references': return capabilities.references;
    case 'textDocument/documentHighlight': return capabilities.documentHighlight;
    case 'textDocument/linkedEditingRange': return capabilities.linkedEditingRange;
    case 'textDocument/documentSymbol': return capabilities.documentSymbol;
    case 'textDocument/codeLens': return capabilities.codeLens;
    case 'codeLens/resolve': return capabilities.codeLensResolve;
    case 'textDocument/prepareRename': return capabilities.prepareRename;
    case 'textDocument/rename': return capabilities.rename;
    case 'textDocument/codeAction': return capabilities.codeAction;
    case 'codeAction/resolve': return capabilities.codeActionResolve;
    case 'textDocument/formatting': return capabilities.formatting;
    case 'textDocument/rangeFormatting': return capabilities.rangeFormatting;
    case 'textDocument/onTypeFormatting': return capabilities.onTypeFormatting;
    case 'textDocument/documentLink': return capabilities.documentLink;
    case 'documentLink/resolve': return capabilities.documentLinkResolve;
    case 'textDocument/documentColor':
    case 'textDocument/colorPresentation': return capabilities.documentColor;
    case 'textDocument/foldingRange': return capabilities.foldingRange;
    case 'textDocument/selectionRange': return capabilities.selectionRange;
    case 'textDocument/semanticTokens/full': return capabilities.semanticTokens;
    case 'textDocument/semanticTokens/full/delta':
      return capabilities.semanticTokens && capabilities.semanticTokensDelta;
    case 'textDocument/semanticTokens/range': return capabilities.semanticTokensRange;
    case 'textDocument/inlayHint': return capabilities.inlayHint;
    case 'inlayHint/resolve': return capabilities.inlayHintResolve;
    case 'textDocument/prepareCallHierarchy':
    case 'callHierarchy/incomingCalls':
    case 'callHierarchy/outgoingCalls': return capabilities.callHierarchy;
    case 'workspace/symbol': return capabilities.workspaceSymbol;
    case 'workspace/executeCommand': return capabilities.executeCommand;
    default: return false;
  }
}

export function languageServerRequestParams(
  uri: string,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return method.startsWith('textDocument/')
    ? { ...params, textDocument: { uri } }
    : { ...params };
}

async function executableFile(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableVariants(path: string): string[] {
  if (process.platform !== 'win32' || extname(path)) return [path];
  return [`${path}.exe`, `${path}.cmd`, `${path}.bat`, path];
}

function projectCommandCandidates(spec: LanguageServerSpec, root: string): string[] {
  const command = spec.command.replace(/^"|"$/g, '');
  if (isAbsolute(command)) return executableVariants(command);
  if (/[\\/]/.test(command)) {
    const target = resolve(root, command);
    if (target !== root && !target.startsWith(`${root}${sep}`)) return [];
    return executableVariants(target);
  }
  const localBins = process.platform === 'win32'
    ? [
        join(root, 'node_modules', '.bin', command),
        join(root, '.venv', 'Scripts', command),
        join(root, 'venv', 'Scripts', command),
      ]
    : [
        join(root, 'node_modules', '.bin', command),
        join(root, '.venv', 'bin', command),
        join(root, 'venv', 'bin', command),
      ];
  return localBins.flatMap(executableVariants);
}

async function resolveExecutable(spec: LanguageServerSpec, root: string): Promise<string | null> {
  const candidates = [
    ...(spec.projectCandidates?.(root) ?? []).flatMap(executableVariants),
    ...projectCommandCandidates(spec, root),
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (await executableFile(candidate)) return candidate;
  }
  if (isAbsolute(spec.command) || /[\\/]/.test(spec.command)) return null;
  const extensions = process.platform === 'win32'
    ? (extname(spec.command) ? [''] : ['.exe', '.cmd', '.bat', ''])
    : [''];
  for (const directory of String(process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = resolve(directory.replace(/^"|"$/g, ''), `${spec.command}${extension}`);
      if (await executableFile(candidate)) return candidate;
    }
  }
  return null;
}

function spawnServer(command: string, args: string[], cwd: string): ChildProcessWithoutNullStreams {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    const commandLine = [command, ...args]
      .map((part) => `"${part.replace(/"/g, '""')}"`)
      .join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
      cwd,
      env: process.env,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  return spawn(command, args, {
    cwd,
    env: process.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function relativeDocumentPath(root: string, uri: string): string | null {
  try {
    const absolute = resolve(fileURLToPath(uri));
    const normalizedRoot = process.platform === 'win32' ? root.toLocaleLowerCase() : root;
    const normalizedFile = process.platform === 'win32' ? absolute.toLocaleLowerCase() : absolute;
    if (normalizedFile !== normalizedRoot && !normalizedFile.startsWith(`${normalizedRoot}\\`)
      && !normalizedFile.startsWith(`${normalizedRoot}/`)) return null;
    return absolute.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
  } catch {
    return null;
  }
}

interface ProjectRegistryCache {
  checkedAt: number;
  mtimeMs: number;
  size: number;
  specs: Readonly<Record<string, LanguageServerSpec>>;
}

class LanguageServerRegistry {
  private readonly projectCache = new Map<string, ProjectRegistryCache>();

  constructor(
    private readonly defaults: Readonly<Record<string, LanguageServerSpec>>,
  ) {}

  private async projectSpecs(root: string): Promise<Readonly<Record<string, LanguageServerSpec>>> {
    const cached = this.projectCache.get(root);
    if (cached && Date.now() - cached.checkedAt < 2_000) return cached.specs;
    const configPath = join(root, '.mixdog', 'lsp.json');
    try {
      const info = await stat(configPath);
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
        cached.checkedAt = Date.now();
        return cached.specs;
      }
      if (info.size > 262_144) throw new TypeError('LSP configuration is too large.');
      const specs = parseProjectLanguageServerConfig(
        JSON.parse(await readFile(configPath, 'utf8')),
        root,
      );
      this.projectCache.set(root, {
        checkedAt: Date.now(),
        mtimeMs: info.mtimeMs,
        size: info.size,
        specs,
      });
      return specs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      const specs = Object.freeze({});
      this.projectCache.set(root, {
        checkedAt: Date.now(),
        mtimeMs: 0,
        size: 0,
        specs,
      });
      return specs;
    }
  }

  async specFor(root: string, languageId: string): Promise<LanguageServerSpec | null> {
    const language = String(languageId || '').toLowerCase();
    const project = await this.projectSpecs(root);
    return project[language] ?? this.defaults[language] ?? null;
  }
}

export class LanguageServerManager {
  private readonly sessions = new Map<string, ServerSession>();
  private readonly starting = new Map<string, Promise<ServerSession | null>>();
  private readonly states = new Map<string, DesktopLspServerState>();
  private readonly missingUntil = new Map<string, number>();
  private readonly restartFailures = new Map<string, { count: number; retryAt: number }>();
  private readonly diagnosticListeners = new Set<(event: DesktopLspDiagnosticEvent) => void>();
  private readonly statusListeners = new Set<(event: DesktopLspStatusEvent) => void>();
  private readonly registry: LanguageServerRegistry;

  constructor(
    specs: Readonly<Record<string, LanguageServerSpec>> = SERVER_BY_LANGUAGE,
  ) {
    this.registry = new LanguageServerRegistry(specs);
  }

  private specFor(root: string, languageId: string): Promise<LanguageServerSpec | null> {
    return this.registry.specFor(root, languageId);
  }

  private recordRestartFailure(key: string): number {
    const count = Math.min(6, (this.restartFailures.get(key)?.count ?? 0) + 1);
    const delayMs = Math.min(30_000, 1_000 * (2 ** (count - 1)));
    this.restartFailures.set(key, { count, retryAt: Date.now() + delayMs });
    return delayMs;
  }

  subscribeDiagnostics(listener: (event: DesktopLspDiagnosticEvent) => void): () => void {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }

  subscribeStatus(listener: (event: DesktopLspStatusEvent) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private emitStatus(
    projectPath: string,
    languageId: string,
    spec: LanguageServerSpec | null,
    status: DesktopLspServerState['status'],
    detail?: string,
    capabilities?: DesktopLspCapabilities,
    relPath?: string,
  ): DesktopLspServerState {
    const state = publicState(spec, status, detail, capabilities);
    if (spec) this.states.set(sessionKey(projectPath, spec), state);
    const event: DesktopLspStatusEvent = {
      projectPath,
      languageId,
      ...(relPath ? { relPath } : {}),
      ...state,
    };
    for (const listener of this.statusListeners) listener(event);
    return state;
  }

  private emitDiagnostics(event: DesktopLspDiagnosticEvent): void {
    for (const listener of this.diagnosticListeners) listener(event);
  }

  private refreshCapabilities(session: ServerSession): void {
    const emittedLanguages = new Set<string>();
    for (const [uri, document] of session.documents) {
      const capabilities = capabilitiesWithDynamicRegistrations(
        session.baseCapabilities,
        session.registrations.values(),
        document.languageId,
        uri,
      );
      emittedLanguages.add(document.languageId);
      this.emitStatus(
        session.projectPath,
        document.languageId,
        session.spec,
        'ready',
        undefined,
        capabilities,
        document.relPath,
      );
    }
    for (const languageId of session.languageIds) {
      if (emittedLanguages.has(languageId)) continue;
      const capabilities = capabilitiesWithDynamicRegistrations(
        session.baseCapabilities,
        session.registrations.values(),
        languageId,
      );
      this.emitStatus(
        session.projectPath,
        languageId,
        session.spec,
        'ready',
        undefined,
        capabilities,
      );
    }
  }

  private async ensure(
    projectPath: string,
    root: string,
    languageId: string,
    spec: LanguageServerSpec,
  ): Promise<ServerSession | null> {
    const key = sessionKey(root, spec);
    const live = this.sessions.get(key);
    if (live && !live.closing) {
      if (live.idleTimer) clearTimeout(live.idleTimer);
      live.idleTimer = null;
      return live;
    }
    const pending = this.starting.get(key);
    if (pending) return pending;
    if ((this.missingUntil.get(key) || 0) > Date.now()) return null;
    if ((this.restartFailures.get(key)?.retryAt || 0) > Date.now()) return null;
    const start = this.start(projectPath, root, languageId, spec, key)
      .finally(() => this.starting.delete(key));
    this.starting.set(key, start);
    return start;
  }

  private async start(
    projectPath: string,
    root: string,
    languageId: string,
    spec: LanguageServerSpec,
    key: string,
  ): Promise<ServerSession | null> {
    this.emitStatus(projectPath, languageId, spec, 'starting');
    const executable = await resolveExecutable(spec, root);
    if (!executable) {
      this.missingUntil.set(key, Date.now() + 30_000);
      this.emitStatus(projectPath, languageId, spec, 'missing');
      return null;
    }
    const child = spawnServer(executable, spec.args, root);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_000);
    });
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    );
    connection.onError(() => undefined);
    let session: ServerSession | null = null;
    const workspaceFolders = [{
      uri: pathToFileURL(root).toString(),
      name: root.split(/[\\/]/).at(-1) || root,
    }];
    connection.onRequest('workspace/configuration', (payload: unknown) => {
      const items = objectRecord(payload)?.items;
      return Array.isArray(items) ? items.map(() => null) : [];
    });
    connection.onRequest('workspace/workspaceFolders', () => workspaceFolders);
    connection.onRequest('window/workDoneProgress/create', () => null);
    connection.onRequest('client/registerCapability', (payload: unknown) => {
      if (!session) return null;
      const rows = objectRecord(payload)?.registrations;
      if (!Array.isArray(rows)) return null;
      let changed = false;
      for (const raw of rows.slice(0, 256)) {
        const registration = objectRecord(raw);
        const id = typeof registration?.id === 'string' ? registration.id : '';
        const method = typeof registration?.method === 'string' ? registration.method : '';
        if (!id || id.length > 256 || !DYNAMIC_CAPABILITY_METHODS.has(method)) continue;
        session.registrations.set(id, {
          method,
          registerOptions: objectRecord(registration?.registerOptions) ?? {},
        });
        changed = true;
      }
      if (changed) this.refreshCapabilities(session);
      return null;
    });
    connection.onRequest('client/unregisterCapability', (payload: unknown) => {
      if (!session) return null;
      const record = objectRecord(payload);
      const rows = record?.unregisterations ?? record?.unregistrations;
      if (!Array.isArray(rows)) return null;
      let changed = false;
      for (const raw of rows.slice(0, 256)) {
        const registration = objectRecord(raw);
        const id = typeof registration?.id === 'string' ? registration.id : '';
        if (id && session.registrations.delete(id)) changed = true;
      }
      if (changed) this.refreshCapabilities(session);
      return null;
    });
    connection.onRequest('workspace/applyEdit', () => ({
      applied: false,
      failureReason: 'Server-initiated edits require an explicit editor action.',
    }));
    connection.onNotification('textDocument/publishDiagnostics', (payload: unknown) => {
      if (!session || !payload || typeof payload !== 'object') return;
      const record = payload as Record<string, unknown>;
      const uri = String(record.uri || '');
      const relPath = relativeDocumentPath(root, uri);
      if (!relPath) return;
      const diagnostics = Array.isArray(record.diagnostics)
        ? record.diagnostics.slice(0, 2_000) as DesktopLspDiagnosticEvent['diagnostics']
        : [];
      this.emitDiagnostics({
        projectPath,
        relPath,
        uri,
        server: spec.name,
        diagnostics,
      });
    });
    connection.listen();
    const closed = () => {
      if (!session || session.closing) return;
      this.sessions.delete(key);
      const delayMs = this.recordRestartFailure(key);
      this.emitStatus(
        projectPath,
        languageId,
        spec,
        'stopped',
        [
          stderr.trim().split(/\r?\n/).at(-1)?.slice(0, 200),
          `Retrying after ${Math.ceil(delayMs / 1_000)}s.`,
        ].filter(Boolean).join(' '),
      );
    };
    child.once('exit', closed);
    child.once('error', closed);
    try {
      const initializationOptions = languageServerInitializationOptions(spec);
      const initialization = await withTimeout(connection.sendRequest('initialize', {
        processId: process.pid,
        clientInfo: { name: 'Mixdog Desktop', version: '0.9' },
        rootUri: pathToFileURL(root).toString(),
        rootPath: root,
        workspaceFolders,
        ...(initializationOptions ? { initializationOptions } : {}),
        capabilities: {
          workspace: {
            workspaceFolders: true,
            applyEdit: false,
            executeCommand: { dynamicRegistration: true },
            symbol: { dynamicRegistration: true },
            configuration: true,
          },
          textDocument: {
            synchronization: { didSave: true, dynamicRegistration: true },
            // Servers gate their push diagnostics on this capability:
            // typescript-language-server sends NOTHING without it (verified
            // standalone — user: Problems에 아무것도 안 뜸).
            publishDiagnostics: {
              relatedInformation: true,
              versionSupport: false,
              tagSupport: { valueSet: [1, 2] },
              codeDescriptionSupport: true,
              dataSupport: true,
            },
            completion: {
              dynamicRegistration: true,
              completionItem: {
                snippetSupport: true,
                commitCharactersSupport: true,
                insertReplaceSupport: true,
                deprecatedSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
                resolveSupport: {
                  properties: ['detail', 'documentation', 'additionalTextEdits'],
                },
              },
              completionList: {
                itemDefaults: ['commitCharacters', 'editRange', 'insertTextFormat', 'insertTextMode'],
              },
            },
            signatureHelp: {
              dynamicRegistration: true,
              signatureInformation: {
                documentationFormat: ['markdown', 'plaintext'],
                parameterInformation: { labelOffsetSupport: true },
                activeParameterSupport: true,
              },
              contextSupport: true,
            },
            hover: { dynamicRegistration: true, contentFormat: ['markdown', 'plaintext'] },
            declaration: { dynamicRegistration: true, linkSupport: true },
            definition: { dynamicRegistration: true, linkSupport: true },
            typeDefinition: { dynamicRegistration: true, linkSupport: true },
            implementation: { dynamicRegistration: true, linkSupport: true },
            references: { dynamicRegistration: true },
            documentHighlight: { dynamicRegistration: true },
            linkedEditingRange: { dynamicRegistration: true },
            documentSymbol: {
              dynamicRegistration: true,
              hierarchicalDocumentSymbolSupport: true,
            },
            codeLens: { dynamicRegistration: true },
            rename: { dynamicRegistration: true, prepareSupport: true },
            codeAction: {
              dynamicRegistration: true,
              dataSupport: true,
              resolveSupport: { properties: ['edit', 'command'] },
              codeActionLiteralSupport: {
                codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'source'] },
              },
            },
            formatting: { dynamicRegistration: true },
            rangeFormatting: { dynamicRegistration: true },
            onTypeFormatting: { dynamicRegistration: true },
            documentLink: {
              dynamicRegistration: true,
              tooltipSupport: true,
            },
            colorProvider: { dynamicRegistration: true },
            foldingRange: {
              dynamicRegistration: true,
              lineFoldingOnly: true,
              foldingRangeKind: { valueSet: ['comment', 'imports', 'region'] },
            },
            selectionRange: { dynamicRegistration: true },
            semanticTokens: {
              dynamicRegistration: true,
              requests: { range: true, full: { delta: true } },
              tokenTypes: [
                'namespace', 'type', 'class', 'enum', 'interface', 'struct',
                'typeParameter', 'parameter', 'variable', 'property', 'enumMember',
                'event', 'function', 'method', 'macro', 'keyword', 'modifier',
                'comment', 'string', 'number', 'regexp', 'operator', 'decorator',
              ],
              tokenModifiers: [
                'declaration', 'definition', 'readonly', 'static', 'deprecated',
                'abstract', 'async', 'modification', 'documentation', 'defaultLibrary',
              ],
              formats: ['relative'],
              overlappingTokenSupport: false,
              multilineTokenSupport: false,
            },
            inlayHint: { dynamicRegistration: true, resolveSupport: {
              properties: ['tooltip', 'textEdits', 'label.tooltip', 'label.location', 'label.command'],
            } },
            callHierarchy: { dynamicRegistration: true },
          },
        },
      }), 10_000, `${spec.name} did not finish initializing.`);
      const capabilities = normalizeLanguageServerCapabilities(initialization);
      session = {
        key,
        projectPath,
        root,
        spec,
        child,
        connection,
        baseCapabilities: capabilities,
        registrations: new Map(),
        languageIds: new Set([languageId]),
        documents: new Map(),
        idleTimer: null,
        closing: false,
      };
      this.sessions.set(key, session);
      this.restartFailures.delete(key);
      connection.sendNotification('initialized', {});
      this.states.set(key, this.emitStatus(
        projectPath,
        languageId,
        spec,
        'ready',
        undefined,
        capabilities,
      ));
      return session;
    } catch (error) {
      if (session) {
        session.closing = true;
        this.sessions.delete(key);
      }
      try { connection.dispose(); } catch { /* failed initialization */ }
      await shutdownStdioChild({ _process: child, pid: child.pid }, { graceMs: 200 }).catch(() => false);
      const delayMs = this.recordRestartFailure(key);
      const stderrDetail = stderr.trim().split(/\r?\n/).at(-1)?.slice(0, 500);
      this.emitStatus(
        projectPath,
        languageId,
        spec,
        'error',
        [
          error instanceof Error ? error.message : String(error),
          stderrDetail,
          `Retrying after ${Math.ceil(delayMs / 1_000)}s.`,
        ].filter(Boolean).join(' '),
      );
      return null;
    }
  }

  private scheduleIdle(session: ServerSession): void {
    if (session.documents.size || session.closing) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => { void this.stop(session); }, LANGUAGE_SERVER_IDLE_MS);
    session.idleTimer.unref?.();
  }

  async document(
    projectPath: string,
    root: string,
    input: DesktopLspDocumentInput,
  ): Promise<DesktopLspServerState> {
    let spec: LanguageServerSpec | null;
    try {
      spec = await this.specFor(root, input.languageId);
    } catch (error) {
      return this.emitStatus(
        projectPath,
        input.languageId,
        null,
        'error',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!spec) return publicState(null, 'unsupported');
    const uri = pathToFileURL(projectEntryPathIn(root, input.relPath)).toString();
    const key = sessionKey(root, spec);
    // A late renderer cleanup must never start a server merely to close a
    // document. This also makes parked editor teardown safe after idle stop.
    const session = input.kind === 'close'
      ? this.sessions.get(key) ?? null
      : await this.ensure(projectPath, root, input.languageId, spec);
    if (!session) {
      return this.states.get(key) ?? publicState(
        spec,
        input.kind === 'close' ? 'stopped' : 'missing',
      );
    }
    session.languageIds.add(input.languageId);
    const documentCapabilities = () => capabilitiesWithDynamicRegistrations(
      session.baseCapabilities,
      session.registrations.values(),
      input.languageId,
      uri,
    );
    const known = session.documents.has(uri);
    if (input.kind === 'close') {
      if (known) {
        session.connection.sendNotification('textDocument/didClose', { textDocument: { uri } });
        session.documents.delete(uri);
        this.emitDiagnostics({
          projectPath,
          relPath: input.relPath,
          uri,
          server: spec.name,
          diagnostics: [],
        });
      }
      this.scheduleIdle(session);
      return publicState(spec, 'ready', undefined, documentCapabilities());
    }
    if (!known) {
      // A crashed/restarted server lost its documents map; promote any
      // change/save on an unopened document back to didOpen so requests
      // and diagnostics keep working without reopening the tab.
      session.connection.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: input.languageId,
          version: input.version,
          text: input.content || '',
        },
      });
      session.documents.set(uri, {
        languageId: input.languageId,
        relPath: input.relPath,
        version: input.version,
      });
    } else if (input.kind === 'save') {
      session.connection.sendNotification('textDocument/didSave', {
        textDocument: { uri },
        text: input.content || '',
      });
    } else {
      session.connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: input.version },
        contentChanges: [{ text: input.content || '' }],
      });
      session.documents.set(uri, {
        languageId: input.languageId,
        relPath: input.relPath,
        version: input.version,
      });
    }
    return publicState(spec, 'ready', undefined, documentCapabilities());
  }

  async request(
    projectPath: string,
    root: string,
    relPath: string,
    languageId: string,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<DesktopLspRequestResult> {
    let spec: LanguageServerSpec | null;
    try {
      spec = await this.specFor(root, languageId);
    } catch (error) {
      return {
        available: false,
        status: 'error',
        server: '',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (!spec) return { available: false, status: 'unsupported', server: '' };
    const session = await this.ensure(projectPath, root, languageId, spec);
    if (!session) {
      const state = this.states.get(sessionKey(root, spec)) ?? publicState(spec, 'missing');
      return { available: false, status: state.status, server: state.server, detail: state.detail };
    }
    const uri = pathToFileURL(projectEntryPathIn(root, relPath)).toString();
    const capabilities = capabilitiesWithDynamicRegistrations(
      session.baseCapabilities,
      session.registrations.values(),
      languageId,
      uri,
    );
    if (!methodSupported(method, capabilities)) {
      return publicState(
        spec,
        'ready',
        `${spec.name} does not support ${method}.`,
        capabilities,
      );
    }
    try {
      const result = await withTimeout(
        session.connection.sendRequest(method, languageServerRequestParams(uri, method, params)),
        15_000,
        `${spec.name} request timed out.`,
      );
      return {
        available: true,
        status: 'ready',
        server: spec.name,
        capabilities,
        result,
      };
    } catch (error) {
      return {
        available: true,
        status: 'error',
        server: spec.name,
        capabilities,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async stop(session: ServerSession): Promise<void> {
    if (session.closing) return;
    session.closing = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    this.sessions.delete(session.key);
    try {
      await withTimeout(session.connection.sendRequest('shutdown'), 1_000, 'shutdown timeout');
      session.connection.sendNotification('exit');
    } catch {
      // Forceful tree cleanup below covers an unresponsive server.
    }
    try { session.connection.dispose(); } catch { /* already closed */ }
    await shutdownStdioChild(
      { _process: session.child, pid: session.child.pid },
      { graceMs: 500 },
    ).catch(() => false);
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    await Promise.all(sessions.map((session) => this.stop(session)));
    this.sessions.clear();
  }
}
