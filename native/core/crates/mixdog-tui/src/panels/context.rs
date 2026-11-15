//! The `/context` panel (`openContextPicker` of `app/usage-context-panels.mjs`): six status reads, the model derived from
//! them, and a claim-guarded paint.
//!
//! A daemon-backed store answers every status getter over the wire, so the reads settle before the first paint. The surface
//! claim is taken first and checked after them: an Esc that lands while the reads are pending must leave the surface (the
//! picker and the context panel) untouched. The reads are separate from the open so the run loop can serve them off the UI
//! thread: [`begin_context_open`], [`read_context_status`], [`finish_context_open`]. [`open_context_panel`] runs the three in
//! a row, and is what the panel's refresh (`onRefresh`) calls.

use mixdog_tui_widgets::panels::context_inspector::InspectOutcome;
use serde_json::{Value, json};

use super::context_model::{ContextModelInput, build_context_panel_model};
use super::{ContextPanel, PanelsHost};
use crate::surface::owner::PanelClaim;

/// The title of the panel.
pub const CONTEXT_PANEL_TITLE: &str = "Context Usage";

/// An open of the panel in flight: the claim taken when the user asked for it.
#[derive(Clone, Debug)]
pub struct ContextOpen {
    claim: PanelClaim,
}

/// What the six reads answered (`null` for a read that failed or that the store does not have).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ContextReads {
    pub tools_status: Value,
    pub mcp_status: Value,
    pub skills_status: Value,
    pub plugins_status: Value,
    pub context_status: Value,
    pub session_usage: Value,
}

/// `Promise.resolve(store.<name>?.(...)).catch(() => null)`.
fn read_or_null<H: PanelsHost>(host: &mut H, name: &str, args: Value) -> Value {
    match host.read_store(name, args) {
        Some(Ok(value)) => value,
        Some(Err(_)) | None => Value::Null,
    }
}

/// `surface.claim()`: the user asked for the panel.
pub fn begin_context_open<H: PanelsHost>(host: &mut H) -> ContextOpen {
    ContextOpen { claim: host.surface().claim() }
}

/// The reads the panel is built from: tools, MCP, skills, plugins, the context (with its inspection) and the session usage.
pub fn read_context_status<H: PanelsHost>(host: &mut H) -> ContextReads {
    ContextReads {
        tools_status: read_or_null(host, "toolsStatus", json!([])),
        mcp_status: read_or_null(host, "mcpStatus", json!([])),
        skills_status: read_or_null(host, "skillsStatus", json!([])),
        plugins_status: read_or_null(host, "pluginsStatus", json!([])),
        context_status: read_or_null(host, "contextStatus", json!([{ "inspect": true }])),
        session_usage: read_or_null(host, "getSessionUsage", json!([])),
    }
}

/// Paints the panel from the reads, closing the text-entry prompts and clearing the picker, unless the claim was lost while
/// they were pending. Whether it painted.
pub fn finish_context_open<H: PanelsHost>(host: &mut H, open: &mut ContextOpen, reads: &ContextReads) -> bool {
    if !open.claim.owns(host.surface()) {
        return false;
    }
    let windows = host.context_windows();
    let model = build_context_panel_model(&ContextModelInput {
        tools_status: &reads.tools_status,
        mcp_status: &reads.mcp_status,
        skills_status: &reads.skills_status,
        plugins_status: &reads.plugins_status,
        context_status: &reads.context_status,
        session_usage: &reads.session_usage,
        state_context_window: &windows.context_window,
        state_raw_context_window: &windows.raw_context_window,
    });
    host.clear_text_prompts();
    let panel = ContextPanel { title: CONTEXT_PANEL_TITLE.to_owned(), detail: model.detail, rows: model.rows };
    let surface = host.surface();
    open.claim.paint(surface, None);
    open.claim.context(surface, Some(panel));
    true
}

/// `openContextPicker()`: claim, read, paint. Whether the panel was painted.
pub fn open_context_panel<H: PanelsHost>(host: &mut H) -> bool {
    let mut open = begin_context_open(host);
    let reads = read_context_status(host);
    finish_context_open(host, &mut open, &reads)
}

/// The panel's `onInspect(entryId, revision)`: the preview of an entry of the inspection
/// (`(await store.contextStatus({ inspect: true, entryId, revision }))?.inspection?.preview`).
pub fn inspect_preview<H: PanelsHost>(host: &mut H, entry_id: &Value, revision: &Value) -> InspectOutcome {
    let args = json!([{ "inspect": true, "entryId": entry_id, "revision": revision }]);
    match host.read_store("contextStatus", args) {
        Some(Ok(status)) => {
            let preview = status.get("inspection").and_then(|inspection| inspection.get("preview"));
            InspectOutcome::Answer(preview.filter(|preview| !preview.is_null()).cloned())
        }
        Some(Err(_)) | None => InspectOutcome::Failed,
    }
}
