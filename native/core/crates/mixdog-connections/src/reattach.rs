//! What happened on the server while a window was away from it, reported once the window is attached again: turns that
//! finished or kept running, model calls that broke off, and tool calls whose result never arrived. Nothing here is retried;
//! the user only learns what the server did without them. The report is written to the link's notices.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use mixdog_app_protocol::v2::connections::ConnectionNotice;
use serde_json::Value;
use tokio::sync::{broadcast, mpsc, watch};
use tokio::task::JoinHandle;
use mixdog_rt::time::Instant;

use crate::link::ServerLink;
use crate::link_machine::{LinkState, LinkViewState};
use crate::model_proxy_relay::{CallOutcome, ProxyCallSettled};
use crate::server_feed::{SessionRunState, SessionStateChange, SessionSummaryLite};

/// How long after re-attaching the fresh session list may take before the report is made from the list already known.
pub const REATTACH_SESSIONS_WAIT_MS: u64 = 5_000;
/// How long a session with unanswered tool calls is watched for its turn to end.
const OUTCOME_WATCH: Duration = Duration::from_secs(10 * 60);

/// The four streams the report reads, from one attached link.
pub struct ReattachSources {
    pub sessions: watch::Receiver<Vec<SessionSummaryLite>>,
    pub states: broadcast::Receiver<SessionStateChange>,
    pub view: watch::Receiver<LinkViewState>,
    pub model_calls: broadcast::Receiver<ProxyCallSettled>,
}

/// The running report of one link; dropping it stops it.
pub struct ReattachReport {
    task: JoinHandle<()>,
}

impl ReattachReport {
    /// Starts watching `link`. Must be called inside a tokio runtime.
    pub fn attach(link: &ServerLink) -> ReattachReport {
        let sources = ReattachSources {
            sessions: link.feed().sessions(),
            states: link.feed().session_states(),
            view: link.view(),
            model_calls: link.model_calls(),
        };
        Self::start(link.notices().clone(), sources)
    }

    pub(crate) fn start(notices: broadcast::Sender<ConnectionNotice>, sources: ReattachSources) -> ReattachReport {
        ReattachReport { task: tokio::spawn(run(notices, sources)) }
    }
}

impl Drop for ReattachReport {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A tool call that has neither a result nor a completion mark.
fn tool_call_unanswered(item: &Value) -> bool {
    let Some(row) = item.as_object() else { return false };
    if row.get("kind").and_then(Value::as_str) != Some("tool") || row.get("completedAt").is_some_and(|v| !v.is_null()) {
        return false;
    }
    let present = |key: &str| row.get(key).is_some_and(|v| !v.is_null());
    match row.get("completedCount") {
        None => !present("result") && !present("rawResult"),
        Some(done) => {
            let number = |value: &Value| value.as_f64().or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()));
            let done = number(done).unwrap_or(0.0);
            let count = row.get("count").and_then(number).filter(|n| *n != 0.0 && !n.is_nan()).unwrap_or(1.0);
            done < count
        }
    }
}

fn unanswered_tool_ids(snapshot: &Value) -> Vec<String> {
    let Some(items) = snapshot.get("items").and_then(Value::as_array) else { return Vec::new() };
    items
        .iter()
        .filter(|item| tool_call_unanswered(item))
        .map(|item| match item.get("id") {
            Some(Value::String(id)) => id.clone(),
            Some(Value::Number(id)) => id.to_string(),
            _ => String::new(),
        })
        .collect()
}

fn session_busy(snapshot: &Value) -> bool {
    ["busy", "commandBusy"].iter().any(|key| snapshot.get(*key).and_then(Value::as_bool) == Some(true))
}

#[derive(Default)]
struct Away {
    /// Sessions whose turn was running when the link dropped: id to title.
    working: Vec<(String, String)>,
    /// Session id to the tool call ids without a result when the link dropped.
    tools: Vec<(String, HashSet<String>)>,
    interrupted_model_calls: u32,
}

struct Watch {
    ids: HashSet<String>,
    until: Instant,
}

struct Report {
    notices: broadcast::Sender<ConnectionNotice>,
    wake: mpsc::UnboundedSender<u64>,
    sessions: Vec<SessionSummaryLite>,
    states: HashMap<String, Value>,
    watches: HashMap<String, Watch>,
    away: Option<Away>,
    returned: Option<Away>,
    /// The generation of the pending settle timer.
    settle: Option<u64>,
    generation: u64,
}

impl Report {
    fn emit(&self, notice: ConnectionNotice) {
        // Nobody listening is no failure: the window may be gone.
        let _ = self.notices.send(notice);
    }

    fn capture(&self) -> Away {
        let working = self
            .sessions
            .iter()
            .filter(|session| session.running)
            .map(|session| {
                let title = [&session.title, &session.preview].into_iter().find(|text| !text.is_empty());
                (session.id.clone(), title.cloned().unwrap_or_else(|| session.id.clone()))
            })
            .collect();
        // Only a running turn has calls in flight; an idle one's are settled history.
        let tools = self
            .states
            .iter()
            .filter(|(_, snapshot)| session_busy(snapshot))
            .filter_map(|(id, snapshot)| {
                let ids: HashSet<String> = unanswered_tool_ids(snapshot).into_iter().filter(|id| !id.is_empty()).collect();
                (!ids.is_empty()).then(|| (id.clone(), ids))
            })
            .collect();
        Away { working, tools, interrupted_model_calls: 0 }
    }

    fn finish(&mut self) {
        self.settle = None;
        let Some(report) = self.returned.take() else { return };
        let mut finished = Vec::new();
        let mut continued = Vec::new();
        for (id, title) in &report.working {
            let Some(current) = self.sessions.iter().find(|session| &session.id == id) else { continue };
            let name = if current.title.is_empty() { title.clone() } else { current.title.clone() };
            if current.running {
                continued.push(name);
            } else {
                finished.push(name);
            }
        }
        if !finished.is_empty() || !continued.is_empty() || report.interrupted_model_calls > 0 {
            self.emit(ConnectionNotice::Reattached { finished, continued, interrupted_model_calls: report.interrupted_model_calls });
        }
        let until = Instant::now() + OUTCOME_WATCH;
        for (session_id, ids) in report.tools {
            self.watches.insert(session_id.clone(), Watch { ids, until });
            if let Some(snapshot) = self.states.get(&session_id).cloned() {
                self.check_watch(&session_id, &snapshot);
            }
        }
    }

    /// Once the session's turn is over, its calls still without a result never got one; while the turn runs they may yet.
    fn check_watch(&mut self, session_id: &str, snapshot: &Value) {
        let Some(watch) = self.watches.get(session_id) else { return };
        if Instant::now() > watch.until {
            self.watches.remove(session_id);
            return;
        }
        if session_busy(snapshot) {
            return;
        }
        let Some(watch) = self.watches.remove(session_id) else { return };
        let still: HashSet<String> = unanswered_tool_ids(snapshot).into_iter().collect();
        let mut tool_ids: Vec<String> = watch.ids.into_iter().filter(|id| still.contains(id)).collect();
        tool_ids.sort();
        if !tool_ids.is_empty() {
            self.emit(ConnectionNotice::OutcomeUnknown { session_id: session_id.to_owned(), tool_ids });
        }
    }

    fn on_view(&mut self, view: &LinkViewState) {
        if !matches!(view.state, LinkState::Connected) {
            if let Some(returned) = self.returned.take() {
                // Dropped again before the report was made: one outage.
                self.settle = None;
                self.away = Some(returned);
            } else if self.away.is_none() {
                self.away = Some(self.capture());
            }
            return;
        }
        let Some(away) = self.away.take() else { return };
        self.returned = Some(away);
        // The session list the server sends after re-attaching is the truth; the one known now may predate the outage.
        self.generation += 1;
        let generation = self.generation;
        self.settle = Some(generation);
        let wake = self.wake.clone();
        drop(tokio::spawn(async move {
            mixdog_rt::time::sleep(Duration::from_millis(REATTACH_SESSIONS_WAIT_MS)).await;
            let _ = wake.send(generation);
        }));
    }

    fn on_sessions(&mut self, next: Vec<SessionSummaryLite>) {
        self.sessions = next;
        if self.returned.is_some() {
            self.finish();
        }
    }

    fn on_state(&mut self, change: SessionStateChange) {
        if change.state == SessionRunState::Gone || change.snapshot.is_null() {
            self.states.remove(&change.session_id);
            return;
        }
        self.states.insert(change.session_id.clone(), change.snapshot.clone());
        if self.away.is_none() && self.returned.is_none() {
            self.check_watch(&change.session_id, &change.snapshot);
        }
    }

    fn on_model_call(&mut self, call: &ProxyCallSettled) {
        if call.outcome == CallOutcome::Abandoned {
            if let Some(record) = self.away.as_mut().or(self.returned.as_mut()) {
                record.interrupted_model_calls += 1;
            }
        }
    }
}

async fn run(notices: broadcast::Sender<ConnectionNotice>, mut sources: ReattachSources) {
    let (wake, mut woken) = mpsc::unbounded_channel();
    let mut report = Report {
        notices,
        wake,
        sessions: sources.sessions.borrow_and_update().clone(),
        states: HashMap::new(),
        watches: HashMap::new(),
        away: None,
        returned: None,
        settle: None,
        generation: 0,
    };
    let first = sources.view.borrow_and_update().clone();
    report.on_view(&first);
    loop {
        tokio::select! {
            changed = sources.view.changed() => {
                if changed.is_err() {
                    return;
                }
                let view = sources.view.borrow_and_update().clone();
                report.on_view(&view);
            }
            changed = sources.sessions.changed() => {
                if changed.is_err() {
                    return;
                }
                let next = sources.sessions.borrow_and_update().clone();
                report.on_sessions(next);
            }
            state = sources.states.recv() => match state {
                Ok(change) => report.on_state(change),
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return,
            },
            call = sources.model_calls.recv() => match call {
                Ok(call) => report.on_model_call(&call),
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return,
            },
            Some(generation) = woken.recv() => {
                if report.settle == Some(generation) {
                    report.finish();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::link_machine::ModelLogin;
    use mixdog_protocol::ThreadSummary;
    use serde_json::json;

    struct Rig {
        notices: broadcast::Receiver<ConnectionNotice>,
        sessions: watch::Sender<Vec<SessionSummaryLite>>,
        states: broadcast::Sender<SessionStateChange>,
        view: watch::Sender<LinkViewState>,
        calls: broadcast::Sender<ProxyCallSettled>,
        _report: ReattachReport,
    }

    fn view(state: LinkState) -> LinkViewState {
        LinkViewState { connection_id: "s".into(), state, rtt_ms: None, terminals_available: true, model_login: ModelLogin::Pc }
    }

    fn row(id: &str, title: &str, running: bool) -> SessionSummaryLite {
        let summary: ThreadSummary = serde_json::from_value(json!({
            "id": id, "preview": "", "title": title, "updatedAt": 0, "messageCount": 0, "cwd": "", "classification": null,
            "projectPath": null, "working": running
        }))
        .unwrap();
        SessionSummaryLite {
            id: id.into(),
            title: title.into(),
            preview: String::new(),
            running,
            updated_at: 0,
            activity_at: 0,
            message_count: 0,
            archived: false,
            agent_session: false,
            awaiting_approval: false,
            awaiting_question: false,
            agent_home: None,
            summary,
        }
    }

    fn state(id: &str, busy: bool, tools: Value) -> SessionStateChange {
        SessionStateChange {
            session_id: id.into(),
            state: if busy { SessionRunState::Running } else { SessionRunState::Idle },
            started_at: None,
            snapshot: json!({ "busy": busy, "items": tools }),
        }
    }

    fn rig() -> Rig {
        let (notices, receiver) = broadcast::channel(16);
        let (sessions, sessions_rx) = watch::channel(Vec::new());
        let (states, states_rx) = broadcast::channel(16);
        let (view_tx, view_rx) = watch::channel(view(LinkState::Connected));
        let (calls, calls_rx) = broadcast::channel(16);
        let report = ReattachReport::start(
            notices,
            ReattachSources { sessions: sessions_rx, states: states_rx, view: view_rx, model_calls: calls_rx },
        );
        Rig { notices: receiver, sessions, states, view: view_tx, calls, _report: report }
    }

    fn lost() -> LinkState {
        LinkState::Reconnecting { attempt: 1, next_retry_at_ms: None, countdown_ms: None }
    }

    async fn settle() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_fresh_session_list_decides_finished_and_continued() {
        let mut rig = rig();
        rig.sessions.send(vec![row("a", "Alpha", true), row("b", "Beta", true)]).unwrap();
        settle().await;
        rig.view.send(view(lost())).unwrap();
        settle().await;
        rig.view.send(view(LinkState::Connected)).unwrap();
        settle().await;
        rig.sessions.send(vec![row("a", "Alpha", false), row("b", "Beta", true)]).unwrap();
        settle().await;
        assert_eq!(
            rig.notices.try_recv().unwrap(),
            ConnectionNotice::Reattached { finished: vec!["Alpha".into()], continued: vec!["Beta".into()], interrupted_model_calls: 0 }
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_known_list_is_used_after_the_wait() {
        let mut rig = rig();
        rig.sessions.send(vec![row("a", "Alpha", true)]).unwrap();
        settle().await;
        rig.view.send(view(lost())).unwrap();
        settle().await;
        rig.view.send(view(LinkState::Connected)).unwrap();
        settle().await;
        assert!(rig.notices.try_recv().is_err());
        tokio::time::advance(Duration::from_millis(REATTACH_SESSIONS_WAIT_MS + 1)).await;
        settle().await;
        assert!(matches!(rig.notices.try_recv().unwrap(), ConnectionNotice::Reattached { .. }));
    }

    #[tokio::test(start_paused = true)]
    async fn abandoned_model_calls_are_counted_and_an_empty_outage_says_nothing() {
        let mut rig = rig();
        rig.view.send(view(lost())).unwrap();
        settle().await;
        rig.calls.send(ProxyCallSettled { provider: "p".into(), outcome: CallOutcome::Abandoned, failure: None }).unwrap();
        rig.calls.send(ProxyCallSettled { provider: "p".into(), outcome: CallOutcome::Answered, failure: None }).unwrap();
        settle().await;
        rig.view.send(view(LinkState::Connected)).unwrap();
        settle().await;
        rig.sessions.send(Vec::new()).unwrap();
        settle().await;
        assert_eq!(
            rig.notices.try_recv().unwrap(),
            ConnectionNotice::Reattached { finished: vec![], continued: vec![], interrupted_model_calls: 1 }
        );
        // A second outage with nothing to tell.
        rig.view.send(view(lost())).unwrap();
        settle().await;
        rig.view.send(view(LinkState::Connected)).unwrap();
        settle().await;
        rig.sessions.send(vec![row("x", "X", false)]).unwrap();
        settle().await;
        assert!(rig.notices.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn a_call_still_unanswered_when_the_turn_ends_is_reported_once() {
        let mut rig = rig();
        let tools = json!([{"kind": "tool", "id": "t1"}, {"kind": "tool", "id": "t2", "result": {}}]);
        rig.states.send(state("a", true, tools.clone())).unwrap();
        settle().await;
        rig.view.send(view(lost())).unwrap();
        settle().await;
        rig.view.send(view(LinkState::Connected)).unwrap();
        settle().await;
        rig.sessions.send(vec![row("a", "Alpha", true)]).unwrap();
        settle().await;
        // The turn is still running: the call may yet get its result.
        rig.states.send(state("a", true, tools.clone())).unwrap();
        settle().await;
        assert!(rig.notices.try_recv().is_err());
        rig.states.send(state("a", false, tools)).unwrap();
        settle().await;
        assert_eq!(
            rig.notices.try_recv().unwrap(),
            ConnectionNotice::OutcomeUnknown { session_id: "a".into(), tool_ids: vec!["t1".into()] }
        );
        rig.states.send(state("a", false, json!([{"kind": "tool", "id": "t1"}]))).unwrap();
        settle().await;
        assert!(rig.notices.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn a_second_drop_before_the_report_is_one_outage() {
        let mut rig = rig();
        rig.sessions.send(vec![row("a", "Alpha", true)]).unwrap();
        settle().await;
        rig.view.send(view(lost())).unwrap();
        settle().await;
        rig.view.send(view(LinkState::Connected)).unwrap();
        settle().await;
        rig.view.send(view(LinkState::Paused)).unwrap();
        settle().await;
        tokio::time::advance(Duration::from_millis(REATTACH_SESSIONS_WAIT_MS + 1)).await;
        settle().await;
        assert!(rig.notices.try_recv().is_err());
        rig.view.send(view(LinkState::Connected)).unwrap();
        settle().await;
        rig.sessions.send(vec![row("a", "Alpha", false)]).unwrap();
        settle().await;
        assert_eq!(
            rig.notices.try_recv().unwrap(),
            ConnectionNotice::Reattached { finished: vec!["Alpha".into()], continued: vec![], interrupted_model_calls: 0 }
        );
    }
}
