import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
import { pathToFileURL } from 'node:url';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { DesktopLspCapabilities } from '../shared/contract';
// @ts-expect-error The shared runtime helper is plain ESM and has no declaration file.
import { shutdownStdioChild } from '../../../../src/runtime/agent/orchestrator/mcp/child-tree.mjs';
import { type LanguageServerState, sessionKey } from './language-server-state';
import type { LanguageServerSpec, ServerSession } from './language-server-types';

const LANGUAGE_SERVER_IDLE_MS = 30_000;

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

/** What this client declares to every server, sent verbatim in `initialize`.
 *  It describes the editor's own abilities, so it is the same for every
 *  session and is never derived from one. */
const LANGUAGE_SERVER_CLIENT_CAPABILITIES = {
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
        'namespace',
        'type',
        'class',
        'enum',
        'interface',
        'struct',
        'typeParameter',
        'parameter',
        'variable',
        'property',
        'enumMember',
        'event',
        'function',
        'method',
        'macro',
        'keyword',
        'modifier',
        'comment',
        'string',
        'number',
        'regexp',
        'operator',
        'decorator',
      ],
      tokenModifiers: [
        'declaration',
        'definition',
        'readonly',
        'static',
        'deprecated',
        'abstract',
        'async',
        'modification',
        'documentation',
        'defaultLibrary',
      ],
      formats: ['relative'],
      overlappingTokenSupport: false,
      multilineTokenSupport: false,
    },
    inlayHint: {
      dynamicRegistration: true,
      resolveSupport: {
        properties: ['tooltip', 'textEdits', 'label.tooltip', 'label.location', 'label.command'],
      },
    },
    callHierarchy: { dynamicRegistration: true },
  },
} as const;

type WithTimeout = <T>(promise: Promise<T>, timeoutMs: number, message: string) => Promise<T>;
type ObjectRecord = (value: unknown) => Record<string, unknown> | null;

interface LanguageServerProcessDependencies {
  resolveExecutable: (spec: LanguageServerSpec, root: string) => Promise<string | null>;
  spawnServer: (command: string, args: string[], cwd: string) => ChildProcessWithoutNullStreams;
  withTimeout: WithTimeout;
  languageServerInitializationOptions: (
    spec: Pick<LanguageServerSpec, 'id'>
  ) => Readonly<Record<string, unknown>> | undefined;
  normalizeLanguageServerCapabilities: (value: unknown) => DesktopLspCapabilities;
  relativeDocumentPath: (root: string, uri: string) => string | null;
  objectRecord: ObjectRecord;
}

export class LanguageServerProcessManager {
  constructor(
    private readonly state: LanguageServerState,
    private readonly dependencies: LanguageServerProcessDependencies
  ) {}

  async ensure(
    projectPath: string,
    root: string,
    languageId: string,
    spec: LanguageServerSpec
  ): Promise<ServerSession | null> {
    const key = sessionKey(root, spec);
    const live = this.state.session(key);
    if (live && !live.closing) {
      if (live.idleTimer) clearTimeout(live.idleTimer);
      live.idleTimer = null;
      return live;
    }
    const pending = this.state.startingPromise(key);
    if (pending) return pending;
    if (this.state.isMissing(key)) return null;
    if (this.state.isRestartCoolingDown(key)) return null;
    const start = this.start(projectPath, root, languageId, spec, key).finally(() => this.state.clearStarting(key));
    this.state.setStarting(key, start);
    return start;
  }

  private async start(
    projectPath: string,
    root: string,
    languageId: string,
    spec: LanguageServerSpec,
    key: string
  ): Promise<ServerSession | null> {
    this.state.emitStatus(projectPath, root, languageId, spec, 'starting');
    const executable = await this.dependencies.resolveExecutable(spec, root);
    if (!executable) {
      this.state.markMissing(key, Date.now() + 30_000);
      this.state.emitStatus(projectPath, root, languageId, spec, 'missing');
      return null;
    }
    const { child, connection, stderrTail } = this.spawnServerConnection(executable, spec, root);
    let session: ServerSession | null = null;
    const workspaceFolders = [
      {
        uri: pathToFileURL(root).toString(),
        name: root.split(/[\\/]/).at(-1) || root,
      },
    ];
    this.attachServerHandlers(connection, {
      projectPath,
      root,
      spec,
      workspaceFolders,
      session: () => session,
    });
    connection.listen();
    const closed = () => {
      if (!session || session.closing) return;
      this.reportServerStopped({ projectPath, root, languageId, spec, key, stderr: stderrTail() });
    };
    child.once('exit', closed);
    child.once('error', closed);
    try {
      const initializationOptions = this.dependencies.languageServerInitializationOptions(spec);
      const initialization = await this.dependencies.withTimeout(
        connection.sendRequest('initialize', {
          processId: process.pid,
          clientInfo: { name: 'Mixdog Desktop', version: '0.9' },
          rootUri: pathToFileURL(root).toString(),
          rootPath: root,
          workspaceFolders,
          ...(initializationOptions ? { initializationOptions } : {}),
          capabilities: LANGUAGE_SERVER_CLIENT_CAPABILITIES,
        }),
        10_000,
        `${spec.name} did not finish initializing.`
      );
      const capabilities = this.dependencies.normalizeLanguageServerCapabilities(initialization);
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
      this.state.setSession(key, session);
      this.state.clearRestartFailures(key);
      connection.sendNotification('initialized', {});
      this.state.emitStatus(projectPath, root, languageId, spec, 'ready', undefined, capabilities);
      return session;
    } catch (error) {
      return this.abandonStart(error, {
        projectPath,
        root,
        languageId,
        spec,
        key,
        connection,
        child,
        session,
        stderr: stderrTail(),
      });
    }
  }

  /** Spawns the server and speaks LSP over its stdio, keeping a bounded tail of
   *  stderr: a server that dies has said why there and nowhere else. */
  private spawnServerConnection(
    executable: string,
    spec: LanguageServerSpec,
    root: string
  ): {
    child: ChildProcessWithoutNullStreams;
    connection: ReturnType<typeof createMessageConnection>;
    stderrTail: () => string;
  } {
    const child = this.dependencies.spawnServer(executable, spec.args, root);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_000);
    });
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin)
    );
    connection.onError(() => undefined);
    return { child, connection, stderrTail: () => stderr };
  }

  /** The server-to-client half of the protocol. Registered before `listen`, so
   *  nothing a server sends immediately after `initialize` is missed. The
   *  session arrives through a getter: these handlers outlive the moment it is
   *  built, and a request that lands before it exists is answered empty. */
  private attachServerHandlers(
    connection: ReturnType<typeof createMessageConnection>,
    context: {
      projectPath: string;
      root: string;
      spec: LanguageServerSpec;
      workspaceFolders: Array<{ uri: string; name: string }>;
      session: () => ServerSession | null;
    }
  ): void {
    const { projectPath, root, spec, workspaceFolders } = context;
    connection.onRequest('workspace/configuration', (payload: unknown) => {
      const items = this.dependencies.objectRecord(payload)?.items;
      return Array.isArray(items) ? items.map(() => null) : [];
    });
    connection.onRequest('workspace/workspaceFolders', () => workspaceFolders);
    connection.onRequest('window/workDoneProgress/create', () => null);
    connection.onRequest('client/registerCapability', (payload: unknown) => {
      const session = context.session();
      if (!session) return null;
      const rows = this.dependencies.objectRecord(payload)?.registrations;
      if (!Array.isArray(rows)) return null;
      let changed = false;
      for (const raw of rows.slice(0, 256)) {
        const registration = this.dependencies.objectRecord(raw);
        const id = typeof registration?.id === 'string' ? registration.id : '';
        const method = typeof registration?.method === 'string' ? registration.method : '';
        if (!id || id.length > 256 || !DYNAMIC_CAPABILITY_METHODS.has(method)) continue;
        session.registrations.set(id, {
          method,
          registerOptions: this.dependencies.objectRecord(registration?.registerOptions) ?? {},
        });
        changed = true;
      }
      if (changed) this.state.refreshCapabilities(session);
      return null;
    });
    connection.onRequest('client/unregisterCapability', (payload: unknown) => {
      const session = context.session();
      if (!session) return null;
      const record = this.dependencies.objectRecord(payload);
      const rows = record?.unregisterations ?? record?.unregistrations;
      if (!Array.isArray(rows)) return null;
      let changed = false;
      for (const raw of rows.slice(0, 256)) {
        const registration = this.dependencies.objectRecord(raw);
        const id = typeof registration?.id === 'string' ? registration.id : '';
        if (id && session.registrations.delete(id)) changed = true;
      }
      if (changed) this.state.refreshCapabilities(session);
      return null;
    });
    connection.onRequest('workspace/applyEdit', () => ({
      applied: false,
      failureReason: 'Server-initiated edits require an explicit editor action.',
    }));
    connection.onNotification('textDocument/publishDiagnostics', (payload: unknown) => {
      if (!context.session() || !payload || typeof payload !== 'object') return;
      const record = payload as Record<string, unknown>;
      const uri = String(record.uri || '');
      const relPath = this.dependencies.relativeDocumentPath(root, uri);
      if (!relPath) return;
      const diagnostics = Array.isArray(record.diagnostics)
        ? (record.diagnostics.slice(0, 2_000) as Parameters<typeof this.state.emitDiagnostics>[0]['diagnostics'])
        : [];
      this.state.emitDiagnostics({
        projectPath,
        relPath,
        uri,
        server: spec.name,
        diagnostics,
      });
    });
  }

  /** A server that exited on its own: the session is gone and the next attempt
   *  is delayed, so the status carries both the reason and the wait. */
  private reportServerStopped(context: {
    projectPath: string;
    root: string;
    languageId: string;
    spec: LanguageServerSpec;
    key: string;
    stderr: string;
  }): void {
    this.state.deleteSession(context.key);
    const delayMs = this.state.recordRestartFailure(context.key);
    this.state.emitStatus(
      context.projectPath,
      context.root,
      context.languageId,
      context.spec,
      'stopped',
      [context.stderr.trim().split(/\r?\n/).at(-1)?.slice(0, 200), `Retrying after ${Math.ceil(delayMs / 1_000)}s.`]
        .filter(Boolean)
        .join(' ')
    );
  }

  /** A handshake that never completed: drop the half-built session, close the
   *  connection, end the child, and report why with the same retry delay. */
  private async abandonStart(
    error: unknown,
    context: {
      projectPath: string;
      root: string;
      languageId: string;
      spec: LanguageServerSpec;
      key: string;
      connection: ReturnType<typeof createMessageConnection>;
      child: ChildProcessWithoutNullStreams;
      session: ServerSession | null;
      stderr: string;
    }
  ): Promise<null> {
    if (context.session) {
      context.session.closing = true;
      this.state.deleteSession(context.key);
    }
    try {
      context.connection.dispose();
    } catch {
      /* failed initialization */
    }
    await shutdownStdioChild({ _process: context.child, pid: context.child.pid }, { graceMs: 200 }).catch(() => false);
    const delayMs = this.state.recordRestartFailure(context.key);
    const stderrDetail = context.stderr.trim().split(/\r?\n/).at(-1)?.slice(0, 500);
    this.state.emitStatus(
      context.projectPath,
      context.root,
      context.languageId,
      context.spec,
      'error',
      [
        error instanceof Error ? error.message : String(error),
        stderrDetail,
        `Retrying after ${Math.ceil(delayMs / 1_000)}s.`,
      ]
        .filter(Boolean)
        .join(' ')
    );
    return null;
  }

  scheduleIdle(session: ServerSession): void {
    if (session.documents.size || session.closing) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      void this.stop(session);
    }, LANGUAGE_SERVER_IDLE_MS);
    session.idleTimer.unref?.();
  }

  async stop(session: ServerSession): Promise<void> {
    if (session.closing) return;
    session.closing = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    this.state.deleteSession(session.key);
    try {
      await this.dependencies.withTimeout(session.connection.sendRequest('shutdown'), 1_000, 'shutdown timeout');
      session.connection.sendNotification('exit');
    } catch {
      // Forceful tree cleanup below covers an unresponsive server.
    }
    try {
      session.connection.dispose();
    } catch {
      /* already closed */
    }
    await shutdownStdioChild({ _process: session.child, pid: session.child.pid }, { graceMs: 500 }).catch(() => false);
  }

  async dispose(): Promise<void> {
    const sessions = this.state.activeSessions();
    await Promise.all(sessions.map((session) => this.stop(session)));
    this.state.clearSessions();
  }
}
