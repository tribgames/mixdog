// Navigation that works without a language server: definitions, references and
// the outline come from the code graph, and an LSP answer is preferred whenever
// the pane has one. Registered once per language, plus the opener Monaco's own
// peek widgets use to hand a cross-file target back to the pane.
import { monaco } from './monaco-setup';
import {
  codeGraphDocumentSymbols,
  codeGraphOutlineItems,
  parseCodeGraphLocations,
  parseCodeGraphSymbols,
} from './editor-code-graph';
import {
  graphLocationRange,
  graphTargetUri,
  lspLocations,
  lspPosition,
  normalizedFilePath,
} from './editor-lsp-conversion';
import {
  graphContextsByEditor,
  graphContextsByModel,
  lspDocumentSymbols,
  preparePeekModels,
} from './editor-monaco-providers';

const graphProviderLanguages = new Set<string>();
let graphEditorOpenerInstalled = false;

export function registerCodeGraphProviders(languageId: string): void {
  if (graphProviderLanguages.has(languageId)) return;
  graphProviderLanguages.add(languageId);
  monaco.languages.registerDefinitionProvider(languageId, {
    async provideDefinition(model, position, token) {
      const context = graphContextsByModel.get(model.uri.toString())?.current;
      const word = model.getWordAtPosition(position)?.word;
      if (!context || !word || token.isCancellationRequested) return [];
      try {
        if (context.requestLsp) {
          const locations = lspLocations(
            await context.requestLsp('textDocument/definition', { position: lspPosition(position) }),
            context
          );
          if (locations.length) return preparePeekModels(context, model, locations);
        }
        if (!context.codeGraph) return [];
        const rows = parseCodeGraphLocations(await context.codeGraph('find_symbol', word));
        if (token.isCancellationRequested) return [];
        return preparePeekModels(
          context,
          model,
          rows.slice(0, 20).map((location) => ({
            uri: graphTargetUri(model, context, location),
            range: graphLocationRange(location, word.length),
          }))
        );
      } catch {
        return [];
      }
    },
  });
  monaco.languages.registerReferenceProvider(languageId, {
    async provideReferences(model, position, _referenceContext, token) {
      const context = graphContextsByModel.get(model.uri.toString())?.current;
      const word = model.getWordAtPosition(position)?.word;
      if (!context || !word || token.isCancellationRequested) return [];
      try {
        if (context.requestLsp) {
          const locations = lspLocations(
            await context.requestLsp('textDocument/references', {
              position: lspPosition(position),
              context: { includeDeclaration: true },
            }),
            context
          );
          if (locations.length) return preparePeekModels(context, model, locations);
        }
        if (!context.codeGraph) return [];
        const rows = parseCodeGraphLocations(await context.codeGraph('references', word));
        if (token.isCancellationRequested) return [];
        return preparePeekModels(
          context,
          model,
          rows.slice(0, 100).map((location) => ({
            uri: graphTargetUri(model, context, location),
            range: graphLocationRange(location, word.length),
          }))
        );
      } catch {
        return [];
      }
    },
  });
  monaco.languages.registerDocumentSymbolProvider(languageId, {
    async provideDocumentSymbols(model, token) {
      const context = graphContextsByModel.get(model.uri.toString())?.current;
      if (!context || token.isCancellationRequested) return [];
      try {
        if (context.requestLsp) {
          const converted = lspDocumentSymbols(model, await context.requestLsp('textDocument/documentSymbol'), context);
          if (converted.symbols.length) {
            context.onOutline?.(converted.outline);
            return converted.symbols;
          }
        }
        if (!context.codeGraph) return [];
        const rows = parseCodeGraphSymbols(await context.codeGraph('symbols', context.relPath));
        if (token.isCancellationRequested) return [];
        const symbols = codeGraphDocumentSymbols(
          model,
          rows,
          (startLine, startColumn, endLine, endColumn) => new monaco.Range(startLine, startColumn, endLine, endColumn)
        );
        context.onOutline?.(codeGraphOutlineItems(model, context, rows));
        return symbols as import('monaco-editor').languages.DocumentSymbol[];
      } catch {
        return [];
      }
    },
  });
}

/** Monaco's own peek widgets open a cross-file target through this opener; the
 *  pane, not Monaco, decides which tab that becomes. Installed once. */
export function ensureGraphEditorOpener(): void {
  if (graphEditorOpenerInstalled) return;
  graphEditorOpenerInstalled = true;
  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      const context = graphContextsByEditor.get(source)?.current;
      if (!context?.onOpenAt) return false;
      const root = normalizedFilePath(context.projectPath);
      const target = normalizedFilePath(resource.fsPath);
      const comparableRoot = root.toLowerCase();
      const comparableTarget = target.toLowerCase();
      if (comparableTarget !== comparableRoot && !comparableTarget.startsWith(`${comparableRoot}/`)) {
        return false;
      }
      const rel = target.slice(root.length).replace(/^\/+/, '');
      if (!rel) return false;
      let line = 1;
      if (selectionOrPosition) {
        line =
          'lineNumber' in selectionOrPosition ? selectionOrPosition.lineNumber : selectionOrPosition.startLineNumber;
      }
      context.onOpenAt(rel, line);
      return true;
    },
  });
}
