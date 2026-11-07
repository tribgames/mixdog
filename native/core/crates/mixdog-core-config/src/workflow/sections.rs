//! The pushed sections the workflow config derives (SPEC R14), each with the value of the
//! session action it replaces: `presets` (`listPresets`), `webSearch` (`getWebSearchRoute`) and
//! `workflows` (`listWorkflows`).
//!
//! The service computes them once at start and again after every change of the config or of a
//! workflow pack, and pushes a section only when its value differs from the last one pushed. A
//! value that cannot be computed (a stored web-search route that does not parse) is not pushed:
//! the section keeps the last good value.

use std::sync::Arc;

use mixdog_core_api::state::StatePublisher;
use mixdog_core_base::state::change_of;
use mixdog_protocol::SectionName;
use mixdog_rt::CancellationToken;
use mixdog_rt::TaskClass;
use serde_json::Value;

use super::WorkflowConfig;
use super::presets;

impl WorkflowConfig {
    /// `listPresets()`: the presets of the loaded config.
    pub fn list_presets(&self) -> Value {
        presets::effective(&self.config.agent()).config.get("presets").cloned().unwrap_or_else(|| Value::Array(Vec::new()))
    }

    async fn section_values(&self) -> [(SectionName, Option<Value>); 3] {
        [
            (SectionName::Presets, Some(self.list_presets())),
            (SectionName::WebSearch, self.web_search_route().ok()),
            (SectionName::Workflows, self.list_workflows().await.ok()),
        ]
    }
}

/// Starts the task that keeps `presets`, `webSearch` and `workflows` pushed.
pub fn spawn_sections(workflow: Arc<WorkflowConfig>, publisher: Arc<dyn StatePublisher>, cancel: CancellationToken) {
    mixdog_rt::spawn("workflow-sections", TaskClass::Work, async move {
        let mut changes = workflow.config.changes();
        let mut last: [Option<Value>; 3] = [None, None, None];
        loop {
            for (slot, (section, value)) in workflow.section_values().await.into_iter().enumerate() {
                let Some(value) = value else { continue };
                if last[slot].as_ref() != Some(&value) {
                    publisher.publish(section, None, change_of(&value));
                    last[slot] = Some(value);
                }
            }
            tokio::select! {
                () = cancel.cancelled() => return,
                changed = changes.changed() => if changed.is_err() { return },
                () = workflow.pack_changes.notified() => {}
            }
        }
    });
}
