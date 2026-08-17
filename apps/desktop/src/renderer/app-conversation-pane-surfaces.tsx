import type { ComponentProps, ReactNode } from "react";

import { PaneConversation } from "./app-snapshot-views";
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
