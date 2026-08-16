import type { ComponentProps, ReactNode } from "react";

import type { WorkspaceSelection } from "./navigation";
import {
  AgentSessionConversation,
  PaneConversation,
} from "./app-snapshot-views";
import { shouldFocusSurfaceInput } from "./surface-input-focus";

export function AppConversationPaneSurface({
  focused,
  focusPane,
  handoffActive,
  title,
  projectLabel,
  titleContent,
  headerStatus,
  conversationProps,
}: {
  focused: boolean;
  focusPane(): void;
  handoffActive: boolean;
  title: string;
  projectLabel: string;
  titleContent: ReactNode;
  headerStatus: ReactNode;
  conversationProps: ComponentProps<typeof PaneConversation>;
}) {
  return (
    <div className="workspace"
      data-conversation-handoff={handoffActive ? "true" : undefined}
      inert={handoffActive ? true : undefined}
      aria-hidden={handoffActive ? true : undefined}
      onPointerDownCapture={focused ? undefined : (event) => {
        if (event.button === 0) focusPane();
      }}
      onClick={(event) => {
        if (!shouldFocusSurfaceInput(event, ".transcript")) return;
        if (!focused) focusPane();
        event.currentTarget
          .querySelector<HTMLTextAreaElement>("form.composer textarea")
          ?.focus({ preventScroll: true });
      }}>
      <header className="session-header" aria-label="Current task">
        <div className="session-header-content">
          <h1 data-tooltip={title}>{titleContent}</h1>
          {projectLabel && <span className="session-project-badge">{projectLabel}</span>}
          <div className="session-header-status">{headerStatus}</div>
        </div>
      </header>
      <div className="pane-surface-body">
        <div className="pane-chat-surface">
          <PaneConversation {...conversationProps} />
        </div>
      </div>
    </div>
  );
}

export function AppAgentSessionPaneSurface({
  paneSelection,
  focused,
  focusPane,
}: {
  paneSelection: Extract<WorkspaceSelection, { kind: "agent-session" }>;
  focused: boolean;
  focusPane(): void;
}) {
  return (
    <div className="workspace agent-session-workspace"
      data-agent-session-id={paneSelection.id}
      onPointerDownCapture={focused ? undefined : (event) => {
        if (event.button === 0) focusPane();
      }}>
      <header className="session-header" aria-label="Agent session">
        <div className="session-header-content">
          <h1 data-tooltip={paneSelection.title}>{paneSelection.title}</h1>
          <span className="session-project-badge">Read only</span>
        </div>
      </header>
      <div className="pane-surface-body">
        <div className="pane-chat-surface">
          <AgentSessionConversation sessionId={paneSelection.id} />
        </div>
      </div>
    </div>
  );
}
