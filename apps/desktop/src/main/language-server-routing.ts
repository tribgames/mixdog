import { pathToFileURL } from 'node:url';

import type { DesktopLspDocumentInput, DesktopLspRequestResult, DesktopLspServerState } from '../shared/contract';
import { projectEntryPathIn } from './project-files';
import { publicState, sessionKey, type LanguageServerState } from './language-server-state';
import type { LanguageServerProcessManager } from './language-server-process';
import type { CapabilityResolver, LanguageServerSpec } from './language-server-types';

type WithTimeout = <T>(promise: Promise<T>, timeoutMs: number, message: string) => Promise<T>;

interface LanguageServerRoutingDependencies {
  capabilitiesWithDynamicRegistrations: CapabilityResolver;
  methodSupported: (method: string, capabilities: Parameters<CapabilityResolver>[0]) => boolean;
  languageServerRequestParams: (
    uri: string,
    method: string,
    params: Readonly<Record<string, unknown>>
  ) => Readonly<Record<string, unknown>>;
  withTimeout: WithTimeout;
  lspDocumentLanguageId: (relPath: string, languageId: string) => string;
}

export class LanguageServerRouter {
  constructor(
    private readonly state: LanguageServerState,
    private readonly process: LanguageServerProcessManager,
    private readonly dependencies: LanguageServerRoutingDependencies
  ) {}

  async document(projectPath: string, root: string, input: DesktopLspDocumentInput): Promise<DesktopLspServerState> {
    let spec: LanguageServerSpec | null;
    try {
      spec = await this.state.specFor(root, input.languageId);
    } catch (error) {
      return this.state.emitStatus(
        projectPath,
        root,
        input.languageId,
        null,
        'error',
        error instanceof Error ? error.message : String(error)
      );
    }
    if (!spec) return publicState(null, 'unsupported');
    const uri = pathToFileURL(projectEntryPathIn(root, input.relPath)).toString();
    const key = sessionKey(root, spec);
    // A late renderer cleanup must never start a server merely to close a
    // document. This also makes parked editor teardown safe after idle stop.
    const session =
      input.kind === 'close'
        ? (this.state.session(key) ?? null)
        : await this.process.ensure(projectPath, root, input.languageId, spec);
    if (!session) {
      return this.state.state(key) ?? publicState(spec, input.kind === 'close' ? 'stopped' : 'missing');
    }
    session.languageIds.add(input.languageId);
    const documentCapabilities = () =>
      this.dependencies.capabilitiesWithDynamicRegistrations(
        session.baseCapabilities,
        session.registrations.values(),
        input.languageId,
        uri
      );
    const known = session.documents.has(uri);
    if (input.kind === 'close') {
      if (known) {
        session.connection.sendNotification('textDocument/didClose', { textDocument: { uri } });
        session.documents.delete(uri);
        this.state.emitDiagnostics({
          projectPath,
          relPath: input.relPath,
          uri,
          server: spec.name,
          diagnostics: [],
        });
      }
      this.process.scheduleIdle(session);
      return publicState(spec, 'ready', undefined, documentCapabilities());
    }
    if (!known) {
      // A crashed/restarted server lost its documents map; promote any
      // change/save on an unopened document back to didOpen so requests
      // and diagnostics keep working without reopening the tab.
      session.connection.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: this.dependencies.lspDocumentLanguageId(input.relPath, input.languageId),
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
    params: Readonly<Record<string, unknown>>
  ): Promise<DesktopLspRequestResult> {
    let spec: LanguageServerSpec | null;
    try {
      spec = await this.state.specFor(root, languageId);
    } catch (error) {
      return {
        available: false,
        status: 'error',
        server: '',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (!spec) return { available: false, status: 'unsupported', server: '' };
    const session = await this.process.ensure(projectPath, root, languageId, spec);
    if (!session) {
      const state = this.state.state(sessionKey(root, spec)) ?? publicState(spec, 'missing');
      return { available: false, status: state.status, server: state.server, detail: state.detail };
    }
    const uri = pathToFileURL(projectEntryPathIn(root, relPath)).toString();
    const capabilities = this.dependencies.capabilitiesWithDynamicRegistrations(
      session.baseCapabilities,
      session.registrations.values(),
      languageId,
      uri
    );
    if (!this.dependencies.methodSupported(method, capabilities)) {
      return publicState(spec, 'ready', `${spec.name} does not support ${method}.`, capabilities);
    }
    try {
      const result = await this.dependencies.withTimeout(
        session.connection.sendRequest(method, this.dependencies.languageServerRequestParams(uri, method, params)),
        15_000,
        `${spec.name} request timed out.`
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
}
