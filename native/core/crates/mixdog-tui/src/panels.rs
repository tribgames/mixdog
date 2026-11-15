//! The panel controllers of the terminal UI: `/doctor`, `/usage`, `/context` and `/btw` (ported from `src/tui/app/doctor.mjs`,
//! `usage-context-panels.mjs`, `usage-context-panels/{context-model,usage-panel}.mjs`, `btw-controller.mjs`,
//! `use-btw-panel.mjs` and `use-context-panel-refresh.mjs`).
//!
//! * [`doctor`]: the health checks run in the core (`diagnostics/runDoctor`, which also reads the session-log migration and
//!   the data-folder rows and writes the report notice); the terminal UI only asks for them.
//! * [`context_model`]: the pure derivation of the `/context` rows and detail from the runtime's status answers.
//! * [`context`]: the `/context` panel: the reads, the claim-guarded paint, the inspector's preview fetch.
//! * [`context_refresh`]: the summarised session fields that rebuild an open `/context` panel.
//! * [`usage`]: the `/usage` provider-quota dashboard and its streamed updates.
//! * [`btw`]: the `/btw` side-question panel: its state and the controller that fills it.
//!
//! Every controller works through [`PanelsHost`], the application's side of the panels. The asynchronous settlements of the
//! Node code (a store read, a streamed dashboard update, a side answer) are ordered events here, as in [`crate::surface`]:
//! the run loop feeds them in the order they settle and a claim drops the ones that no longer own the surface.

use serde_json::Value;

use crate::slash::host::Tone;
use crate::surface::epoch::PanelValue;
use crate::surface::latch::IndexModePanel;
use crate::surface::owner::PanelSurface;

pub mod btw;
pub mod context;
pub mod context_model;
pub mod context_refresh;
pub mod doctor;
pub mod usage;

/// The context panel the surface holds (`{ kind: 'context', title, detail, rows }`; its `onInspect` is
/// [`context::inspect_preview`] and its `onRefresh` is [`context::open_context_panel`]).
#[derive(Clone, Debug, PartialEq)]
pub struct ContextPanel {
    pub title: String,
    /// The context report the panel draws (`detail.type === 'context'`).
    pub detail: Value,
    /// The category rows of the plain list.
    pub rows: Vec<Value>,
}

/// `state.contextWindow` and `state.rawContextWindow`, the two session fields the context model falls back to (`null` for
/// a field the state does not have).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ContextWindows {
    pub context_window: Value,
    pub raw_context_window: Value,
}

/// The application's side of the panel controllers.
pub trait PanelsHost {
    /// The picker panel type of the surface.
    type Picker: PanelValue + IndexModePanel + Clone;

    /// The panel surface (picker, context panel, usage dashboard).
    fn surface(&mut self) -> &mut PanelSurface<Self::Picker, ContextPanel, Value>;
    /// Whether the store has the method `name` (`typeof store[name] === 'function'`).
    fn store_has(&self, name: &str) -> bool;
    /// `store.<name>(...args)`: `Ok(value)` is what the call resolved to (`null` for `undefined`), `Err(text)` a rejection;
    /// `None` when the store has no such method (the optional call `store.name?.()` of the Node code did nothing).
    fn read_store(&mut self, name: &str, args: Value) -> Option<Result<Value, String>>;
    /// `setProviderPrompt(null)` and `setSettingsPrompt(null)`.
    fn clear_text_prompts(&mut self);
    /// `closeUsagePanel()`.
    fn close_usage_panel(&mut self);
    /// `store.pushNotice(text, tone)`.
    fn notify(&mut self, text: &str, tone: Tone);
    /// The session fields of the state the context model reads.
    fn context_windows(&self) -> ContextWindows;
}
