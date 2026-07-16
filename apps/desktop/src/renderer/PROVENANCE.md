# Renderer source provenance

This renderer is Mixdog-branded original integration code. The following
MIT-licensed local source files were substantially consulted or adapted:

- `C:\Project\refs\opencode\packages\app\src\components\titlebar.tsx`
  - Adapted the compact desktop titlebar, workspace tab strip, and window-safe
    drag-region composition.
- `C:\Project\refs\opencode\packages\desktop\src\main\windows.ts`
  - Adapted the transparent Windows controls overlay so native window chrome
    continues the renderer titlebar background without a separate color block.
- `C:\Project\refs\opencode\packages\app\src\pages\home.tsx`
  - Adapted the inset, rounded workspace canvas and project-entry composition.
- `C:\Project\refs\opencode\packages\app\src\pages\layout\sidebar-shell.tsx`
- `C:\Project\refs\opencode\packages\app\src\pages\layout\sidebar-items.tsx`
  - Adapted the desktop rail proportions and responsive shell behavior. Mixdog's
    rail is intentionally limited to compact title-only session search, grouping,
    and resume actions.
- `C:\Project\refs\opencode\packages\app\src\pages\session.tsx`
- `C:\Project\refs\opencode\packages\app\src\components\session\session-new-design-view.tsx`
  - Adapted the conversation workspace proportions, compact task header, and
    centered composer/thread rhythm.
- `C:\Project\refs\opencode\packages\app\src\components\prompt-input.tsx`
- `C:\Project\refs\opencode\packages\app\src\components\dialog-select-model.tsx`
  - Adapted the raised prompt surface, model trigger hierarchy, grouped model
    picker, and compact submit/stop controls.
- `C:\Project\refs\opencode\packages\ui\src\components\provider-icon.tsx`
- `C:\Project\refs\opencode\packages\ui\src\components\icon.tsx`
- `C:\Project\refs\opencode\packages\ui\src\components\select.tsx`
- `C:\Project\refs\opencode\packages\ui\src\components\select.css`
- `C:\Project\refs\opencode\packages\ui\src\components\dialog.css`
- `C:\Project\refs\opencode\packages\ui\src\assets\icons\provider\openai.svg`
- `C:\Project\refs\opencode\packages\ui\src\assets\icons\provider\anthropic.svg`
- `C:\Project\refs\opencode\packages\ui\src\assets\icons\provider\xai.svg`
- `C:\Project\refs\opencode\packages\ui\src\assets\icons\provider\google.svg`
  - Adapted the provider icon presentation and simplified the four primary
    monochrome glyphs into the renderer's inline icon component. Adapted the
    compact menu, selected-check, raised-dialog, and focus-state primitives.
    The fixed-geometry sidebar and active-sidebar glyphs were also adapted for
    the desktop titlebar toggle.

- `C:\Project\refs\openhands\frontend\src\routes\root-layout.tsx`
  - Adapted the full-height sidebar plus content-outlet shell composition.
- `C:\Project\refs\openhands\frontend\src\components\features\conversation\conversation-main\conversation-main.tsx`
  - Adapted the independently scrolling, full-height conversation panel structure.
- `C:\Project\refs\assistant-ui\packages\ui\src\components\assistant-ui\thread.tsx`
  - Adapted the centered empty thread, sticky composer, send/cancel behavior,
    and scrollable thread viewport.
- `C:\Project\refs\tool-ui\apps\www\components\tool-ui\approval-card\approval-card.tsx`
  - Adapted approval dialog semantics, allow/deny action layout, metadata
    presentation, and Escape-to-deny behavior.
- `C:\Project\refs\tool-ui\apps\www\components\tool-ui\code-diff\code-diff.tsx`
  - Adapted the diff header, addition/deletion summary, collapsed preview, and
    show-full-diff behavior. Rendering uses the host-provided
    `@git-diff-view/react` package rather than the reference's diff package.

No OpenHands enterprise source, OpenCode backend state management, network
code, or branding was copied. The provider glyphs listed above are the only
adapted OpenCode visual assets. Mixdog's existing preload contract and backend
execution paths remain the source of all desktop behavior.
