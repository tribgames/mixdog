//! The staged reminders of a session header that a user turn carries, and the acknowledgement an accepted turn
//! makes (Node `workflow-switch-notice.mjs`, `orchestration-mode-switch-notice.mjs`, `prompt-utils.mjs`
//! `snapshotPendingWorkspaceNotice` / `snapshotPendingSetupNotice`, `deferred-tool-delta.mjs`
//! `acknowledgePendingDeferredToolDelta`; read by `buildUserTurn`, acknowledged by `commitAskTurn`).
//!
//! A snapshot reads the header and changes nothing. [`acknowledge`] is what the settle makes once the provider
//! accepted the turn, one acknowledgement per revision the run carried, in Node's order.

use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use serde_json::Value;
use serde_json::json;

use super::prompt_notice::Revisions;

const CORE_MEMORY_HEADING: &str = "# Core Memory\n";
const WORKSPACE_SLICES: [&str; 3] = ["environmentContext", "coreMemoryContext", "instructionFilesContext"];

/// A staged reminder a turn carries: the revision its acknowledgement names (`None`: the record holds none, so
/// nothing can acknowledge it) and its text.
#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    pub revision: Option<i64>,
    pub content: String,
}

/// The orchestration mode notice a turn carries. The overlay of a switch holds the text; a switch the prompt
/// caught up with has none, and the text is the mode's own (`orchestrationModeNoticeContent({ mode, carried: true })`).
#[derive(Clone, Debug, PartialEq)]
pub struct ModeNotice {
    pub revision: Option<i64>,
    pub mode: String,
    pub overlay: Option<String>,
}

/// JS truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(text) => !text.is_empty(),
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ => true,
    }
}

fn present(value: Option<&Value>) -> bool {
    value.is_some_and(truthy)
}

/// A revision a header holds: a whole number.
fn revision_of(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0).then_some(number as i64)
}

/// `value || ''` read as text.
fn text_of(value: Option<&Value>) -> String {
    match value {
        Some(value) if truthy(value) => mixdog_js::value_to_string(value),
        _ => String::new(),
    }
}

/// A template literal's `${value}`.
fn template(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(value) => mixdog_js::value_to_string(value),
    }
}

// ---- workflow -----------------------------------------------------------------------------------

/// The notice of a switch the prompt itself carries (`promptWorkflowNoticeContent`).
fn prompt_workflow_notice_content(from: Option<&Value>, to: &Value) -> String {
    let before = match from.and_then(|from| from.get("name")) {
        Some(name) if truthy(name) => mixdog_js::value_to_string(name),
        _ => "the previous workflow".to_owned(),
    };
    let name = template(to.get("name"));
    [
        "<system-reminder>".to_owned(),
        "# Workflow Changed".to_owned(),
        format!("This conversation now runs the {name} workflow, the one the system prompt carries: its Active Workflow, orchestration mode, available agents and tools apply. This replaces every earlier Workflow Changed reminder in this conversation."),
        format!("Agents already started under {before} keep running with their own instructions; new delegation follows {name}."),
        "</system-reminder>".to_owned(),
    ]
    .join("\n")
}

/// `snapshotPendingWorkflowNotice(session)`.
pub fn workflow_notice(header: &Header) -> Option<Notice> {
    let pending = header.get("workflowSwitch")?;
    let to = pending.get("to")?;
    let id = to.get("id");
    if !present(id) {
        return None;
    }
    let overlay = header.get("workflowOverlay").filter(|overlay| overlay.pointer("/workflow/id") == id);
    let content = match overlay.and_then(|overlay| overlay.get("content")).and_then(Value::as_str).filter(|content| !content.is_empty()) {
        Some(content) => content.to_owned(),
        None => prompt_workflow_notice_content(pending.get("from"), to),
    };
    Some(Notice { revision: revision_of(pending.get("revision")), content })
}

// ---- orchestration mode -------------------------------------------------------------------------

/// `snapshotPendingOrchestrationModeNotice(session)`.
pub fn orchestration_notice(header: &Header) -> Option<ModeNotice> {
    let pending = header.get("orchestrationModeSwitch")?;
    let to = pending.get("to").filter(|to| truthy(to))?;
    let overlay = header.get("orchestrationModeOverlay").filter(|overlay| overlay.get("mode") == Some(to));
    let content = overlay.and_then(|overlay| overlay.get("content")).and_then(Value::as_str).filter(|content| !content.is_empty());
    Some(ModeNotice { revision: revision_of(pending.get("revision")), mode: mixdog_js::value_to_string(to), overlay: content.map(str::to_owned) })
}

// ---- working folder -----------------------------------------------------------------------------

/// `sameWorkspacePath(left, right)`: `!!left && !!right && samePath(left, right)`.
fn same_workspace_path(left: &str, right: &str) -> bool {
    !left.is_empty() && !right.is_empty() && super::worktree::worktree_state::same_path(left, right)
}

/// The lines a move from the project folder into a worktree adds to the notice (`workspaceMoveLines`).
fn workspace_move_lines(movement: Option<&Value>, cwd: &str) -> Vec<String> {
    let from = text_of(movement.and_then(|movement| movement.get("from")));
    if from.is_empty() || same_workspace_path(&from, cwd) {
        return Vec::new();
    }
    let changes = match movement.and_then(|movement| movement.get("changes")).and_then(Value::as_str) {
        Some("carried") => "Uncommitted changes were moved into the worktree; ignored files (dependencies, build output, env files) were not.".to_owned(),
        Some("left") => format!("Uncommitted changes were left in {from}; they are not present here."),
        _ => String::new(),
    };
    let substitute = format!("For continued work, substitute {cwd} for the project root {from} in paths mentioned earlier; absolute paths are not remapped automatically. Re-read affected files before editing them.");
    [changes, substitute].into_iter().filter(|line| !line.is_empty()).collect()
}

/// `workspaceNoticeContent({ seen, target })`: empty when the folder did not change from what the model was told.
fn workspace_content(seen: Option<&Value>, target: Option<&Value>) -> String {
    let Some(target) = target else { return String::new() };
    let cwd = text_of(target.get("cwd"));
    let told_cwd = text_of(seen.and_then(|seen| seen.get("cwd")));
    if cwd.is_empty() || same_workspace_path(&told_cwd, &cwd) {
        return String::new();
    }
    // `target[slice] !== undefined && target[slice] !== (seen?.[slice] || '')`
    let changed = |slice: &str| -> bool {
        match target.get(slice) {
            None => false,
            Some(now) => {
                let told = match seen.and_then(|seen| seen.get(slice)) {
                    Some(told) if truthy(told) => told.clone(),
                    _ => Value::String(String::new()),
                };
                *now != told
            }
        }
    };
    let mut head = vec![
        "# Working Folder Changed".to_owned(),
        format!("The working folder is now {cwd}. This replaces the Cwd and environment facts given earlier in this conversation; relative paths and shell commands resolve here."),
        "Keep the conversation goals and decisions, but treat earlier file contents, search results and Git observations as historical, not as evidence of this checkout. Check the target project instructions and Git status, and re-read the files needed for the next edit before continuing. A folder change alone does not transfer uncommitted changes.".to_owned(),
    ];
    head.extend(workspace_move_lines(target.get("move"), &cwd));
    if changed("environmentContext") {
        head.push(text_of(target.get("environmentContext")));
    }
    let head: Vec<String> = head.into_iter().filter(|line| !line.is_empty()).collect();
    let mut sections = vec![head.join("\n")];
    if changed("instructionFilesContext") {
        let files = text_of(target.get("instructionFilesContext"));
        sections.push(if files.is_empty() {
            "The new working folder has no instruction files: the previously provided instruction files no longer apply.".to_owned()
        } else {
            format!("The instruction files below replace all previously provided instruction files.\n\n{files}")
        });
    }
    if changed("coreMemoryContext") {
        let memory = text_of(target.get("coreMemoryContext"));
        sections.push(if memory.is_empty() {
            "The new working folder has no core memory: the previously provided core memory no longer applies.".to_owned()
        } else {
            format!("The core memory below replaces all previously provided core memory.\n\n{CORE_MEMORY_HEADING}{memory}")
        });
    }
    format!("<system-reminder>\n{}\n</system-reminder>", sections.join("\n\n"))
}

/// `snapshotPendingWorkspaceNotice(session)`.
pub fn workspace_notice(header: &Header) -> Option<Notice> {
    let pending = header.get("workspaceReroot").filter(|pending| truthy(pending))?;
    let content = workspace_content(pending.get("seen"), pending.get("target"));
    if content.is_empty() {
        return None;
    }
    Some(Notice { revision: revision_of(pending.get("revision")), content })
}

// ---- worktree setup -----------------------------------------------------------------------------

/// `snapshotPendingSetupNotice(session)`.
pub fn setup_notice(header: &Header) -> Option<Notice> {
    let pending = header.get("pendingSetupNotice")?;
    let content = pending.get("content").and_then(Value::as_str).filter(|content| !content.is_empty())?;
    Some(Notice { revision: revision_of(pending.get("revision")), content: content.to_owned() })
}

// ---- acknowledgement ----------------------------------------------------------------------------

/// `acknowledgePendingDeferredToolDelta(session, revision)`.
fn acknowledge_deferred(header: &mut Header, revision: i64, now: i64) -> bool {
    let current = match header.get("pendingDeferredToolDelta").filter(|delta| delta.is_object()) {
        Some(delta) => {
            let number = mixdog_js::to_number_of(delta.get("revision"));
            if number.is_nan() { 0.0 } else { number.max(0.0) }
        }
        None => 0.0,
    };
    if current == 0.0 || current != revision as f64 {
        return false;
    }
    header.shift_remove("pendingDeferredToolDelta");
    header.insert("updatedAt".into(), json!(now));
    true
}

/// `acknowledgePendingWorkflowNotice` / `acknowledgePendingOrchestrationModeNotice`: the switch of `revision` goes.
fn acknowledge_switch(header: &mut Header, key: &str, revision: i64) -> bool {
    let acknowledged = header.get(key).filter(|pending| truthy(pending)).is_some_and(|pending| revision_of(pending.get("revision")) == Some(revision));
    if acknowledged {
        header.shift_remove(key);
    }
    acknowledged
}

/// `acknowledgePendingWorkspaceNotice(session, revision)`: what the notice told is now what the model has seen.
fn acknowledge_workspace(header: &mut Header, revision: i64) -> bool {
    let Some(pending) = header.get("workspaceReroot").filter(|pending| truthy(pending)).cloned() else { return false };
    if revision_of(pending.get("revision")) != Some(revision) {
        return false;
    }
    let target = pending.get("target");
    let mut seen = pending.get("seen").and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(cwd) = target.and_then(|target| target.get("cwd")) {
        seen.insert("cwd".into(), cwd.clone());
    }
    for slice in WORKSPACE_SLICES {
        if let Some(value) = target.and_then(|target| target.get(slice)) {
            seen.insert(slice.into(), value.clone());
        }
    }
    let mut next = pending.as_object().cloned().unwrap_or_default();
    next.insert("seen".into(), Value::Object(seen));
    header.insert("workspaceReroot".into(), Value::Object(next));
    true
}

/// `acknowledgePendingSetupNotice(session, revision)`.
fn acknowledge_setup(header: &mut Header, revision: i64) -> bool {
    let acknowledged = header.get("pendingSetupNotice").is_some_and(|pending| revision_of(pending.get("revision")) == Some(revision));
    if acknowledged {
        header.shift_remove("pendingSetupNotice");
    }
    acknowledged
}

/// What an accepted turn acknowledges (`commitAskTurn`, `ask-turn-settle.mjs:148-164`, in Node's order: deferred
/// delta, workflow, settings, orchestration mode, working folder, setup): the header change, `None` when nothing
/// the turn carried is still pending at the revision it carried.
pub fn acknowledge(header: &Header, revisions: &Revisions, now: i64) -> Option<HeaderChange> {
    let mut after = header.clone();
    let mut acknowledged = false;
    if let Some(revision) = revisions.deferred {
        acknowledged |= acknowledge_deferred(&mut after, revision, now);
    }
    if let Some(revision) = revisions.workflow {
        acknowledged |= acknowledge_switch(&mut after, "workflowSwitch", revision);
    }
    if let Some(revision) = revisions.settings {
        acknowledged |= mixdog_core_prompt::prompt::notice::acknowledge_pending(&mut after, revision);
    }
    if let Some(revision) = revisions.orchestration {
        acknowledged |= acknowledge_switch(&mut after, "orchestrationModeSwitch", revision);
    }
    if let Some(revision) = revisions.workspace {
        acknowledged |= acknowledge_workspace(&mut after, revision);
    }
    if let Some(revision) = revisions.setup {
        acknowledged |= acknowledge_setup(&mut after, revision);
    }
    if !acknowledged {
        return None;
    }
    let set: Header = after.iter().filter(|(key, value)| header.get(*key) != Some(*value)).map(|(key, value)| (key.clone(), value.clone())).collect();
    let unset: Vec<String> = header.keys().filter(|key| !after.contains_key(*key)).cloned().collect();
    Some(HeaderChange { set, unset })
}
