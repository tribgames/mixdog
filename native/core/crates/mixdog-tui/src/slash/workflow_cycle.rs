//! Tab at the prompt advances to the next workflow (`src/tui/app/workflow-cycle.mjs`, `use-workflow-tab-cycle.mjs`).
//!
//! Holding Tab can generate key-repeat faster than a workflow switch can settle. Without a prompt-local guard every repeat
//! starts (or rejects) a switch and pushes a toast, a rapid bottom-layout repaint storm that can tear the prompt box in
//! Windows Terminal. [`CycleGuard`] is that guard; this module owns the cycle itself.

use serde_json::{Value, json};

use super::host::{SlashHost, Tone};
use super::notices::{truthy, workflow_display_name, workflow_switch_notice};

const REPEAT_GUARD_MS: u64 = 300;

/// The prompt-local guard of the Tab cycle (`workflowTabCycleRef.current`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CycleGuard {
    pub pending: bool,
    pub last_at: u64,
}

/// What suppresses the Tab cycle: any surface that owns the keys (`useWorkflowTabCycle`'s arguments).
#[derive(Clone, Copy, Debug, Default)]
pub struct TabCycleOverlays {
    pub slash_palette_open: bool,
    pub tool_approval: bool,
    pub picker: bool,
    pub settings_prompt: bool,
    pub provider_prompt: bool,
    pub context_panel: bool,
    pub usage_panel: bool,
}

/// `cycleWorkflowFromPrompt({ store, state, cycleGuard })`: answers `true` either way, so the key stays consumed by the
/// prompt.
pub fn cycle_workflow_from_prompt(host: &mut dyn SlashHost, guard: &mut CycleGuard) -> bool {
    let now = host.now_ms();
    let state = host.state();
    if state.command_busy || guard.pending || now.saturating_sub(guard.last_at) < REPEAT_GUARD_MS {
        guard.last_at = now;
        return true;
    }
    guard.last_at = now;
    guard.pending = true;
    if let Err(error) = switch_to_next(host, &state.workflow) {
        host.push_notice(&format!("Couldn\u{2019}t switch workflow: {error}"), Tone::Error);
    }
    guard.pending = false;
    guard.last_at = host.now_ms();
    true
}

fn switch_to_next(host: &mut dyn SlashHost, current: &Value) -> Result<(), String> {
    let listed = host.store_call("listWorkflows", json!([]))?;
    let workflows: Vec<Value> = listed.as_array().cloned().unwrap_or_default();
    if workflows.is_empty() {
        host.push_notice("no workflows available", Tone::Warn);
        return Ok(());
    }
    if workflows.len() < 2 {
        host.push_notice(&format!("Workflow: {}", workflow_display_name(&workflows[0])), Tone::Info);
        return Ok(());
    }
    let current_index = workflows
        .iter()
        .position(|item| item.get("active").is_some_and(truthy))
        .unwrap_or_else(|| workflows.iter().position(|item| item.get("id") == current.get("id")).unwrap_or(0));
    let next = &workflows[(current_index + 1) % workflows.len()];
    let id = next.get("id").cloned().unwrap_or(Value::Null);
    let result = host.store_call("setWorkflow", json!([id]))?;
    if truthy(&result) {
        host.push_notice_ttl(&workflow_switch_notice(&result), Tone::Info, 1200);
    }
    Ok(())
}

/// `useWorkflowTabCycle(...)()`: the Tab handler of the prompt. A surface that owns the keys swallows the Tab; otherwise the
/// workflow cycles.
pub fn workflow_tab_cycle(host: &mut dyn SlashHost, guard: &mut CycleGuard, overlays: TabCycleOverlays) -> bool {
    if overlays.slash_palette_open
        || overlays.tool_approval
        || overlays.picker
        || overlays.settings_prompt
        || overlays.provider_prompt
        || overlays.context_panel
        || overlays.usage_panel
    {
        return true;
    }
    cycle_workflow_from_prompt(host, guard)
}
