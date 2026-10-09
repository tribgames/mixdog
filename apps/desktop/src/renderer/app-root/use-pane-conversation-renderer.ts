import { useMemo } from 'react';
import { createPaneConversationRenderer } from './app-conversation-pane-renderer';

type RendererOptions = Parameters<typeof createPaneConversationRenderer>[0];

export function usePaneConversationRenderer(options: RendererOptions) {
  // The dependency list names every RendererOptions field, so a rerender that
  // changes none of them keeps the same renderer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  return useMemo(
    () => createPaneConversationRenderer(options),
    [
      options.conversationHandoff,
      options.resolvedDraftPrefsFor,
      options.sessions,
      options.registeredProjectPath,
      options.projectChromeLabel,
      options.selectedSession,
      options.headerTitleEditingSessionId,
      options.headerTitleDraft,
      options.headerTitleInvalid,
      options.openHeaderTitleEditor,
      options.setHeaderTitleDraft,
      options.commitHeaderTitleEditor,
      options.closeHeaderTitleEditor,
      options.paneTranscriptRendererPending,
      options.requestedSessionId,
      options.invokeResult,
      options.errors,
      options.paneSubmitFor,
      options.paneDraftSubmitFor,
      options.submit,
      options.applySessionLaneResult,
      options.applySnapshot,
      options.composerFocusRequest,
      options.conversationNewTask,
      options.conversationClearToNewTask,
      options.conversationClearProject,
      options.conversationResumeSession,
      options.openSidebar,
      options.conversationOpenProjects,
      options.openSettings,
      options.projects,
      options.stageNewTaskModelSelection,
      options.rememberSessionRouteForNextTask,
      options.stageNewTaskWorkflow,
      options.stageNewTaskOrchestrationMode,
      options.conversationSelectProject,
      options.openConversationCommandSurface,
      options.openFileTab,
      options.openFileInSideDock,
      options.replaceWithInheritedSession,
    ]
  );
}
