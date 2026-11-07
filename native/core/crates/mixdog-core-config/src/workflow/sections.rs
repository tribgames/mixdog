//! The pushed sections the workflow config derives (SPEC R14), each with the value of the
//! session action it replaces: `presets` (`listPresets`), `webSearch` (`getWebSearchRoute`) and
//! `workflows` (`listWorkflows`), and the `onboarding` key of `config` (`getOnboardingStatus`,
//! `workflowRoutes` included).
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
use mixdog_workspace::error::WsError;
use serde_json::Value;

use super::WorkflowConfig;
use super::presets;
use crate::section_watch::FolderTrigger;
use crate::section_watch::Watched;

impl WorkflowConfig {
    /// `listPresets()`: the presets of the loaded config.
    pub fn list_presets(&self) -> Value {
        presets::effective(&self.config.agent()).config.get("presets").cloned().unwrap_or_else(|| Value::Array(Vec::new()))
    }

    /// `(section, key, value)`; the onboarding status is the `onboarding` key of `config`
    /// (desktop-services.md D10), the whole of `getOnboardingStatus()`.
    async fn section_values(&self) -> [(SectionName, Option<&'static str>, Option<Value>); 4] {
        [
            (SectionName::Presets, None, Some(self.list_presets())),
            (SectionName::WebSearch, None, self.web_search_route().ok()),
            (SectionName::Workflows, None, self.list_workflows().await.ok()),
            (SectionName::Config, Some("onboarding"), self.onboarding_status().ok()),
        ]
    }
}

/// One pass: each section whose value differs from the last one pushed is pushed. A value that cannot be computed is skipped.
pub(super) async fn push_changed(workflow: &WorkflowConfig, publisher: &dyn StatePublisher, last: &mut [Option<Value>; 4]) {
    for (slot, (section, key, value)) in workflow.section_values().await.into_iter().enumerate() {
        let Some(value) = value else { continue };
        if last[slot].as_ref() != Some(&value) {
            publisher.publish(section, key.map(str::to_owned), change_of(&value));
            last[slot] = Some(value);
        }
    }
}

/// Starts the task that keeps `presets`, `webSearch`, `workflows` and `config.onboarding`
/// pushed. A change of the config file (this process's or another's: `Config::changes` ticks
/// on an external reload too), of a workflow pack through this service, or of a pack folder by
/// another process wakes it.
pub fn spawn_sections(workflow: Arc<WorkflowConfig>, publisher: Arc<dyn StatePublisher>, cancel: CancellationToken) -> Result<(), WsError> {
    let packs = Watched {
        roots: vec![workflow.paths.root.join("workflows"), workflow.paths.data.join("workflows")],
        files: Vec::new(),
    };
    let trigger = FolderTrigger::start("workflow-packs", packs, workflow.pack_changes.clone())?;
    mixdog_rt::spawn("workflow-sections", TaskClass::Work, async move {
        // The pack-folder watch lives as long as the task.
        let _trigger = trigger;
        let mut changes = workflow.config.changes();
        let mut last: [Option<Value>; 4] = [None, None, None, None];
        loop {
            push_changed(&workflow, &*publisher, &mut last).await;
            tokio::select! {
                () = cancel.cancelled() => return,
                changed = changes.changed() => if changed.is_err() { return },
                () = workflow.pack_changes.notified() => {}
            }
        }
    });
    Ok(())
}
