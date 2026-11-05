//! A routine may name an executor: a workflow sub-agent (Worker, …) on its own configured
//! route (routine-executor.mjs). Each fire is then carried out by that sub-agent first,
//! headless and to its end, and only its final report goes to the owner bot's home thread,
//! which relays it. No executor = the bot does the work itself.
//!
//! The executor is a delegatable workflow agent: never a bot (contact agent) or Mixy, never
//! one that is unknown or turned off — refused when the routine is saved and again when it
//! fires (a sub-agent that disappeared or was turned off since fails the fire; nothing falls
//! back).

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::attachments::{binary_parts, prompt_text};
use super::host::ExecutorRun;
use super::ids::{MIXY_AGENT_ID, MIXY_BOT_ID};
use super::routine::{RoutineKind, routine_executor_header};
use super::runtime::RoutineRuntime;

/// Why an agent cannot execute a routine (`ROUTINE_EXECUTOR_PROBLEMS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutorProblem {
    Unknown,
    NotAgent,
    Disabled,
}

impl ExecutorProblem {
    pub fn message(self, id: &str) -> String {
        match self {
            Self::Unknown => format!("executor agent \"{id}\" is not an available sub-agent: pick one from the workflow agents"),
            Self::NotAgent => format!(
                "executor agent \"{id}\" is a bot, not a workflow sub-agent: pick a sub-agent such as Worker, or leave it unset"
            ),
            Self::Disabled => format!("executor agent \"{id}\" is turned off: turn it on in the workflow agents or pick another"),
        }
    }
}

/// The stored form of an executor id: lower-cased with dashes (`normalizeWorkflowId`);
/// None for none.
pub fn normalize_executor_agent_id(value: &str) -> Option<String> {
    let text = mixdog_js::js_trim(value);
    if text.is_empty() {
        return None;
    }
    let mut id = String::with_capacity(text.len());
    let mut in_gap = false;
    for c in text.to_lowercase().chars() {
        if mixdog_js::is_js_space(c) || c == '_' {
            if !in_gap {
                id.push('-');
            }
            in_gap = true;
        } else {
            id.push(c);
            in_gap = false;
        }
    }
    let mut chars = id.chars();
    let valid = matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.' | '-'));
    Some(if valid { id } else { text.to_lowercase() })
}

impl RoutineRuntime {
    /// Why `id` (normalized) cannot execute a routine; None when it can.
    pub async fn executor_problem(&self, id: &str) -> Result<Option<ExecutorProblem>, String> {
        if id == MIXY_AGENT_ID || id == MIXY_BOT_ID {
            return Ok(Some(ExecutorProblem::NotAgent));
        }
        let facts = self.host.executor_facts(id).await?;
        Ok(if !facts.listed {
            Some(ExecutorProblem::Unknown)
        } else if facts.contact {
            Some(ExecutorProblem::NotAgent)
        } else if facts.disabled {
            Some(ExecutorProblem::Disabled)
        } else {
            None
        })
    }

    /// The executor id to store for a save's `executorAgentId` (null/empty = none), or the
    /// error naming why it cannot be one.
    pub async fn assert_routine_executor(&self, value: &Value) -> Result<Option<String>, String> {
        let text = match value {
            Value::Null => return Ok(None),
            Value::String(text) => text,
            _ => return Err("executorAgentId must be a sub-agent id (a string) or null".into()),
        };
        let Some(id) = normalize_executor_agent_id(text) else { return Ok(None) };
        match self.executor_problem(&id).await? {
            Some(problem) => Err(problem.message(&id)),
            None => Ok(Some(id)),
        }
    }

    /// Carries out one fire of routine `name` with sub-agent `agent_id` and resolves its final
    /// report (trimmed). Rejects when the executor is no longer valid, fails, is cancelled, or
    /// `cancel` fires.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn run_executor_fire(
        &self,
        agent_id: &str,
        kind: RoutineKind,
        name: &str,
        owner_agent_id: &str,
        prompt: &str,
        skill_selection: &str,
        attachments: &Value,
        cwd: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<String, String> {
        if let Some(problem) = self.executor_problem(agent_id).await? {
            return Err(format!("{} \"{name}\" cannot run: {}", kind.word(), problem.message(agent_id)));
        }
        let header = routine_executor_header(kind, name, cwd.unwrap_or_default(), self.clock.now(), self.tz);
        let run = ExecutorRun {
            agent_id: agent_id.to_string(),
            kind,
            name: name.to_string(),
            owner_agent_id: owner_agent_id.to_string(),
            prompt: prompt_text(&format!("{header}\n\n{prompt}"), attachments),
            skill_selection: skill_selection.to_string(),
            cwd: cwd.filter(|c| !c.is_empty()).map(String::from),
            attachment_parts: binary_parts(attachments),
        };
        match self.host.run_executor(run, cancel.clone()).await {
            Ok(report) => Ok(mixdog_js::js_trim(&report).to_string()),
            // The caller's own cancellation stays as it is.
            Err(error) if cancel.is_cancelled() => Err(error),
            Err(error) => Err(format!("{} \"{name}\": executor agent \"{agent_id}\" failed: {error}", kind.word())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executor_ids_are_lowercased_with_dashes() {
        assert_eq!(normalize_executor_agent_id("  Code Reviewer_2 "), Some("code-reviewer-2".into()));
        assert_eq!(normalize_executor_agent_id("worker"), Some("worker".into()));
        assert_eq!(normalize_executor_agent_id("   "), None);
        // Not an id after folding: the lower-cased text is kept so the lookup names it.
        assert_eq!(normalize_executor_agent_id("-Bad!"), Some("-bad!".into()));
    }
}
