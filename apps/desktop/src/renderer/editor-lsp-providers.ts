// One Monaco provider per capability the language server declared, plus the
// commands the payloads those providers hand back invoke. Registration is
// claimed per language and per feature, so a server that re-announces the same
// capability never installs a second provider — and nothing here is disposed,
// because a provider outlives every editor that uses it.
import { monaco } from './monaco-setup';
import type { DesktopLspCapabilities } from '../shared/contract';
import {
  completionKind,
  lspLocations,
  lspPosition,
  lspRange,
  lspTextEdits,
  markupText,
  monacoPosition,
  monacoRange,
  recordOf,
} from './editor-lsp-conversion';
import { graphContextsByModel, preparePeekModels } from './editor-monaco-providers';

const lspProviderFeaturesByLanguage = new Map<string, Set<string>>();
let lspWorkspaceEditCommandInstalled = false;
let lspCodeActionCommandInstalled = false;
let lspCommandInstalled = false;
const APPLY_LSP_WORKSPACE_EDIT = 'mixdog.editor.applyLspWorkspaceEdit';
const APPLY_LSP_CODE_ACTION = 'mixdog.editor.applyLspCodeAction';
const EXECUTE_LSP_COMMAND = 'mixdog.editor.executeLspCommand';

function signatureParameterLabel(rawLabel: unknown): string | [number, number] | null {
  if (typeof rawLabel === 'string') return rawLabel;
  if (Array.isArray(rawLabel) && rawLabel.length === 2) return [Number(rawLabel[0]), Number(rawLabel[1])];
  return null;
}

function lspDiagnosticSeverity(severity: number) {
  if (severity >= monaco.MarkerSeverity.Error) return 1;
  if (severity >= monaco.MarkerSeverity.Warning) return 2;
  return 3;
}

function inlayHintLabel(rawLabel: unknown, modelUri: string) {
  if (typeof rawLabel === 'string') return rawLabel;
  if (!Array.isArray(rawLabel)) return '';
  return rawLabel.flatMap((item) => {
    const part = recordOf(item);
    if (!part || typeof part.value !== 'string') return [];
    const location = recordOf(part.location);
    const locationContext = graphContextsByModel.get(modelUri)?.current;
    const locations = locationContext && location ? lspLocations(location, locationContext) : [];
    return [
      {
        label: part.value,
        tooltip: markupText(part.tooltip) || undefined,
        command: lspCommand(part.command, modelUri),
        location: locations[0],
      },
    ];
  });
}

function inlayHintKind(value: unknown) {
  const kind = Number(value);
  if (kind === 1) return monaco.languages.InlayHintKind.Type;
  if (kind === 2) return monaco.languages.InlayHintKind.Parameter;
  return undefined;
}

function lspCommand(value: unknown, modelUri: string): import('monaco-editor').languages.Command | undefined {
  const command = recordOf(value);
  if (!command || typeof command.command !== 'string') return undefined;
  return {
    id: EXECUTE_LSP_COMMAND,
    title: typeof command.title === 'string' ? command.title : command.command,
    arguments: [modelUri, command],
  };
}

function signatureHelpFromLsp(value: unknown): import('monaco-editor').languages.SignatureHelp | null {
  const help = recordOf(value);
  if (!help || !Array.isArray(help.signatures)) return null;
  const signatures = help.signatures.flatMap((raw) => {
    const signature = recordOf(raw);
    if (!signature || typeof signature.label !== 'string') return [];
    const parameters = (Array.isArray(signature.parameters) ? signature.parameters : []).flatMap((parameter) => {
      const row = recordOf(parameter);
      const label = signatureParameterLabel(row?.label);
      if (label === null) return [];
      return [
        {
          label,
          documentation: markupText(row?.documentation) || undefined,
        },
      ];
    });
    return [
      {
        label: signature.label,
        documentation: markupText(signature.documentation) || undefined,
        parameters,
        activeParameter: Number.isFinite(Number(signature.activeParameter))
          ? Number(signature.activeParameter)
          : undefined,
      },
    ];
  });
  if (!signatures.length) return null;
  return {
    signatures,
    activeSignature: Math.max(0, Number(help.activeSignature) || 0),
    activeParameter: Math.max(0, Number(help.activeParameter) || 0),
  };
}

function linkedEditingWordPattern(value: unknown): RegExp | undefined {
  if (typeof value !== 'string' || !value || value.length > 1_024) return undefined;
  try {
    return new RegExp(value);
  } catch {
    return undefined;
  }
}

function semanticTokenData(value: unknown): Uint32Array {
  return Uint32Array.from(
    (Array.isArray(value) ? value : []).slice(0, 1_000_000).map((entry) => Math.max(0, Number(entry) || 0))
  );
}

function claimLspProviderFeature(languageId: string, feature: string): boolean {
  const registered = lspProviderFeaturesByLanguage.get(languageId) ?? new Set<string>();
  if (registered.has(feature)) return false;
  registered.add(feature);
  lspProviderFeaturesByLanguage.set(languageId, registered);
  return true;
}

type LspCapabilities = DesktopLspCapabilities | undefined;

/** Every provider the declared capabilities call for, in the order Monaco sees
 *  them. Each group claims its own features, so nothing is installed twice. */
export function registerLspCapabilityProviders(languageId: string, capabilities: LspCapabilities): void {
  registerLspNavigationProviders(languageId, capabilities);
  registerLspCursorProviders(languageId, capabilities);
  registerLspAnnotationProviders(languageId, capabilities);
  registerLspEditProviders(languageId, capabilities);
  registerLspDocumentProviders(languageId, capabilities);
  registerLspOverlayProviders(languageId, capabilities);
}

/** A position, answered with the locations a peek widget can render. */
function registerLspNavigationProviders(languageId: string, capabilities: LspCapabilities): void {
  if (capabilities?.typeDefinition && claimLspProviderFeature(languageId, 'typeDefinition')) {
    monaco.languages.registerTypeDefinitionProvider(languageId, {
      async provideTypeDefinition(model, position) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.typeDefinition) return [];
        return preparePeekModels(
          context,
          model,
          lspLocations(
            await context.requestLsp('textDocument/typeDefinition', { position: lspPosition(position) }),
            context
          )
        );
      },
    });
  }
  if (capabilities?.declaration && claimLspProviderFeature(languageId, 'declaration')) {
    monaco.languages.registerDeclarationProvider(languageId, {
      async provideDeclaration(model, position) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.declaration) return [];
        return preparePeekModels(
          context,
          model,
          lspLocations(
            await context.requestLsp('textDocument/declaration', { position: lspPosition(position) }),
            context
          )
        );
      },
    });
  }
  if (capabilities?.implementation && claimLspProviderFeature(languageId, 'implementation')) {
    monaco.languages.registerImplementationProvider(languageId, {
      async provideImplementation(model, position) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.implementation) return [];
        return preparePeekModels(
          context,
          model,
          lspLocations(
            await context.requestLsp('textDocument/implementation', { position: lspPosition(position) }),
            context
          )
        );
      },
    });
  }
}

/** What the server has to say about the cursor: suggestions, the signature it
 *  sits inside, and the hover behind it. */
function registerLspCursorProviders(languageId: string, capabilities: LspCapabilities): void {
  if (capabilities?.completion && claimLspProviderFeature(languageId, 'completion')) {
    const completionPayloads = new WeakMap<
      object,
      {
        modelUri: string;
        raw: Record<string, unknown>;
      }
    >();
    monaco.languages.registerCompletionItemProvider(languageId, {
      triggerCharacters: capabilities.completionTriggerCharacters,
      async provideCompletionItems(model, position) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.completion) return { suggestions: [] };
        const result = await context.requestLsp('textDocument/completion', {
          position: lspPosition(position),
          context: { triggerKind: 1 },
        });
        const record = recordOf(result);
        const listItems = Array.isArray(record?.items) ? record.items : [];
        const items = Array.isArray(result) ? result : listItems;
        const word = model.getWordUntilPosition(position);
        const fallbackRange = new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn
        );
        return {
          suggestions: items.slice(0, 500).flatMap((item) => {
            const row = recordOf(item);
            if (!row) return [];
            const textEdit = recordOf(row.textEdit);
            const range = monacoRange(textEdit?.range ?? textEdit?.replace) ?? fallbackRange;
            const rawLabel = recordOf(row.label)?.label ?? row.label;
            const label = typeof rawLabel === 'string' ? rawLabel : '';
            if (!label) return [];
            const suggestion: import('monaco-editor').languages.CompletionItem = {
              label,
              kind: completionKind(row.kind),
              detail: typeof row.detail === 'string' ? row.detail : undefined,
              documentation: markupText(row.documentation) || undefined,
              insertText: String(textEdit?.newText ?? row.insertText ?? label),
              insertTextRules:
                Number(row.insertTextFormat) === 2
                  ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                  : undefined,
              sortText: typeof row.sortText === 'string' ? row.sortText : undefined,
              filterText: typeof row.filterText === 'string' ? row.filterText : undefined,
              commitCharacters: Array.isArray(row.commitCharacters)
                ? row.commitCharacters.filter((entry): entry is string => typeof entry === 'string')
                : undefined,
              additionalTextEdits: lspTextEdits(row.additionalTextEdits),
              command: lspCommand(row.command, model.uri.toString()),
              preselect: row.preselect === true,
              tags:
                row.deprecated === true || (Array.isArray(row.tags) && row.tags.includes(1))
                  ? [monaco.languages.CompletionItemTag.Deprecated]
                  : undefined,
              range,
            };
            completionPayloads.set(suggestion, {
              modelUri: model.uri.toString(),
              raw: row,
            });
            return [suggestion];
          }),
        };
      },
      async resolveCompletionItem(item) {
        const payload = completionPayloads.get(item);
        const context = payload ? graphContextsByModel.get(payload.modelUri)?.current : undefined;
        if (!payload || !context?.requestLsp || !context.lspCapabilities?.completionResolve) {
          return item;
        }
        const resolved = recordOf(await context.requestLsp('completionItem/resolve', payload.raw));
        if (!resolved) return item;
        return {
          ...item,
          detail: typeof resolved.detail === 'string' ? resolved.detail : item.detail,
          documentation: markupText(resolved.documentation) || item.documentation,
        };
      },
    });
  }
  if (capabilities?.signatureHelp && claimLspProviderFeature(languageId, 'signatureHelp')) {
    monaco.languages.registerSignatureHelpProvider(languageId, {
      signatureHelpTriggerCharacters: capabilities.signatureHelpTriggerCharacters,
      signatureHelpRetriggerCharacters: capabilities.signatureHelpRetriggerCharacters,
      async provideSignatureHelp(model, position, token, helpContext) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.signatureHelp || token.isCancellationRequested)
          return null;
        const result = signatureHelpFromLsp(
          await context.requestLsp('textDocument/signatureHelp', {
            position: lspPosition(position),
            context: {
              triggerKind: Number(helpContext.triggerKind),
              triggerCharacter: helpContext.triggerCharacter,
              isRetrigger: helpContext.isRetrigger,
              activeSignatureHelp: helpContext.activeSignatureHelp,
            },
          })
        );
        return result ? { value: result, dispose() {} } : null;
      },
    });
  }
  if (capabilities?.hover && claimLspProviderFeature(languageId, 'hover')) {
    monaco.languages.registerHoverProvider(languageId, {
      async provideHover(model, position) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.hover) return null;
        const result = recordOf(await context.requestLsp('textDocument/hover', { position: lspPosition(position) }));
        const contents = markupText(result?.contents);
        if (!contents) return null;
        return {
          contents: [{ value: contents }],
          range: monacoRange(result?.range) ?? undefined,
        };
      },
    });
  }
}

/** Annotations the server attaches to the open document itself. */
function registerLspAnnotationProviders(languageId: string, capabilities: LspCapabilities): void {
  if (capabilities?.documentHighlight && claimLspProviderFeature(languageId, 'documentHighlight')) {
    monaco.languages.registerDocumentHighlightProvider(languageId, {
      async provideDocumentHighlights(model, position, token) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.documentHighlight || token.isCancellationRequested)
          return [];
        const result = await context.requestLsp('textDocument/documentHighlight', {
          position: lspPosition(position),
        });
        return (Array.isArray(result) ? result : []).flatMap((item) => {
          const row = recordOf(item);
          const range = monacoRange(row?.range);
          return range
            ? [
                {
                  range,
                  kind: Math.max(0, Math.min(2, (Number(row?.kind) || 1) - 1)),
                },
              ]
            : [];
        });
      },
    });
  }
  if (capabilities?.linkedEditingRange && claimLspProviderFeature(languageId, 'linkedEditingRange')) {
    monaco.languages.registerLinkedEditingRangeProvider(languageId, {
      async provideLinkedEditingRanges(model, position, token) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.linkedEditingRange || token.isCancellationRequested)
          return null;
        const result = recordOf(
          await context.requestLsp('textDocument/linkedEditingRange', { position: lspPosition(position) })
        );
        const ranges = (Array.isArray(result?.ranges) ? result.ranges : []).flatMap((item) => {
          const range = monacoRange(item);
          return range ? [range] : [];
        });
        return ranges.length
          ? {
              ranges,
              wordPattern: linkedEditingWordPattern(result?.wordPattern),
            }
          : null;
      },
    });
  }
  if (capabilities?.codeLens && claimLspProviderFeature(languageId, 'codeLens')) {
    const codeLensPayloads = new WeakMap<object, { modelUri: string; raw: Record<string, unknown> }>();
    const toCodeLens = (
      modelUri: string,
      raw: Record<string, unknown>
    ): import('monaco-editor').languages.CodeLens | null => {
      const range = monacoRange(raw.range);
      if (!range) return null;
      const lens: import('monaco-editor').languages.CodeLens = {
        range,
        command: lspCommand(raw.command, modelUri),
      };
      codeLensPayloads.set(lens, { modelUri, raw });
      return lens;
    };
    monaco.languages.registerCodeLensProvider(languageId, {
      async provideCodeLenses(model, token) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.codeLens || token.isCancellationRequested)
          return { lenses: [], dispose() {} };
        const result = await context.requestLsp('textDocument/codeLens');
        return {
          lenses: (Array.isArray(result) ? result : []).flatMap((item) => {
            const row = recordOf(item);
            const lens = row ? toCodeLens(model.uri.toString(), row) : null;
            return lens ? [lens] : [];
          }),
          dispose() {},
        };
      },
      async resolveCodeLens(_model, lens) {
        const payload = codeLensPayloads.get(lens);
        const context = payload ? graphContextsByModel.get(payload.modelUri)?.current : undefined;
        if (!payload || !context?.requestLsp || !context.lspCapabilities?.codeLensResolve) {
          return lens;
        }
        const resolved = recordOf(await context.requestLsp('codeLens/resolve', payload.raw));
        return resolved ? (toCodeLens(payload.modelUri, resolved) ?? lens) : lens;
      },
    });
  }
}

/** The edits a server writes: a rename, a code action, and formatting. Each one
 *  reaches the files through the pane's own confirmed workspace edit. */
function registerLspEditProviders(languageId: string, capabilities: LspCapabilities): void {
  if (capabilities?.rename && claimLspProviderFeature(languageId, 'rename')) {
    monaco.languages.registerRenameProvider(languageId, {
      async resolveRenameLocation(model, position) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        const word = model.getWordAtPosition(position);
        if (!context?.requestLsp || !word) return null;
        if (!context.lspCapabilities?.prepareRename) {
          return {
            range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
            text: word.word,
          };
        }
        const result = await context.requestLsp('textDocument/prepareRename', { position: lspPosition(position) });
        const record = recordOf(result);
        const range = monacoRange(record?.range ?? result);
        return range ? { range, text: String(record?.placeholder ?? word.word) } : null;
      },
      async provideRenameEdits(model, position, newName) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.applyWorkspaceEdit) {
          return { edits: [], rejectReason: 'Language server is unavailable.' };
        }
        const edit = await context.requestLsp('textDocument/rename', {
          position: lspPosition(position),
          newName,
        });
        if (!edit || !(await context.applyWorkspaceEdit(edit, 'Rename'))) {
          return { edits: [], rejectReason: 'Rename was canceled or could not be applied safely.' };
        }
        return { edits: [] };
      },
    });
  }
  if (capabilities?.codeAction && claimLspProviderFeature(languageId, 'codeAction')) {
    const actionPayloads = new WeakMap<object, { modelUri: string; raw: Record<string, unknown> }>();
    const toCodeAction = (
      modelUri: string,
      row: Record<string, unknown>
    ): import('monaco-editor').languages.CodeAction | null => {
      const title = typeof row.title === 'string' ? row.title : '';
      if (!title) return null;
      const disabled = recordOf(row.disabled);
      const action: import('monaco-editor').languages.CodeAction = {
        title,
        kind: typeof row.kind === 'string' ? row.kind : 'quickfix',
        isPreferred: row.isPreferred === true,
        disabled: typeof disabled?.reason === 'string' ? disabled.reason : undefined,
        command: {
          id: APPLY_LSP_CODE_ACTION,
          title,
          arguments: [modelUri, row],
        },
      };
      actionPayloads.set(action, { modelUri, raw: row });
      return action;
    };
    monaco.languages.registerCodeActionProvider(
      languageId,
      {
        async provideCodeActions(model, range, actionContext) {
          const context = graphContextsByModel.get(model.uri.toString())?.current;
          if (!context?.requestLsp || !context.lspCapabilities?.codeAction) {
            return { actions: [], dispose() {} };
          }
          const diagnostics = actionContext.markers.map((marker) => {
            const code = typeof marker.code === 'object' ? marker.code.value : marker.code;
            return {
              range: {
                start: { line: marker.startLineNumber - 1, character: marker.startColumn - 1 },
                end: { line: marker.endLineNumber - 1, character: marker.endColumn - 1 },
              },
              severity: lspDiagnosticSeverity(marker.severity),
              message: marker.message,
              ...(marker.source ? { source: marker.source } : {}),
              ...(code !== undefined ? { code } : {}),
            };
          });
          const only = actionContext.only;
          const result = await context.requestLsp('textDocument/codeAction', {
            range: {
              start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
              end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
            },
            context: {
              diagnostics,
              ...(only ? { only: [only] } : {}),
              triggerKind: Number(actionContext.trigger),
            },
          });
          const rows = Array.isArray(result) ? result : [];
          return {
            actions: rows.slice(0, 100).flatMap((item) => {
              const row = recordOf(item);
              const action = row ? toCodeAction(model.uri.toString(), row) : null;
              return action ? [action] : [];
            }),
            dispose() {},
          };
        },
        async resolveCodeAction(action) {
          const payload = actionPayloads.get(action);
          const context = payload ? graphContextsByModel.get(payload.modelUri)?.current : undefined;
          if (!payload || !context?.requestLsp || !context.lspCapabilities?.codeActionResolve) return action;
          const resolved = recordOf(await context.requestLsp('codeAction/resolve', payload.raw));
          return resolved ? (toCodeAction(payload.modelUri, resolved) ?? action) : action;
        },
      },
      {
        providedCodeActionKinds: capabilities.codeActionKinds.length
          ? capabilities.codeActionKinds
          : ['quickfix', 'refactor', 'source'],
      }
    );
  }
  if (capabilities?.formatting && claimLspProviderFeature(languageId, 'formatting')) {
    monaco.languages.registerDocumentFormattingEditProvider(languageId, {
      async provideDocumentFormattingEdits(model, options) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.formatting) return [];
        const result = await context.requestLsp('textDocument/formatting', { options });
        return (Array.isArray(result) ? result : []).flatMap((item) => {
          const row = recordOf(item);
          const range = monacoRange(row?.range);
          return range && typeof row?.newText === 'string' ? [{ range, text: row.newText }] : [];
        });
      },
    });
  }
  if (capabilities?.rangeFormatting && claimLspProviderFeature(languageId, 'rangeFormatting')) {
    monaco.languages.registerDocumentRangeFormattingEditProvider(languageId, {
      async provideDocumentRangeFormattingEdits(model, range, options) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.rangeFormatting) return [];
        const result = await context.requestLsp('textDocument/rangeFormatting', {
          range: {
            start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
            end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
          },
          options,
        });
        return (Array.isArray(result) ? result : []).flatMap((item) => {
          const row = recordOf(item);
          const editRange = monacoRange(row?.range);
          return editRange && typeof row?.newText === 'string' ? [{ range: editRange, text: row.newText }] : [];
        });
      },
    });
  }
  if (capabilities?.onTypeFormatting && claimLspProviderFeature(languageId, 'onTypeFormatting')) {
    monaco.languages.registerOnTypeFormattingEditProvider(languageId, {
      autoFormatTriggerCharacters: capabilities.onTypeFormattingTriggerCharacters,
      async provideOnTypeFormattingEdits(model, position, ch, options, token) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.onTypeFormatting || token.isCancellationRequested)
          return [];
        return lspTextEdits(
          await context.requestLsp('textDocument/onTypeFormatting', { position: lspPosition(position), ch, options })
        );
      },
    });
  }
}

/** Structure read out of the document: links, colors, folding and selection. */
function registerLspDocumentProviders(languageId: string, capabilities: LspCapabilities): void {
  if (capabilities?.documentLink && claimLspProviderFeature(languageId, 'documentLink')) {
    const linkPayloads = new WeakMap<object, { modelUri: string; raw: Record<string, unknown> }>();
    const toLink = (modelUri: string, raw: Record<string, unknown>): import('monaco-editor').languages.ILink | null => {
      const range = monacoRange(raw.range);
      if (!range) return null;
      const link: import('monaco-editor').languages.ILink = {
        range,
        url: typeof raw.target === 'string' ? raw.target : undefined,
        tooltip: typeof raw.tooltip === 'string' ? raw.tooltip : undefined,
      };
      linkPayloads.set(link, { modelUri, raw });
      return link;
    };
    monaco.languages.registerLinkProvider(languageId, {
      async provideLinks(model, token) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.documentLink || token.isCancellationRequested)
          return { links: [], dispose() {} };
        const result = await context.requestLsp('textDocument/documentLink');
        return {
          links: (Array.isArray(result) ? result : []).flatMap((item) => {
            const row = recordOf(item);
            const link = row ? toLink(model.uri.toString(), row) : null;
            return link ? [link] : [];
          }),
          dispose() {},
        };
      },
      async resolveLink(link) {
        const payload = linkPayloads.get(link);
        const context = payload ? graphContextsByModel.get(payload.modelUri)?.current : undefined;
        if (!payload || !context?.requestLsp || !context.lspCapabilities?.documentLinkResolve) {
          return link;
        }
        const resolved = recordOf(await context.requestLsp('documentLink/resolve', payload.raw));
        return resolved ? (toLink(payload.modelUri, resolved) ?? link) : link;
      },
    });
  }
  if (capabilities?.documentColor && claimLspProviderFeature(languageId, 'documentColor')) {
    monaco.languages.registerColorProvider(languageId, {
      async provideDocumentColors(model, token) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.documentColor || token.isCancellationRequested) return [];
        const result = await context.requestLsp('textDocument/documentColor');
        return (Array.isArray(result) ? result : []).flatMap((item) => {
          const row = recordOf(item);
          const color = recordOf(row?.color);
          const range = monacoRange(row?.range);
          return range && color
            ? [
                {
                  range,
                  color: {
                    red: Math.max(0, Math.min(1, Number(color.red) || 0)),
                    green: Math.max(0, Math.min(1, Number(color.green) || 0)),
                    blue: Math.max(0, Math.min(1, Number(color.blue) || 0)),
                    alpha: Math.max(0, Math.min(1, Number(color.alpha) || 0)),
                  },
                },
              ]
            : [];
        });
      },
      async provideColorPresentations(model, colorInfo, token) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.documentColor || token.isCancellationRequested) return [];
        const result = await context.requestLsp('textDocument/colorPresentation', {
          color: colorInfo.color,
          range: lspRange(colorInfo.range),
        });
        return (Array.isArray(result) ? result : []).flatMap((item) => {
          const row = recordOf(item);
          if (!row || typeof row.label !== 'string') return [];
          const edits = lspTextEdits(row.additionalTextEdits);
          const textEdit = lspTextEdits(row.textEdit ? [row.textEdit] : [])[0];
          return [
            {
              label: row.label,
              textEdit,
              additionalTextEdits: edits.length ? edits : undefined,
            },
          ];
        });
      },
    });
  }
  if (capabilities?.foldingRange && claimLspProviderFeature(languageId, 'foldingRange')) {
    monaco.languages.registerFoldingRangeProvider(languageId, {
      async provideFoldingRanges(model, _foldingContext, token) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.foldingRange || token.isCancellationRequested) return [];
        const result = await context.requestLsp('textDocument/foldingRange');
        return (Array.isArray(result) ? result : []).flatMap((item) => {
          const row = recordOf(item);
          const start = Number(row?.startLine);
          const end = Number(row?.endLine);
          if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) return [];
          const kind =
            typeof row?.kind === 'string' ? monaco.languages.FoldingRangeKind.fromValue(row.kind) : undefined;
          return [{ start: start + 1, end: end + 1, kind }];
        });
      },
    });
  }
  if (capabilities?.selectionRange && claimLspProviderFeature(languageId, 'selectionRange')) {
    monaco.languages.registerSelectionRangeProvider(languageId, {
      async provideSelectionRanges(model, positions, token) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.selectionRange || token.isCancellationRequested)
          return [];
        const result = await context.requestLsp('textDocument/selectionRange', {
          positions: positions.map(lspPosition),
        });
        return (Array.isArray(result) ? result : []).map((item) => {
          const ranges: import('monaco-editor').languages.SelectionRange[] = [];
          let cursor: unknown = item;
          for (let depth = 0; depth < 100 && cursor; depth += 1) {
            const row = recordOf(cursor);
            const range = monacoRange(row?.range);
            if (!row || !range) break;
            ranges.push({ range });
            cursor = row.parent;
          }
          return ranges;
        });
      },
    });
  }
}

/** What the editor paints over the text: semantic token colors and the inline
 *  hints that stand between them. */
function registerLspOverlayProviders(languageId: string, capabilities: LspCapabilities): void {
  if (
    capabilities?.semanticTokens &&
    capabilities.semanticTokensLegend.tokenTypes.length &&
    claimLspProviderFeature(languageId, 'semanticTokens')
  ) {
    const legend = capabilities.semanticTokensLegend;
    monaco.languages.registerDocumentSemanticTokensProvider(languageId, {
      getLegend: () => legend,
      async provideDocumentSemanticTokens(model, lastResultId, token) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.semanticTokens || token.isCancellationRequested)
          return { data: new Uint32Array() };
        const delta = Boolean(lastResultId && context.lspCapabilities.semanticTokensDelta);
        const result = recordOf(
          await context.requestLsp(
            delta ? 'textDocument/semanticTokens/full/delta' : 'textDocument/semanticTokens/full',
            delta ? { previousResultId: lastResultId } : {}
          )
        );
        if (Array.isArray(result?.edits)) {
          return {
            resultId: typeof result.resultId === 'string' ? result.resultId : undefined,
            edits: result.edits.flatMap((item) => {
              const edit = recordOf(item);
              if (!edit) return [];
              return [
                {
                  start: Math.max(0, Number(edit.start) || 0),
                  deleteCount: Math.max(0, Number(edit.deleteCount) || 0),
                  data: Array.isArray(edit.data) ? semanticTokenData(edit.data) : undefined,
                },
              ];
            }),
          };
        }
        return {
          resultId: typeof result?.resultId === 'string' ? result.resultId : undefined,
          data: semanticTokenData(result?.data),
        };
      },
      releaseDocumentSemanticTokens() {},
    });
  }
  if (
    capabilities?.semanticTokensRange &&
    capabilities.semanticTokensLegend.tokenTypes.length &&
    claimLspProviderFeature(languageId, 'semanticTokensRange')
  ) {
    const legend = capabilities.semanticTokensLegend;
    monaco.languages.registerDocumentRangeSemanticTokensProvider(languageId, {
      getLegend: () => legend,
      async provideDocumentRangeSemanticTokens(model, range, token) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.semanticTokensRange || token.isCancellationRequested)
          return { data: new Uint32Array() };
        const result = recordOf(
          await context.requestLsp('textDocument/semanticTokens/range', { range: lspRange(range) })
        );
        return {
          resultId: typeof result?.resultId === 'string' ? result.resultId : undefined,
          data: semanticTokenData(result?.data),
        };
      },
    });
  }
  if (capabilities?.inlayHint && claimLspProviderFeature(languageId, 'inlayHint')) {
    const hintPayloads = new WeakMap<object, { modelUri: string; raw: Record<string, unknown> }>();
    const toHint = (
      modelUri: string,
      raw: Record<string, unknown>
    ): import('monaco-editor').languages.InlayHint | null => {
      const position = monacoPosition(raw.position);
      if (!position) return null;
      const label = inlayHintLabel(raw.label, modelUri);
      if (!label || (Array.isArray(label) && !label.length)) return null;
      const hint: import('monaco-editor').languages.InlayHint = {
        label,
        position,
        kind: inlayHintKind(raw.kind),
        tooltip: markupText(raw.tooltip) || undefined,
        textEdits: lspTextEdits(raw.textEdits),
        paddingLeft: raw.paddingLeft === true,
        paddingRight: raw.paddingRight === true,
      };
      hintPayloads.set(hint, { modelUri, raw });
      return hint;
    };
    monaco.languages.registerInlayHintsProvider(languageId, {
      async provideInlayHints(model, range, token) {
        const context = graphContextsByModel.get(model.uri.toString())?.current;
        if (!context?.requestLsp || !context.lspCapabilities?.inlayHint || token.isCancellationRequested)
          return { hints: [], dispose() {} };
        const result = await context.requestLsp('textDocument/inlayHint', { range: lspRange(range) });
        return {
          hints: (Array.isArray(result) ? result : []).flatMap((item) => {
            const row = recordOf(item);
            const hint = row ? toHint(model.uri.toString(), row) : null;
            return hint ? [hint] : [];
          }),
          dispose() {},
        };
      },
      async resolveInlayHint(hint) {
        const payload = hintPayloads.get(hint);
        const context = payload ? graphContextsByModel.get(payload.modelUri)?.current : undefined;
        if (!payload || !context?.requestLsp || !context.lspCapabilities?.inlayHintResolve) {
          return hint;
        }
        const resolved = recordOf(await context.requestLsp('inlayHint/resolve', payload.raw));
        return resolved ? (toHint(payload.modelUri, resolved) ?? hint) : hint;
      },
    });
  }
}

/** The commands a provider's payload can name: an edit or an action the server
 *  prepared, and a plain server command. Installed once for every language. */
export function ensureLspCommands(): void {
  if (!lspWorkspaceEditCommandInstalled) {
    lspWorkspaceEditCommandInstalled = true;
    monaco.editor.registerCommand(APPLY_LSP_WORKSPACE_EDIT, (_accessor, modelUri, edit) => {
      const context = graphContextsByModel.get(String(modelUri || ''))?.current;
      if (context?.applyWorkspaceEdit) void context.applyWorkspaceEdit(edit);
    });
  }
  if (!lspCodeActionCommandInstalled) {
    lspCodeActionCommandInstalled = true;
    monaco.editor.registerCommand(APPLY_LSP_CODE_ACTION, (_accessor, modelUri, rawAction) => {
      const context = graphContextsByModel.get(String(modelUri || ''))?.current;
      const action = recordOf(rawAction);
      if (!context || !action) return;
      void (async () => {
        if (
          action.edit &&
          context.applyWorkspaceEdit &&
          !(await context.applyWorkspaceEdit(action.edit, String(action.title || 'Code action')))
        )
          return;
        const nested = recordOf(action.command);
        const command = typeof action.command === 'string' ? action : nested;
        if (command && typeof command.command === 'string' && context.requestLsp) {
          await context.requestLsp('workspace/executeCommand', {
            command: command.command,
            arguments: Array.isArray(command.arguments) ? command.arguments : [],
          });
        }
      })().catch((reason) => context.onLanguageError?.(reason instanceof Error ? reason.message : String(reason)));
    });
  }
  if (!lspCommandInstalled) {
    lspCommandInstalled = true;
    monaco.editor.registerCommand(EXECUTE_LSP_COMMAND, (_accessor, modelUri, rawCommand) => {
      const context = graphContextsByModel.get(String(modelUri || ''))?.current;
      const command = recordOf(rawCommand);
      if (!context?.requestLsp || !command || typeof command.command !== 'string') return;
      void context
        .requestLsp('workspace/executeCommand', {
          command: command.command,
          arguments: Array.isArray(command.arguments) ? command.arguments : [],
        })
        .catch((reason) => context.onLanguageError?.(reason instanceof Error ? reason.message : String(reason)));
    });
  }
}
