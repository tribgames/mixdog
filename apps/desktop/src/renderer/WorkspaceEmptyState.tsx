// The empty workspace follows VS Code's quiet editor watermark: no pane,
// tabs, composer, actions, or product wordmark — just the brand mark and the
// small set of shortcuts that remain useful before a first task exists.
import React from "react";

// The brand path sits inset in its 256 viewBox (tile margins). Watermarks
// crop to the glyph bounds so the visible mark fills the box like VS Code's
// letterpress; chrome surfaces (titlebar) keep the inset tile framing.
export function BrandTile({ crop = false }: { crop?: boolean } = {}): React.JSX.Element {
  return (
    <svg viewBox={crop ? "57 61 142 142" : "0 0 256 256"} role="presentation">
      <path
        d="M72 178V86L128 166L184 86V178"
        fill="none" stroke="currentColor" strokeWidth="30"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function WorkspaceEmptyState(): React.JSX.Element {
  return (
    <div className="workspace-empty" data-testid="workspace-empty">
      <div className="thread-welcome">
        <span className="welcome-logo" aria-hidden="true"><BrandTile crop /></span>
        {/* Product vocabulary has ONE Project concept (user decision) — no
            "workspace" wording anywhere, including assistive labels. */}
        <h1 className="sr-only">Mixdog</h1>
        <div className="welcome-shortcuts" aria-label="Keyboard shortcuts">
          <div><span>New task</span><span className="welcome-keys"><kbd>Ctrl</kbd><i>+</i><kbd>N</kbd></span></div>
          <div><span>Switch tab</span><span className="welcome-keys"><kbd>Ctrl</kbd><i>+</i><kbd>←</kbd><i>/</i><kbd>→</kbd></span></div>
          <div><span>Switch pane</span><span className="welcome-keys"><kbd>Alt</kbd><i>+</i><kbd>←</kbd><i>/</i><kbd>→</kbd></span></div>
          <div><span>Sidebar</span><span className="welcome-keys"><kbd>Ctrl</kbd><i>+</i><kbd>B</kbd></span></div>
          <div><span>Settings</span><span className="welcome-keys"><kbd>Ctrl</kbd><i>+</i><kbd>,</kbd></span></div>
        </div>
      </div>
    </div>
  );
}
