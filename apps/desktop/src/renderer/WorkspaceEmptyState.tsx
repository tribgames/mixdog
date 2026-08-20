// The empty workspace is a quiet editor watermark: no pane,
// tabs, composer, actions, or product wordmark — just the brand mark and the
// small set of shortcuts that remain useful before a first task exists.
import React from "react";

import { t } from "./i18n";

// 23-A is the high-contrast in-app mark. Watermarks crop to the glyph bounds
// so the visible mark fills the box like a letterpress.
export function BrandTile({ crop = false }: { crop?: boolean } = {}): React.JSX.Element {
  return (
    <svg viewBox={crop ? "45 45 166 166" : "0 0 256 256"} role="presentation">
      <g fill="none" stroke="currentColor" strokeWidth="22" strokeLinecap="round">
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" />
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(120 128 128)" />
        <path d="M116.2 61A68 68 0 0 1 191.9 104.7" transform="rotate(240 128 128)" />
      </g>
      <polygon points="128,112 133,123 144,128 133,133 128,144 123,133 112,128 123,123"
        fill="currentColor" />
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
        <div className="welcome-shortcuts" aria-label={t("Keyboard shortcuts")}>
          <div><span>{t("New task")}</span><span className="welcome-keys"><kbd>Ctrl</kbd><i>+</i><kbd>N</kbd></span></div>
          <div><span>{t("Switch tab")}</span><span className="welcome-keys"><kbd>Ctrl</kbd><i>+</i><kbd>←</kbd><i>/</i><kbd>→</kbd></span></div>
          <div><span>{t("Sidebar")}</span><span className="welcome-keys"><kbd>Ctrl</kbd><i>+</i><kbd>B</kbd></span></div>
          <div><span>{t("Settings")}</span><span className="welcome-keys"><kbd>Ctrl</kbd><i>+</i><kbd>,</kbd></span></div>
        </div>
      </div>
    </div>
  );
}
