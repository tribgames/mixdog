//! The reminder block of a user turn (Node `buildUserTurn`, `session/manager/ask-turn-prepare.mjs:147-246`).
//!
//! One builder: every reminder a turn can carry is read here, in Node's order (workflow switch, prompt settings,
//! orchestration mode, agent list, working folder, worktree setup, current time, deferred-tool delta, Goal,
//! todo start), joined into the one block that trails the human's words, and carried by the user message together
//! with the meta the reminders leave on it. [`Reminders::revisions`] is what the actor acknowledges once the turn
//! was accepted (`session::reminders::acknowledge`, `ask-turn-settle.mjs:148-164`).

mod clock;
mod deferred;
mod listing;
mod retained;
mod zone_names;
#[cfg(test)]
mod tests;

use mixdog_core_prompt::prompt::notice;
use mixdog_core_session::session::prompt_notice::Revisions;
use mixdog_core_session::session::reminders;
use mixdog_core_session::session::thread_switches::mode_notice_text;
use mixdog_store::schema::record::Header;
use serde_json::Value;

pub use self::listing::AgentEntry;
pub use self::clock::prompt_content_text;
pub use self::listing::agent_list_entries;
pub use self::retained::is_retained;
pub use self::retained::resubmit;

/// The name of the todo tool (`TODO_TOOL.name`).
const TODO_TOOL: &str = "todo";

/// What the turn's reminders are read from.
pub struct Facts<'a> {
    /// The session record at the turn's start, after its settings were reconciled.
    pub header: &'a Header,
    /// The conversation's stored rows before this turn (the system prefix is the header's).
    pub prior: &'a [Value],
    /// `promptContentText(input.prompt)`: the human's words as text, before any reminder.
    pub prompt_text: &'a str,
    /// `!turnPromptSource?.source`: a real prompt, not a Goal turn or a task notification.
    pub genuine: bool,
    /// `currentAgents`: the agents enabled at the turn's start; `None` for a session that gets no agent list reminder.
    pub current_agents: Option<&'a [AgentEntry]>,
    /// `orchestrationInstructions(mode)` of [`carried_mode`], when a pending mode notice needs it.
    pub mode_instructions: Option<&'a str>,
    /// The Goal reminder's text (`snapshotPendingGoalReminder`), read by the actor at the turn's start.
    pub goal: Option<&'a str>,
    /// The session's role is a hidden agent.
    pub hidden_agent: bool,
    /// `Date.now()` at the turn's preparation.
    pub now_ms: f64,
}

/// The block a turn carries and what it leaves on the user message.
#[derive(Clone, Debug, PartialEq)]
pub struct Reminders {
    /// The reminders joined by a blank line; empty when the turn carries none.
    pub block: String,
    /// `meta.agentListing`.
    pub agent_listing: Option<Value>,
    /// What the actor acknowledges once the turn is accepted.
    pub revisions: Revisions,
}

/// The mode whose notice text the host must supply: a pending orchestration mode switch with no overlay holding the
/// text (`orchestrationModeNoticeContent({ mode, carried: true })` needs `orchestrationInstructions(mode)`).
pub fn carried_mode(header: &Header) -> Option<String> {
    reminders::orchestration_notice(header).filter(|pending| pending.overlay.is_none()).map(|pending| pending.mode)
}

/// `todoStartReminder(session)` of a genuine prompt: a delegated agent's brief with no open list asks for one.
fn todo_start(header: &Header, hidden_agent: bool) -> Option<String> {
    let delegated = header.get("owner").and_then(Value::as_str) == Some("agent");
    let has_todo_tool = header.get("tools").and_then(Value::as_array).is_some_and(|tools| tools.iter().any(|tool| tool.get("name").and_then(Value::as_str) == Some(TODO_TOOL)));
    let open = mixdog_core_ports::ports::todo_list::list_of(header).open_items().len();
    mixdog_core_run::run_host::guards::todo_start_reminder(delegated, hidden_agent, has_todo_tool, open)
}

/// The turn's reminder block, in Node's order.
pub fn build(facts: &Facts<'_>) -> Result<Reminders, String> {
    let header = facts.header;
    let mut parts: Vec<String> = Vec::new();
    let mut revisions = Revisions::default();
    let mut push = |content: String| {
        if !content.is_empty() {
            parts.push(content);
        }
    };

    if let Some(workflow) = reminders::workflow_notice(header) {
        revisions.workflow = workflow.revision;
        push(workflow.content);
    }
    if let Some((revision, content)) = notice::snapshot_pending(header) {
        revisions.settings = Some(revision);
        push(content);
    }
    if let Some(mode) = reminders::orchestration_notice(header) {
        revisions.orchestration = mode.revision;
        match mode.overlay {
            Some(content) => push(content),
            None => {
                let instructions = facts.mode_instructions.ok_or_else(|| format!("the {} orchestration mode notice has no instructions to carry", mode.mode))?;
                push(mode_notice_text(&mode.mode, true, &[], instructions));
            }
        }
    }
    let listed = listing::notice(header, facts.prior, facts.current_agents);
    if let Some(listed) = &listed {
        push(listed.content.clone());
    }
    if let Some(workspace) = reminders::workspace_notice(header) {
        revisions.workspace = workspace.revision;
        push(workspace.content);
    }
    if let Some(setup) = reminders::setup_notice(header) {
        revisions.setup = setup.revision;
        push(setup.content);
    }
    let time = clock::block(facts.prompt_text, facts.now_ms);
    if !time.is_empty() {
        push(format!("<system-reminder>\n# Current Time\n{time}\n</system-reminder>"));
    }
    if let Some(delta) = deferred::notice(header) {
        revisions.deferred = Some(delta.revision);
        push(delta.content);
    }
    if let Some(goal) = facts.goal {
        push(goal.to_owned());
    }
    if facts.genuine
        && let Some(start) = todo_start(header, facts.hidden_agent)
    {
        push(start);
    }
    Ok(Reminders { block: parts.join("\n\n"), agent_listing: listed.map(|listed| listed.meta), revisions })
}

impl Reminders {
    /// `withRuntimeUserContext(message, { suffix: suffixUserTurnReminders('', block) })` over the reminders' meta;
    /// `None` for content that is neither text nor blocks.
    pub fn carry(&self, message: &Value) -> Option<Value> {
        notice::carry_reminders(message, &self.block, self.agent_listing.as_ref(), self.revisions.settings)
    }
}
