// The Workflows panel's editors (WorkflowsView.tsx): the work-rules pack, agent
// and route editors, the loading dialog while a definition is read, and the
// saves, deletions and on/off switches they make.
import { useRef, useState } from 'react';
import { WORKFLOW_AGENT_KIND } from '../../../../src/runtime/shared/agent-route-config.mjs';
import type { DesktopApi, DesktopModelOption, DesktopModelSelection } from '../shared/contract';
import type { RecordValue, Snapshot } from './desktop-types';
import { draftModelSelectionFromSnapshot } from './draft-pane-prefs-store';
import { t } from './i18n';
import { showDesktopToast } from './notifications';
import { record } from './record-utils';
import { announceSetupChange } from './setup-change-refresh';
import { SidebarLoadingDialog } from './sidebar-dialog';
import { useSidebarPanelDismiss } from './sidebar-panel-surface';
import { useEditorModelCatalog } from './use-editor-model-catalog';
import type { useSidebarCapabilityRunner } from './use-sidebar-capability-runner';
import { AgentEditorDialog, RouteEditorDialog, type RouteEditorTarget, WorkflowEditorDialog } from './workflow-dialogs';
import { ownRoute } from './workflows-agent-rows';

type CapabilityRunner = ReturnType<typeof useSidebarCapabilityRunner>;
type EditorState = { pack: RecordValue | null; deletable: boolean; armDelete?: boolean };
type AgentEditorState = { agent: RecordValue | null; deletable: boolean; armDelete?: boolean };

export function useWorkflowEditors({
  api,
  active,
  run,
  setError,
  setMainRoute,
  onDismiss,
}: {
  api: Partial<Pick<DesktopApi, 'invokeCapability' | 'setModelRoute'>> | undefined;
  active: boolean;
  run: CapabilityRunner['run'];
  setError(error: string): void;
  setMainRoute(route: RecordValue): void;
  /** The panel deactivated: anything else it shows over the lists closes too. */
  onDismiss(): void;
}) {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [agentEditor, setAgentEditor] = useState<AgentEditorState | null>(null);
  const [routeEditor, setRouteEditor] = useState<RouteEditorTarget | null>(null);
  const [loadingEditor, setLoadingEditor] = useState<{ kind: 'workflow' | 'agent'; title: string } | null>(null);
  const detailRequestRef = useRef(0);
  // Both editors portal to document.body, outside the sidebar's inert box:
  // deactivating the panel closes them and disarms pending deletions, while
  // the workflow/agent lists keep their state.
  useSidebarPanelDismiss(active, () => {
    detailRequestRef.current += 1;
    setLoadingEditor(null);
    setEditor(null);
    setAgentEditor(null);
    setRouteEditor(null);
    onDismiss();
  });

  /** Read one definition for its editor; a newer open or a dismissal drops
   *  the answer. */
  const loadDetail = async (
    kind: 'workflow' | 'agent',
    capability: 'getWorkflowPack' | 'getAgentDefinition',
    id: string,
    title: string,
    show: (value: RecordValue) => void
  ) => {
    if (!api?.invokeCapability) return;
    const requestId = ++detailRequestRef.current;
    setLoadingEditor({ kind, title });
    try {
      const result = await api.invokeCapability<RecordValue>({ capability, args: [id] });
      if (detailRequestRef.current !== requestId) return;
      setError('');
      show(record(result?.value));
    } catch (reason) {
      if (detailRequestRef.current !== requestId) return;
      showDesktopToast(reason instanceof Error ? reason.message : String(reason), 'error', {
        scope: `${kind}:open:${id}`,
      });
    } finally {
      if (detailRequestRef.current === requestId) setLoadingEditor(null);
    }
  };

  const saveWorkflow = async (payload: RecordValue) => {
    const result = await run(editor?.pack ? 'saveWorkflowPack' : 'createWorkflow', [payload]);
    if (result !== undefined) {
      setEditor(null);
      showDesktopToast(t('Saved "{{name}}".', { name: String(payload.name || payload.id) }), 'success');
    }
  };
  const deleteWorkflowPack = async (id: string) => {
    const result = await run('deleteWorkflow', [id]);
    if (result !== undefined) {
      setEditor(null);
      showDesktopToast(
        record(result).revertedToBuiltIn === true
          ? t('"{{id}}" reverted to the built-in pack.', { id })
          : t('Deleted "{{id}}".', { id }),
        'success'
      );
    }
  };
  const saveAgent = async (payload: RecordValue) => {
    // Created here, it is a workflow agent for good: the marker is written
    // once, at creation (isContactAgentId reads it).
    const result = await run('saveAgentDefinition', [
      agentEditor?.agent ? payload : { ...payload, kind: WORKFLOW_AGENT_KIND },
    ]);
    if (result !== undefined) {
      setAgentEditor(null);
      showDesktopToast(t('Saved agent "{{name}}".', { name: String(payload.name || payload.id) }), 'success');
    }
  };
  const deleteAgent = async (id: string) => {
    const result = await run('deleteAgentDefinition', [id]);
    if (result !== undefined) {
      setAgentEditor(null);
      showDesktopToast(t('Deleted agent "{{id}}".', { id }), 'success');
    }
  };
  const saveRoute = async (route: RecordValue) => {
    if (!routeEditor) return;
    if (routeEditor.capability === 'setModelRoute') {
      try {
        const snapshot = await api?.setModelRoute?.(route as unknown as DesktopModelSelection);
        if (snapshot) {
          setMainRoute({
            ...draftModelSelectionFromSnapshot(snapshot as unknown as Snapshot),
            ...(Array.isArray(route.fallbacks) && route.fallbacks.length ? { fallbacks: route.fallbacks } : {}),
          });
        }
        announceSetupChange('set_route');
        setError('');
        setRouteEditor(null);
        showDesktopToast(t('Saved "{{name}}" route.', { name: routeEditor.label }), 'success');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
      return;
    }
    const args = routeEditor.capability === 'setWebSearchRoute' ? [route] : [routeEditor.id, route];
    const result = await run(routeEditor.capability, args);
    if (result !== undefined) {
      setRouteEditor(null);
      showDesktopToast(t('Saved "{{name}}" route.', { name: routeEditor.label }), 'success');
    }
  };

  return {
    editor,
    agentEditor,
    routeEditor,
    loadingEditor,
    openEditor: (id: string, title: string, deletable: boolean, armDelete = false) =>
      loadDetail('workflow', 'getWorkflowPack', id, title, (pack) => setEditor({ pack, deletable, armDelete })),
    openAgentEditor: (id: string, title: string, deletable: boolean, armDelete = false) =>
      loadDetail('agent', 'getAgentDefinition', id, title, (agent) =>
        setAgentEditor({ agent: { ...agent, route: ownRoute(agent) }, deletable, armDelete })
      ),
    newWorkflow() {
      setError('');
      setEditor({ pack: null, deletable: false });
    },
    newAgent() {
      setError('');
      setAgentEditor({ agent: null, deletable: false });
    },
    openRoute: setRouteEditor,
    cancelLoading() {
      detailRequestRef.current += 1;
      setLoadingEditor(null);
    },
    cancelEditor() {
      setError('');
      setEditor(null);
    },
    cancelAgentEditor() {
      setError('');
      setAgentEditor(null);
    },
    cancelRouteEditor() {
      setError('');
      setRouteEditor(null);
    },
    saveWorkflow,
    deleteWorkflowPack,
    saveAgent,
    deleteAgent,
    saveRoute,
    setAgentEnabled(id: string, enabled: boolean, route: RecordValue) {
      void run('setAgentRoute', [id, enabled ? route : { disabled: true }]);
    },
  };
}

/** The open editor dialogs (only while the panel is active). */
export function WorkflowEditorDialogs({
  api,
  editors,
  models: panelModels,
  providerSetup,
  webSearchModels,
  providerNames: panelProviderNames,
  busy,
  error,
}: {
  api?: Parameters<typeof useEditorModelCatalog>[0];
  editors: ReturnType<typeof useWorkflowEditors>;
  models: DesktopModelOption[];
  providerSetup?: unknown;
  providerNames?: Record<string, string>;
  webSearchModels: DesktopModelOption[];
  busy: boolean;
  error: string;
}) {
  const { editor, agentEditor, routeEditor, loadingEditor } = editors;
  // Opening a model editor reads the current catalog, as Settings does.
  const { models, providerNames } = useEditorModelCatalog(
    api,
    Boolean(agentEditor || routeEditor),
    panelModels,
    providerSetup,
    panelProviderNames
  );
  return (
    <>
      {loadingEditor && (
        <SidebarLoadingDialog
          title={loadingEditor.title}
          dataAttributes={{ 'data-sidebar-loading': loadingEditor.kind }}
          onClose={editors.cancelLoading}
        />
      )}
      {editor && (
        <WorkflowEditorDialog
          key={String(record(editor.pack).id || '(new)')}
          pack={editor.pack}
          deletable={editor.deletable}
          busy={busy}
          error={error}
          onCancel={editors.cancelEditor}
          onSave={(payload) => void editors.saveWorkflow(payload)}
          onDelete={() => void editors.deleteWorkflowPack(String(record(editor.pack).id || ''))}
          armDelete={editor.armDelete}
        />
      )}
      {agentEditor && (
        <AgentEditorDialog
          key={String(record(agentEditor.agent).id || '(new-agent)')}
          agent={agentEditor.agent}
          deletable={agentEditor.deletable}
          models={models}
          providerNames={providerNames}
          busy={busy}
          error={error}
          onCancel={editors.cancelAgentEditor}
          onSave={(payload) => void editors.saveAgent(payload)}
          onToggle={(enabled, route) =>
            editors.setAgentEnabled(String(record(agentEditor.agent).id || ''), enabled, route)
          }
          onDelete={() => void editors.deleteAgent(String(record(agentEditor.agent).id || ''))}
          armDelete={agentEditor.armDelete}
        />
      )}
      {routeEditor && (
        <RouteEditorDialog
          key={`${routeEditor.capability}:${routeEditor.id}`}
          target={routeEditor}
          models={routeEditor.modelKind === 'webSearch' ? webSearchModels : models}
          providerNames={providerNames}
          busy={busy}
          error={error}
          onCancel={editors.cancelRouteEditor}
          onToggle={(enabled, route) => editors.setAgentEnabled(routeEditor.id, enabled, route)}
          onSave={(route) => void editors.saveRoute(route)}
        />
      )}
    </>
  );
}
