//! The session manager as an agent dispatch uses it (Node `makeAgentDispatch`'s collaborators
//! over `session/manager.mjs`), over the session directory: the ephemeral hidden-role session is a
//! thread created with its stamped header (`createSession`), its status is a header write
//! (`updateSessionStatus`), its turn is the worker turn of [`SessionTurns`] with the dispatch's
//! own watchdog (`askSession` under `linkParentSignalToSession`), its progress is the run's
//! (`getSessionProgressSnapshot`), a stall reaps the shells the turn started (`armTurnTimeout`),
//! and it is closed with a tombstone (`closeSession`). The header the session is stamped with is
//! the caller's (`prepareAgentSession`'s record fields).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_agent::agent_tool::flow::seams::AssistantText;
use mixdog_agent::agent_tool::flow::seams::TurnHooks;
use mixdog_agent::agent_tool::flow::seams::TurnKind;
use mixdog_agent::agent_tool::flow::seams::TurnRequest;
use mixdog_agent::agent_tool::flow::seams::TurnSessions;
use mixdog_agent::agent_tool::progress::Snapshot;
use mixdog_agent::cancel::Cancel;
use mixdog_agent::cancel::session_closed;
use mixdog_agent::env::Yielder;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::agent_registry::SessionTurns;
use super::close::SessionClose;
use super::thread_state::SessionThreads;

pub struct DispatchThreads {
    directory: Arc<SessionDirectory>,
    threads: SessionThreads,
    turns: Arc<SessionTurns>,
    close: Arc<SessionClose>,
    shells: Option<Arc<mixdog_tools::exec::ShellControl>>,
    /// `askStartedAt` of each session's running ask: what a stall's reap counts from.
    asked: Mutex<HashMap<String, i64>>,
}

impl DispatchThreads {
    /// `turns`: the worker turns the agent tool runs (`SessionTurns`); `close`: the tombstoning
    /// close; `shells`: the shell runtime a stall reaps through (`None`: nothing to reap).
    pub fn new(
        directory: Arc<SessionDirectory>,
        turns: Arc<SessionTurns>,
        close: Arc<SessionClose>,
        shells: Option<Arc<mixdog_tools::exec::ShellControl>>,
    ) -> Self {
        Self { threads: SessionThreads::new(directory.clone()), directory, turns, close, shells, asked: Mutex::default() }
    }

    fn asked(&self) -> std::sync::MutexGuard<'_, HashMap<String, i64>> {
        self.asked.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `createSession`: a new thread whose first durable write is `header` with `createdAt`,
    /// `updatedAt` and `lastUsedAt` now; its id.
    pub async fn create(&self, mut header: Header) -> Result<String, String> {
        let now = json!(self.directory.deps().clock.now_ms());
        for key in ["createdAt", "updatedAt", "lastUsedAt"] {
            header.insert(key.into(), now.clone());
        }
        self.directory.create_session(header, json!({})).await.map(|id| id.as_str().to_owned()).map_err(|error| format!("{error:?}"))
    }

    /// `session.tools`: the names of the session's active tools.
    pub fn tools(&self, id: &str) -> Vec<String> {
        self.directory.handle(&ThreadId::from(id)).map(|handle| handle.cell.surface.borrow().active_tools.clone()).unwrap_or_default()
    }

    /// `updateSessionStatus(id, status)`: `status` and `updatedAt`; a closed (tombstoned) or
    /// unknown session keeps its own.
    pub async fn set_status(&self, id: &str, status: &str) {
        let thread = ThreadId::from(id);
        let Some(header) = self.directory.stored_header(&thread).await else { return };
        if header.get("closed") == Some(&Value::Bool(true)) {
            return;
        }
        let now = self.directory.deps().clock.now_ms();
        let set = [("status".to_owned(), json!(status)), ("updatedAt".to_owned(), json!(now))].into_iter().collect();
        if let Err(error) = self.threads.patch_header(&thread, set, Vec::new()).await {
            tracing::warn!("[agent-dispatch] status {status} of {id} was not written: {error:?}");
        }
    }

    /// `session.messages.length`.
    pub async fn message_count(&self, id: &str) -> usize {
        self.turns.message_count(id).await
    }

    /// The assistant rows from message index `start` on.
    pub async fn assistant_texts(&self, id: &str, start: usize) -> Vec<AssistantText> {
        self.turns.assistant_texts(id, start).await
    }

    /// `askSession(id, prompt, null, onToolCall, cwd, undefined, askOpts)` with the dispatch's
    /// composite signal linked to the session (`linkParentSignalToSession`): the reply text, or
    /// what the ask threw. A signal already aborted throws its reason before anything runs. An
    /// abort while the ask runs ends the running turn with the signal's reason and the ask at
    /// once with `SessionClosedError`'s text (`_api_call_with_interrupt`, which spans the turn's
    /// whole model loop): `aborted during call` once the loop runs, `aborted before call` before
    /// it (recorded in `fixtures/dispatch-sessions`).
    pub async fn ask(&self, id: &str, prompt: &str, cwd: Option<String>, slot: Arc<dyn Yielder>, cancel: &Cancel) -> Result<String, String> {
        let closed = |phase: &str| {
            let reason = cancel.reason();
            session_closed(id, &if reason.is_empty() { phase.to_owned() } else { format!("{phase}: {reason}") })
        };
        if cancel.is_aborted() {
            return Err(cancel.reason());
        }
        self.asked().insert(id.to_owned(), self.directory.deps().clock.now_ms());
        let request = TurnRequest {
            kind: TurnKind::Spawn,
            session_id: id.to_owned(),
            prompt: prompt.to_owned(),
            attachments: Vec::new(),
            context: None,
            cwd: cwd.unwrap_or_default(),
            skill_selection: None,
            hooks: TurnHooks {
                submission_id: String::new(),
                notify: Arc::new(|_, _| false),
                on_tool_result: Arc::new(|_| {}),
                on_terminal_result: None,
            },
            slot: Some(slot),
        };
        let turn = self.turns.run_watched_turn(request);
        tokio::pin!(turn);
        let answer = tokio::select! {
            answer = &mut turn => answer.map(|result| result.content).map_err(|error| error.message),
            () = cancel.cancelled() => {
                let handle = self.directory.handle(&ThreadId::from(id));
                // Read before the turn is aborted: whether its model loop was running then.
                let in_call = handle.as_ref().is_some_and(|handle| handle.cell.progress.borrow().in_call());
                if let Some(handle) = &handle
                    && let Some(run) = handle.cell.run.load_full()
                {
                    let _ = handle.cell.abort(&run.turn, &cancel.reason());
                }
                Err(closed(if in_call { "aborted during call" } else { "aborted before call" }))
            }
        };
        self.asked().remove(id);
        answer
    }

    /// `getSessionProgressSnapshot(id)` at `now`: the running turn's progress.
    pub fn progress(&self, id: &str, now: i64) -> Option<Snapshot> {
        self.directory.handle(&ThreadId::from(id))?.cell.progress.borrow().snapshot(now)
    }

    /// `armTurnTimeout(id)`: a stall is the first thing to stop the session's turn, so the
    /// background shell work the turn started since its ask began is stopped (`reap`). Nothing
    /// when no turn runs, its signal already fired, or the session is closing.
    pub fn arm_turn_timeout(&self, id: &str) {
        let (Some(shells), Some(since)) = (&self.shells, self.asked().get(id).copied()) else { return };
        let thread = ThreadId::from(id);
        let Some(handle) = self.directory.handle(&thread) else { return };
        if handle.cell.closed.load(std::sync::atomic::Ordering::SeqCst) || handle.cell.run.load_full().is_none_or(|run| run.cancel.is_aborted()) {
            return;
        }
        shells.reap_since(&thread, since.max(0) as u64);
    }

    /// `closeSession(id, reason)`: the tombstoning close.
    pub async fn close(&self, id: &str, reason: &str) {
        self.close.close(id, reason).await;
    }
}

#[cfg(test)]
#[path = "dispatch_sessions_tests.rs"]
mod tests;
