import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { childEnvironment } from './child-environment';

import type {
  DesktopLspCapabilities,
  DesktopLspDiagnosticEvent,
  DesktopLspDocumentInput,
  DesktopLspRequestResult,
  DesktopLspServerState,
  DesktopLspStatusEvent,
} from '../shared/contract';
import { LanguageServerProcessManager } from './language-server-process';
import { LanguageServerRouter } from './language-server-routing';
import { LanguageServerState } from './language-server-state';
import type { DynamicCapabilityRegistration, LanguageServerSpec } from './language-server-types';
import { objectRecord } from './workflow-config';

const TYPESCRIPT_LANGUAGE_SERVER: LanguageServerSpec = {
  id: 'typescript-language-server',
  name: 'TypeScript Language Server',
  command: 'typescript-language-server',
  args: ['--stdio'],
};
/** Wire language for didOpen. Monaco has no JSX languages, so a `.tsx` model
 *  reports `typescript`; typescript-language-server turns that id into a
 *  plain-TS script kind and flags every JSX element as a syntax error
 *  (1,500+ problems on a clean file). The editor-facing id stays as sent. */
export function lspDocumentLanguageId(relPath: string, languageId: string): string {
  const extension = extname(relPath).toLowerCase();
  if (extension === '.tsx' && languageId === 'typescript') return 'typescriptreact';
  if (extension === '.jsx' && languageId === 'javascript') return 'javascriptreact';
  return languageId;
}

function languageServerInitializationOptions(
  spec: Pick<LanguageServerSpec, 'id'>
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

export const SERVER_BY_LANGUAGE: Readonly<Record<string, LanguageServerSpec>> = {
  typescript: TYPESCRIPT_LANGUAGE_SERVER,
  javascript: TYPESCRIPT_LANGUAGE_SERVER,
  python: {
    id: 'pyright',
    name: 'Pyright',
    command: 'pyright-langserver',
    args: ['--stdio'],
    projectCandidates: (root) => [
      resolve(
        root,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'pyright-langserver.cmd' : 'pyright-langserver'
      ),
    ],
  },
  go: { id: 'gopls', name: 'gopls', command: 'gopls', args: [] },
  rust: { id: 'rust-analyzer', name: 'rust-analyzer', command: 'rust-analyzer', args: [] },
  c: { id: 'clangd', name: 'clangd', command: 'clangd', args: ['--background-index'] },
  cpp: { id: 'clangd', name: 'clangd', command: 'clangd', args: ['--background-index'] },
  // Keyed by Monaco language ids: `.m` reports `objective-c`, `.mm` reports `cpp`.
  'objective-c': { id: 'clangd', name: 'clangd', command: 'clangd', args: ['--background-index'] },
  ruby: { id: 'ruby-lsp', name: 'Ruby LSP', command: 'ruby-lsp', args: [] },
};

function requiredConfigString(value: unknown, name: string, maximum = 4_096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value.trim();
}

function configStringArray(value: unknown, name: string, maximumEntries: number, maximumLength = 4_096): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumEntries) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value.map((entry, index) => requiredConfigString(entry, `${name}[${index}]`, maximumLength));
}

/** Parse a trusted project-local `.mixdog/lsp.json` registry.
 *  The file may map any Monaco language id to a stdio language server, while
 *  executable candidates remain confined to the project root. */
function parseProjectLanguageServerConfig(value: unknown, root: string): Readonly<Record<string, LanguageServerSpec>> {
  const record = objectRecord(value);
  const rawServers = record?.servers;
  const serverMap = objectRecord(rawServers);
  let rows: unknown[] | null = null;
  if (Array.isArray(rawServers)) rows = rawServers;
  else if (serverMap) rows = Object.entries(serverMap).map(([id, server]) => ({ id, ...(objectRecord(server) ?? {}) }));
  if (!rows || rows.length > 64) throw new TypeError('LSP servers configuration is invalid.');
  const byLanguage: Record<string, LanguageServerSpec> = {};
  for (const [index, raw] of rows.entries()) {
    const server = objectRecord(raw);
    if (!server) throw new TypeError(`LSP server ${index} is invalid.`);
    const id = requiredConfigString(server.id, `LSP server ${index} id`, 128);
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new TypeError(`LSP server ${index} id is invalid.`);
    const command = requiredConfigString(server.command, `LSP server ${id} command`);
    const languages = configStringArray(server.languages, `LSP server ${id} languages`, 32, 128).map((language) =>
      language.toLowerCase()
    );
    const args = server.args === undefined ? [] : configStringArray(server.args, `LSP server ${id} args`, 64);
    const candidates =
      server.candidates === undefined ? [] : configStringArray(server.candidates, `LSP server ${id} candidates`, 32);
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
      name: server.name === undefined ? id : requiredConfigString(server.name, `LSP server ${id} name`, 128),
      command,
      args,
      ...(resolvedCandidates.length ? { projectCandidates: () => resolvedCandidates } : {}),
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

function providerEnabled(value: unknown): boolean {
  return value === true || Boolean(objectRecord(value));
}

function normalizeLanguageServerCapabilities(value: unknown): DesktopLspCapabilities {
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
      ? completionOptions.triggerCharacters.filter(
          (entry): entry is string => typeof entry === 'string' && entry.length > 0 && entry.length <= 8
        )
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
    semanticTokens:
      providerEnabled(semanticTokens) && (semanticTokensFull === true || Boolean(semanticTokensFullOptions)),
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

function boundedStrings(value: unknown, maximumEntries = 256): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maximumEntries)
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
        const choices = pattern
          .slice(index + 1, close)
          .split(',')
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

function dynamicRegistrationMatches(options: Record<string, unknown>, languageId: string, uri?: string): boolean {
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
      if (!matcher?.test(documentPath)) return false;
    }
    return true;
  });
}

function capabilitiesWithDynamicRegistrations(
  base: DesktopLspCapabilities,
  registrations: Iterable<DynamicCapabilityRegistration>,
  languageId: string,
  uri?: string
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
        capabilities.completionTriggerCharacters = [
          ...new Set([...capabilities.completionTriggerCharacters, ...boundedStrings(options.triggerCharacters, 64)]),
        ];
        break;
      case 'textDocument/signatureHelp':
        capabilities.signatureHelp = true;
        capabilities.signatureHelpTriggerCharacters = [
          ...new Set([
            ...capabilities.signatureHelpTriggerCharacters,
            ...boundedStrings(options.triggerCharacters, 64),
          ]),
        ];
        capabilities.signatureHelpRetriggerCharacters = [
          ...new Set([
            ...capabilities.signatureHelpRetriggerCharacters,
            ...boundedStrings(options.retriggerCharacters, 64),
          ]),
        ];
        break;
      case 'textDocument/hover':
        capabilities.hover = true;
        break;
      case 'textDocument/declaration':
        capabilities.declaration = true;
        break;
      case 'textDocument/definition':
        capabilities.definition = true;
        break;
      case 'textDocument/typeDefinition':
        capabilities.typeDefinition = true;
        break;
      case 'textDocument/implementation':
        capabilities.implementation = true;
        break;
      case 'textDocument/references':
        capabilities.references = true;
        break;
      case 'textDocument/documentHighlight':
        capabilities.documentHighlight = true;
        break;
      case 'textDocument/linkedEditingRange':
        capabilities.linkedEditingRange = true;
        break;
      case 'textDocument/documentSymbol':
        capabilities.documentSymbol = true;
        break;
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
        capabilities.codeActionKinds = [
          ...new Set([...capabilities.codeActionKinds, ...boundedStrings(options.codeActionKinds)]),
        ];
        break;
      case 'textDocument/formatting':
        capabilities.formatting = true;
        break;
      case 'textDocument/rangeFormatting':
        capabilities.rangeFormatting = true;
        break;
      case 'textDocument/onTypeFormatting':
        capabilities.onTypeFormatting = true;
        capabilities.onTypeFormattingTriggerCharacters = [
          ...new Set([
            ...capabilities.onTypeFormattingTriggerCharacters,
            ...(typeof options.firstTriggerCharacter === 'string' ? [options.firstTriggerCharacter] : []),
            ...boundedStrings(options.moreTriggerCharacter, 64),
          ]),
        ];
        break;
      case 'textDocument/documentLink':
        capabilities.documentLink = true;
        capabilities.documentLinkResolve ||= options.resolveProvider === true;
        break;
      case 'textDocument/documentColor':
        capabilities.documentColor = true;
        break;
      case 'textDocument/foldingRange':
        capabilities.foldingRange = true;
        break;
      case 'textDocument/selectionRange':
        capabilities.selectionRange = true;
        break;
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
      case 'textDocument/prepareCallHierarchy':
        capabilities.callHierarchy = true;
        break;
      case 'workspace/symbol':
        capabilities.workspaceSymbol = true;
        break;
      case 'workspace/executeCommand':
        capabilities.executeCommand = true;
        break;
      default:
        break;
    }
  }
  return capabilities;
}

function methodSupported(method: string, capabilities: DesktopLspCapabilities): boolean {
  switch (method) {
    case 'textDocument/completion':
      return capabilities.completion;
    case 'completionItem/resolve':
      return capabilities.completionResolve;
    case 'textDocument/signatureHelp':
      return capabilities.signatureHelp;
    case 'textDocument/hover':
      return capabilities.hover;
    case 'textDocument/declaration':
      return capabilities.declaration;
    case 'textDocument/definition':
      return capabilities.definition;
    case 'textDocument/typeDefinition':
      return capabilities.typeDefinition;
    case 'textDocument/implementation':
      return capabilities.implementation;
    case 'textDocument/references':
      return capabilities.references;
    case 'textDocument/documentHighlight':
      return capabilities.documentHighlight;
    case 'textDocument/linkedEditingRange':
      return capabilities.linkedEditingRange;
    case 'textDocument/documentSymbol':
      return capabilities.documentSymbol;
    case 'textDocument/codeLens':
      return capabilities.codeLens;
    case 'codeLens/resolve':
      return capabilities.codeLensResolve;
    case 'textDocument/prepareRename':
      return capabilities.prepareRename;
    case 'textDocument/rename':
      return capabilities.rename;
    case 'textDocument/codeAction':
      return capabilities.codeAction;
    case 'codeAction/resolve':
      return capabilities.codeActionResolve;
    case 'textDocument/formatting':
      return capabilities.formatting;
    case 'textDocument/rangeFormatting':
      return capabilities.rangeFormatting;
    case 'textDocument/onTypeFormatting':
      return capabilities.onTypeFormatting;
    case 'textDocument/documentLink':
      return capabilities.documentLink;
    case 'documentLink/resolve':
      return capabilities.documentLinkResolve;
    case 'textDocument/documentColor':
    case 'textDocument/colorPresentation':
      return capabilities.documentColor;
    case 'textDocument/foldingRange':
      return capabilities.foldingRange;
    case 'textDocument/selectionRange':
      return capabilities.selectionRange;
    case 'textDocument/semanticTokens/full':
      return capabilities.semanticTokens;
    case 'textDocument/semanticTokens/full/delta':
      return capabilities.semanticTokens && capabilities.semanticTokensDelta;
    case 'textDocument/semanticTokens/range':
      return capabilities.semanticTokensRange;
    case 'textDocument/inlayHint':
      return capabilities.inlayHint;
    case 'inlayHint/resolve':
      return capabilities.inlayHintResolve;
    case 'textDocument/prepareCallHierarchy':
    case 'callHierarchy/incomingCalls':
    case 'callHierarchy/outgoingCalls':
      return capabilities.callHierarchy;
    case 'workspace/symbol':
      return capabilities.workspaceSymbol;
    case 'workspace/executeCommand':
      return capabilities.executeCommand;
    default:
      return false;
  }
}

function languageServerRequestParams(
  uri: string,
  method: string,
  params: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  return method.startsWith('textDocument/') ? { ...params, textDocument: { uri } } : { ...params };
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
  const localBins =
    process.platform === 'win32'
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
  const windowsExtensions = extname(spec.command) ? [''] : ['.exe', '.cmd', '.bat', ''];
  const extensions = process.platform === 'win32' ? windowsExtensions : [''];
  for (const directory of String(process.env.PATH || '')
    .split(delimiter)
    .filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = resolve(directory.replace(/^"|"$/g, ''), `${spec.command}${extension}`);
      if (await executableFile(candidate)) return candidate;
    }
  }
  return null;
}

function spawnServer(command: string, args: string[], cwd: string): ChildProcessWithoutNullStreams {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    const commandLine = [command, ...args].map((part) => `"${part.replace(/"/g, '""')}"`).join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
      cwd,
      env: childEnvironment(),
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  return spawn(command, args, {
    cwd,
    env: childEnvironment(),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function relativeDocumentPath(root: string, uri: string): string | null {
  try {
    const absolute = resolve(fileURLToPath(uri));
    const normalizedRoot = process.platform === 'win32' ? root.toLocaleLowerCase() : root;
    const normalizedFile = process.platform === 'win32' ? absolute.toLocaleLowerCase() : absolute;
    if (
      normalizedFile !== normalizedRoot &&
      !normalizedFile.startsWith(`${normalizedRoot}\\`) &&
      !normalizedFile.startsWith(`${normalizedRoot}/`)
    )
      return null;
    return absolute
      .slice(root.length)
      .replace(/^[\\/]+/, '')
      .replace(/\\/g, '/');
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

  constructor(private readonly defaults: Readonly<Record<string, LanguageServerSpec>>) {}

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
      const specs = parseProjectLanguageServerConfig(JSON.parse(await readFile(configPath, 'utf8')), root);
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
  private readonly registry: LanguageServerRegistry;
  private readonly state: LanguageServerState;
  private readonly process: LanguageServerProcessManager;
  private readonly router: LanguageServerRouter;

  constructor(specs: Readonly<Record<string, LanguageServerSpec>> = SERVER_BY_LANGUAGE) {
    this.registry = new LanguageServerRegistry(specs);
    this.state = new LanguageServerState({
      specFor: (root, languageId) => this.registry.specFor(root, languageId),
      capabilitiesWithDynamicRegistrations,
    });
    this.process = new LanguageServerProcessManager(this.state, {
      resolveExecutable,
      spawnServer,
      withTimeout,
      languageServerInitializationOptions,
      normalizeLanguageServerCapabilities,
      relativeDocumentPath,
    });
    this.router = new LanguageServerRouter(this.state, this.process, {
      capabilitiesWithDynamicRegistrations,
      methodSupported,
      languageServerRequestParams,
      withTimeout,
      lspDocumentLanguageId,
    });
  }

  subscribeDiagnostics(listener: (event: DesktopLspDiagnosticEvent) => void): () => void {
    return this.state.subscribeDiagnostics(listener);
  }

  subscribeStatus(listener: (event: DesktopLspStatusEvent) => void): () => void {
    return this.state.subscribeStatus(listener);
  }

  async document(projectPath: string, root: string, input: DesktopLspDocumentInput): Promise<DesktopLspServerState> {
    return this.router.document(projectPath, root, input);
  }

  async request(
    projectPath: string,
    root: string,
    relPath: string,
    languageId: string,
    method: string,
    params: Readonly<Record<string, unknown>>
  ): Promise<DesktopLspRequestResult> {
    return this.router.request(projectPath, root, relPath, languageId, method, params);
  }

  async dispose(): Promise<void> {
    return this.process.dispose();
  }
}
