import type { ComponentProps, ReactNode } from "react";

import { PaneConversation } from "./app-snapshot-views";
import { shouldFocusSurfaceInput } from "./surface-input-focus";

export function AppConversationPaneSurface(props: {
  focused: boolean;
  focusPane(): void;
  handoffActive: boolean;
  title: string;
  projectLabel: string;
  titleContent: ReactNode;
  conversationProps: ComponentProps<typeof PaneConversation>;
}) {
  const {
    focused,
    focusPane,
    handoffActive,
    conversationProps,
  } = props;
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
      <div className="pane-surface-body">
        <div className="pane-chat-surface">
          <PaneConversation {...conversationProps} />
        </div>
      </div>
    </div>
  );
}
