import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type {
  DesktopLspCapabilities,
  DesktopLspRequestMethod,
  DesktopLspServerState,
} from "../shared/contract";
import { parseCodeGraphSymbols, type EditorCodeGraphMode } from "./editor-code-graph";
import {
  clearActiveEditorDocument,
  setEditorOutline,
  type EditorOutlineItem,
} from "./editor-language-store";
import {
  applyLspWorkspaceEdit,
  codeGraphOutlineItems,
  ensureGraphProviders,
  lspCapabilitiesByLanguage,
  lspDocumentSymbols,
  lspReadyLanguages,
  type EditorGraphContext,
} from "./editor-monaco-providers";

type EditorInstance = import("monaco-editor").editor.IStandaloneCodeEditor;

export function useEditorLspSession({
  editorRef,
  graphContextRef,
  callHierarchyContextKey,
  projectPath,
  relPath,
  active,
  codeGraph,
  onOutline,
  onLanguageError,
}: {
  editorRef: RefObject<EditorInstance | null>;
  graphContextRef: RefObject<EditorGraphContext>;
  callHierarchyContextKey: RefObject<import("monaco-editor").editor.IContextKey<boolean> | null>;
  projectPath: string;
  relPath: string;
  active: boolean;
  codeGraph?(mode: EditorCodeGraphMode, query: string): Promise<string>;
  onOutline(rows: EditorOutlineItem[]): void;
  onLanguageError(message: string): void;
}) {
  const api = window.mixdogDesktop;
  const [modelUri, setModelUri] = useState("");
  const [, setFeatureRevision] = useState(0);
  const lspReady = useRef(false);
  const lspCapabilities = useRef<DesktopLspCapabilities | null>(null);
  const lspCapabilitiesKey = useRef("");
  const lspLanguageId = useRef("");
  const lspLastVersion = useRef(-1);
  const lspOpenPromise = useRef<Promise<unknown> | null>(null);
  const lspAttached = useRef(false);
  const lspAttachmentEpoch = useRef(0);
  const lspReopenAt = useRef(0);
  const lspChangeTimer = useRef<number | null>(null);
  const outlineTimer = useRef<number | null>(null);
  const languageDisposables = useRef<Array<{ dispose(): void }>>([]);
  const lspMarkerSignature = useRef("");

  const publishOutline = useCallback((uri: string, rows: EditorOutlineItem[]) => {
    setEditorOutline(uri, rows);
    onOutline(rows);
  }, [onOutline]);

  const acceptLspState = useCallback((state: DesktopLspServerState, languageId: string) => {
    lspReady.current = state.available;
    lspCapabilities.current = state.capabilities ?? null;
    callHierarchyContextKey.current?.set(
      Boolean(state.available && state.capabilities?.callHierarchy),
    );
    const key = JSON.stringify(state.capabilities ?? null);
    if (state.available && state.capabilities) {
      lspCapabilitiesByLanguage.set(languageId, state.capabilities);
      lspReadyLanguages.add(languageId);
      ensureGraphProviders(languageId);
    }
    if (key !== lspCapabilitiesKey.current) {
      lspCapabilitiesKey.current = key;
      setFeatureRevision((revision) => revision + 1);
    }
  }, [callHierarchyContextKey]);

  const syncLsp = useCallback(async (kind: "change" | "save" = "change"): Promise<boolean> => {
    const model = editorRef.current?.getModel();
    if (!model || !api?.lspDocument) return false;
    if (lspOpenPromise.current) await lspOpenPromise.current.catch(() => undefined);
    if (!lspReady.current) {
      if (!lspAttached.current || Date.now() < lspReopenAt.current) return false;
      lspReopenAt.current = Date.now() + 5_000;
      const epoch = lspAttachmentEpoch.current;
      const reopening = api.lspDocument({
        kind: "open",
        projectPath,
        relPath,
        languageId: model.getLanguageId(),
        version: model.getVersionId(),
        content: model.getValue(),
      });
      lspOpenPromise.current = reopening;
      try {
        const state = await reopening;
        if (epoch !== lspAttachmentEpoch.current || !lspAttached.current) return false;
        acceptLspState(state, model.getLanguageId());
        if (!state.available) return false;
        lspLastVersion.current = model.getVersionId();
        return true;
      } catch {
        return false;
      }
    }
    const version = model.getVersionId();
    if (kind === "change" && version === lspLastVersion.current) return true;
    const state = await api.lspDocument({
      kind,
      projectPath,
      relPath,
      languageId: model.getLanguageId(),
      version,
      content: model.getValue(),
    });
    acceptLspState(state, model.getLanguageId());
    if (state.available) lspLastVersion.current = version;
    return state.available;
  }, [acceptLspState, api, editorRef, projectPath, relPath]);

  const requestLsp = useCallback(async (
    method: DesktopLspRequestMethod,
    params: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const model = editorRef.current?.getModel();
    if (!model || !api?.lspRequest || !await syncLsp("change")) return undefined;
    const response = await api.lspRequest({
      projectPath,
      relPath,
      languageId: model.getLanguageId(),
      method,
      params,
    });
    return response.available && response.status !== "error" ? response.result : undefined;
  }, [api, editorRef, projectPath, relPath, syncLsp]);

  const applyWorkspaceEdit = useCallback(async (
    edit: unknown,
    confirmationLabel?: string,
  ): Promise<boolean> => {
    try {
      onLanguageError("");
      return await applyLspWorkspaceEdit(graphContextRef.current, edit, confirmationLabel);
    } catch (reason) {
      onLanguageError(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  }, [graphContextRef, onLanguageError]);

  const updateOutline = useCallback(async (): Promise<void> => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    const raw = await requestLsp("textDocument/documentSymbol");
    const converted = lspDocumentSymbols(model, raw, graphContextRef.current);
    if (converted.outline.length) {
      publishOutline(model.uri.toString(), converted.outline);
      return;
    }
    if (!codeGraph) {
      publishOutline(model.uri.toString(), []);
      return;
    }
    try {
      const rows = parseCodeGraphSymbols(await codeGraph("symbols", relPath));
      publishOutline(
        model.uri.toString(),
        codeGraphOutlineItems(model, graphContextRef.current, rows),
      );
    } catch {
      publishOutline(model.uri.toString(), []);
    }
  }, [codeGraph, editorRef, graphContextRef, publishOutline, relPath, requestLsp]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model || !api?.lspDocument) return;
    const languageId = model.getLanguageId();
    if (active) {
      if (lspAttached.current) return;
      lspAttached.current = true;
      const epoch = ++lspAttachmentEpoch.current;
      lspLanguageId.current = languageId;
      const opening = api.lspDocument({
        kind: "open",
        projectPath,
        relPath,
        languageId,
        version: model.getVersionId(),
        content: model.getValue(),
      });
      lspOpenPromise.current = opening;
      void opening.then((state) => {
        if (epoch !== lspAttachmentEpoch.current || !lspAttached.current) return;
        acceptLspState(state, languageId);
        if (state.available) lspLastVersion.current = model.getVersionId();
        void updateOutline();
      }).catch(() => {
        if (epoch === lspAttachmentEpoch.current) lspReady.current = false;
      });
      return;
    }
    if (!lspAttached.current) return;
    lspAttached.current = false;
    lspAttachmentEpoch.current += 1;
    const pendingOpen = lspOpenPromise.current;
    lspOpenPromise.current = null;
    lspReady.current = false;
    lspLastVersion.current = -1;
    void Promise.resolve(pendingOpen).catch(() => undefined).then(() =>
      api.lspDocument!({
        kind: "close",
        projectPath,
        relPath,
        languageId: lspLanguageId.current || languageId,
        version: model.getVersionId(),
      })).catch(() => undefined);
  }, [acceptLspState, active, api, editorRef, modelUri, projectPath, relPath, updateOutline]);

  const disposeLsp = useCallback((model: import("monaco-editor").editor.ITextModel | null | undefined) => {
    if (lspChangeTimer.current !== null) window.clearTimeout(lspChangeTimer.current);
    if (outlineTimer.current !== null) window.clearTimeout(outlineTimer.current);
    for (const disposable of languageDisposables.current.splice(0)) disposable.dispose();
    if (!model) return;
    clearActiveEditorDocument(model.uri.toString());
    if (!lspAttached.current || !api?.lspDocument) return;
    lspAttached.current = false;
    lspAttachmentEpoch.current += 1;
    const pendingOpen = lspOpenPromise.current;
    lspOpenPromise.current = null;
    lspReady.current = false;
    lspLastVersion.current = -1;
    void Promise.resolve(pendingOpen).catch(() => undefined).then(() =>
      api.lspDocument!({
        kind: "close",
        projectPath,
        relPath,
        languageId: lspLanguageId.current || model.getLanguageId(),
        version: model.getVersionId(),
      })).catch(() => undefined);
  }, [api, projectPath, relPath]);

  return {
    modelUri,
    setModelUri,
    lspReady,
    lspCapabilities,
    lspChangeTimer,
    outlineTimer,
    languageDisposables,
    lspMarkerSignature,
    publishOutline,
    acceptLspState,
    syncLsp,
    requestLsp,
    applyWorkspaceEdit,
    updateOutline,
    disposeLsp,
  };
}
