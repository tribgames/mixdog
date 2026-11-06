//! Report watchers of agent task sessions (`session-runtime/agent-task-sessions.mjs`): a bot's
//! cross-session send is watched until its turn - and the chain of turns its agents' results wake -
//! ends, and the answer is reported to the bot's home. `chain` reads a session's stored messages,
//! `follow` waits for the final answer, and `rearm` re-attaches the watches a stopped daemon left.

pub mod chain;
pub mod follow;
pub mod rearm;

/// The queue row of the progress update of task session `session_id` carrying the answer of turn
/// `answer_id`: one per answer, across restarts and however many open sends reach it.
pub fn progress_run_id(session_id: &str, answer_id: &str) -> String {
    format!("{session_id}_progress_{answer_id}")
}

/// The queue row of send `id`'s report of `status` to task session `session_id`. `working` is a
/// progress update; an end carrying the answer of turn `answer_id` belongs to that answer, so every
/// open send whose chain ends in it names the same row and it posts once; a wait for approval
/// belongs to the target session.
pub fn turn_report_run_id(session_id: &str, id: &str, status: &str, approval_id: &str, answer_id: &str) -> String {
    match status {
        "blocked" => format!("{session_id}_{approval_id}_blocked"),
        "working" => progress_run_id(session_id, answer_id),
        _ if !answer_id.is_empty() => format!("{session_id}_{answer_id}_end"),
        _ => format!("{id}_end"),
    }
}

#[cfg(test)]
mod tests;
