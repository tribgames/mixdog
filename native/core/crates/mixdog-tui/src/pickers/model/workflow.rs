//! The Workflow list (`route-pickers/workflow-picker.mjs`): Enter switches the active workflow and hands the surface back to
//! the caller once the switch acks.

use std::rc::Rc;

use serde_json::{Value, json};

use crate::pickers::common::{Own, PanelItem, PickerFn, PickerHandler, PickerHost, PickerPanel, check_row, picker_help, reset_surfaces, run_deferred};
use crate::slash::host::Tone;
use crate::slash::notices::{truthy, workflow_switch_notice};
use crate::surface::SurfaceKind;

/// The options of `openWorkflowPicker(options)`.
#[derive(Clone, Default)]
pub struct WorkflowOptions {
    pub return_to: Option<PickerFn>,
    /// The panel painted when the surface is handed back (`None` clears the picker).
    pub handoff_panel: Option<PickerPanel>,
}

fn text(value: &Value, key: &str) -> String {
    super::options::text_of(value.get(key))
}

/// `openWorkflowPicker(options)`.
pub fn open_workflow_picker(host: &mut dyn PickerHost, options: WorkflowOptions) {
    let own = Rc::new(Own::new(host.claim_surface(SurfaceKind::Picker)));
    let workflows = match host.store_call("listWorkflows", json!([])) {
        Ok(Value::Array(workflows)) => workflows,
        Ok(_) => Vec::new(),
        Err(error) => {
            host.push_notice(&format!("could not list workflows: {error}"), Tone::Error);
            return;
        }
    };
    if workflows.is_empty() {
        host.push_notice("no workflows available", Tone::Warn);
        return;
    }
    let items: Vec<PanelItem> = workflows
        .iter()
        .map(|workflow| {
            let mut item = check_row(&text(workflow, "id"), &text(workflow, "name"), workflow.get("active").is_some_and(truthy));
            item.description = match text(workflow, "description") {
                description if !description.is_empty() => description,
                _ => {
                    let source = text(workflow, "source");
                    format!("{} workflow", if source.is_empty() { "workflow" } else { &source })
                }
            };
            PanelItem::new(item, json!({"_workflow": workflow}))
        })
        .collect();
    if !own.owns(host) {
        return;
    }
    reset_surfaces(host, &own);
    let mut panel = PickerPanel::new("Workflow");
    panel.description = "Select active workflow.".to_owned();
    panel.help = picker_help(false, options.return_to.is_some(), "\u{2191}/\u{2193} Select \u{b7} Enter Choose");
    panel.label_width = Some(18);
    panel.items = items;
    panel.handler = Some(Rc::new(WorkflowHandler { own: Rc::clone(&own), options }));
    own.paint(host, Some(panel));
}

struct WorkflowHandler {
    own: Rc<Own>,
    options: WorkflowOptions,
}

impl PickerHandler for WorkflowHandler {
    fn on_select(&self, host: &mut dyn PickerHost, item: &PanelItem) {
        let Some(workflow) = item.tag("_workflow") else { return };
        // Clear-and-continue: the flow keeps the surface it just emptied, so the post-ack hop below is bound to THIS keypress.
        // An Esc before the switch acks cancels the hop instead of re-opening Settings.
        self.own.paint(host, self.options.handoff_panel.clone());
        let deferred = self.own.claim();
        let return_after_switch = |host: &mut dyn PickerHost| {
            if let Some(return_to) = &self.options.return_to {
                run_deferred(host, deferred, |host| return_to(host));
            }
        };
        let handoff = self.options.handoff_panel.is_some();
        match host.store_call("setWorkflow", json!([workflow.get("id").cloned().unwrap_or(Value::Null)])) {
            Ok(result) if !truthy(&result) => {
                host.push_notice("Workflow switch is already running.", Tone::Warn);
                if handoff {
                    return_after_switch(host);
                }
            }
            Ok(result) => {
                host.push_notice(&workflow_switch_notice(&result), Tone::Info);
                return_after_switch(host);
            }
            Err(error) => {
                host.push_notice(&format!("Couldn\u{2019}t switch workflow: {error}"), Tone::Error);
                if handoff {
                    return_after_switch(host);
                }
            }
        }
    }

    fn on_cancel(&self, host: &mut dyn PickerHost) {
        if self.options.handoff_panel.is_some() {
            self.own.paint(host, self.options.handoff_panel.clone());
        } else {
            self.own.close(host);
        }
        if let Some(return_to) = &self.options.return_to {
            return_to(host);
        }
    }
}
