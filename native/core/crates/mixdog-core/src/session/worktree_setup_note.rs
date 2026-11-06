//! The agent's note on a new worktree's preparation, given with its first turn and never shown
//! as a card (Node `preparation-report.mjs`): the main checkout it was made from, what
//! creation copied (env files, `.worktreeinclude`) and linked, what the first turn installed,
//! what failed (with the output tail) and what was skipped.

use serde_json::Value;

use super::worktree_setup_run::SetupReport;
use super::worktree_setup_run::SetupStatus;
use super::worktree_setup_run::output_tail;

/// What a preparation did, for [`worktree_preparation_note`].
#[derive(Default)]
pub struct PreparationReport<'a> {
    pub root: &'a str,
    /// What creation recorded: `{ root, copied, linked, skipped }`.
    pub prepared: Option<&'a Value>,
    pub dependency_notes: &'a [String],
    pub installs: Option<&'a SetupReport>,
    pub notes: &'a [String],
}

fn skip_line(warning: &str) -> Option<String> {
    let (code, subject) = warning.split_once(':').unwrap_or((warning, ""));
    match code {
        "include-invalid" if subject == "patterns" => Some(".worktreeinclude patterns (git could not use them)".into()),
        "include-invalid" => Some(format!(".worktreeinclude line {subject} (invalid)")),
        "include-truncated" => Some(format!(".worktreeinclude patterns ({subject} matches; nothing copied)")),
        "include-missing" => Some(format!("{subject} (not in the main checkout)")),
        "include-exists" => Some(format!("{subject} (already in the checkout)")),
        "include-skipped" => Some(format!("{subject} (not allowed)")),
        _ => None,
    }
}

fn ended(status: SetupStatus) -> &'static str {
    match status {
        SetupStatus::TimedOut => "timed out",
        SetupStatus::Cancelled => "was cancelled",
        SetupStatus::Failed => "failed",
        SetupStatus::Completed => "completed",
    }
}

fn failure_lines(run: Option<&SetupReport>) -> Vec<String> {
    let Some(run) = run.filter(|run| run.status != SetupStatus::Completed) else { return Vec::new() };
    let Some(last) = run.steps.last() else { return vec![format!("Stopped: {}.", ended(run.status))] };
    let exit = last.exit_code.map_or(String::new(), |code| format!(", exit {code}"));
    let place = last.label.as_deref().filter(|label| !label.is_empty()).map_or(String::new(), |label| format!(" [{label}]"));
    let tail = output_tail(&last.output);
    let mut lines = vec![format!("Failed: {}{place} ({}{exit})", last.command, ended(last.status))];
    if !tail.is_empty() {
        lines.push(tail);
    }
    lines
}

/// One line per install the stop left unrun: its folder and the command to run there.
fn pending_lines(run: Option<&SetupReport>) -> Vec<String> {
    run.map(|run| {
        run.pending
            .iter()
            .map(|step| {
                let name = if step.label.is_empty() { &step.command } else { &step.label };
                format!("Skipped (not run after the stop): {name} — run `{}` in {}", step.command, step.cwd.display())
            })
            .collect()
    })
    .unwrap_or_default()
}

fn strings(prepared: Option<&Value>, key: &str) -> Vec<String> {
    prepared
        .and_then(|p| p.get(key))
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

fn list(lines: &mut Vec<String>, label: &str, items: Vec<String>) {
    if !items.is_empty() {
        lines.push(format!("{label}: {}", items.join(", ")));
    }
}

/// One system-reminder block.
pub fn worktree_preparation_note(report: &PreparationReport<'_>) -> String {
    let root = if !report.root.is_empty() {
        report.root.to_owned()
    } else {
        report
            .prepared
            .and_then(|p| p.get("root"))
            .and_then(Value::as_str)
            .filter(|root| !root.is_empty())
            .unwrap_or("an unknown path")
            .to_owned()
    };
    let mut lines = vec![format!(
        "This worktree was made from the main checkout at {root}; ignored files there (build output, caches) are not here unless listed below."
    )];
    list(&mut lines, "Copied from the main checkout", strings(report.prepared, "copied"));
    list(&mut lines, "Linked from the main checkout", strings(report.prepared, "linked"));
    lines.extend(report.dependency_notes.iter().cloned());
    let installed = report
        .installs
        .map(|run| {
            run.steps
                .iter()
                .filter(|step| step.status == SetupStatus::Completed)
                .map(|step| step.label.clone().filter(|label| !label.is_empty()).unwrap_or_else(|| step.command.clone()))
                .collect()
        })
        .unwrap_or_default();
    list(&mut lines, "Installed", installed);
    lines.extend(failure_lines(report.installs));
    lines.extend(pending_lines(report.installs));
    let skipped = strings(report.prepared, "skipped").iter().filter_map(|warning| skip_line(warning)).collect();
    list(&mut lines, "Skipped", skipped);
    lines.extend(report.notes.iter().cloned());
    format!("<system-reminder>\n# Worktree Preparation\n{}\n</system-reminder>", lines.join("\n"))
}
