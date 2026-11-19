//! `ToolHooks`: PostToolUse, PostToolUseFailure and PostToolBatch around the loop's tool calls
//! (`loop/tool-exec/after-hook.mjs`, `tool-batch/record-outcome.mjs`, `tool-batch/flush.mjs`).
//!
//! The loop's trait is best-effort by contract; this layer builds the event a hook receives and
//! reads a hook's answer exactly as Node does. Running the configured handlers is the
//! [`PostToolDispatch`] behind it (the hook bus).

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::env::GateCall;
use mixdog_agent::env::StopVerdict;
use mixdog_agent::env::ToolHooks;
use mixdog_protocol::JsonValue;

/// What a PostToolUse / PostToolUseFailure hook receives.
#[derive(Clone, PartialEq, Debug)]
pub struct PostToolEvent {
    /// The model's id of the call (`toolCallId`), the payload's `tool_use_id`.
    pub call_id: String,
    pub name: String,
    pub args: JsonValue,
    /// `effectiveToolCwd`: the shell call's own `cwd` argument, else the session's.
    pub cwd: String,
    pub session_id: String,
    pub result: String,
}

/// What the PostToolUse hooks decided: a replacement result, context for the model and, for a
/// block, its feedback (the tool already ran; owner-approved difference from Node, which drops
/// the last two).
#[derive(Clone, PartialEq, Debug, Default)]
pub struct PostToolAnswer {
    pub updated_output: Option<JsonValue>,
    pub context: Vec<String>,
    pub feedback: Option<String>,
}

/// What the Stop hooks decided for a turn the model ended.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct StopDecision {
    pub blocked: bool,
    pub reason: Option<String>,
}

pub struct BatchDecision {
    pub blocked: bool,
    pub reason: Option<String>,
}

/// The configured handlers for the three post-tool events. Errors are the dispatcher's to
/// swallow: a hook never breaks the loop, so these answer `None` on any failure.
#[async_trait]
pub trait PostToolDispatch: Send + Sync {
    async fn post_tool(&self, event: &PostToolEvent) -> PostToolAnswer;
    async fn post_failure(&self, event: &PostToolEvent);
    async fn post_batch(&self, session_id: &str, cwd: &str, tool_count: usize) -> Option<BatchDecision>;
    /// `Stop`, with `stop_hook_active` set on every continuation a block already made in the turn.
    async fn stop(&self, session_id: &str, cwd: &str, stop_hook_active: bool) -> StopDecision;
    /// `SubagentStop` of a worker's turn the model ended, with the same `stop_hook_active` rule as `Stop`.
    async fn subagent_stop(&self, session_id: &str, cwd: &str, agent_type: &str, stop_hook_active: bool) -> StopDecision;
}

/// The worker sessions whose spawn turn is running (`SubagentStart` to the spawn's end), each with whether a
/// `SubagentStop` the loop delivered at a stop that ended the turn already stands for the spawn's terminal event.
static SPAWN_RUNS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, bool>>> = std::sync::LazyLock::new(Default::default);

fn spawn_runs() -> std::sync::MutexGuard<'static, std::collections::HashMap<String, bool>> {
    SPAWN_RUNS.lock().unwrap_or_else(|e| e.into_inner())
}

/// The agent a worker session runs as, read from its header: `Some` when the header's owner is `agent` (the run host's
/// one agent-owner predicate), with the header's `agent` (empty when it names none).
pub(crate) fn worker_agent(header: &mixdog_store::schema::record::Header) -> Option<String> {
    super::compaction_world::is_agent_owner(header).then(|| header.get("agent").and_then(JsonValue::as_str).unwrap_or_default().to_owned())
}

pub struct SessionToolHooks {
    session_id: String,
    cwd: String,
    dispatch: Arc<dyn PostToolDispatch>,
    /// Nobody attends the session (a hidden or delegated agent): a Stop block does not continue it.
    unattended: bool,
    /// The agent of a worker session (its header's `owner` is `agent`): every turn it runs ends with its `SubagentStop`.
    worker: Option<String>,
    /// The loop's last stop asked `SubagentStop` and has not yet said what became of it.
    asked: std::sync::atomic::AtomicBool,
}

/// `normalizeHookUpdatedToolOutput` for a text result: a string as is, null as empty, a legacy
/// MCP text envelope joined. A value with non-text parts or of another type is not text, so the
/// result stays as the tool gave it.
fn updated_text(value: &JsonValue) -> Option<String> {
    match value {
        JsonValue::String(s) => Some(s.clone()),
        JsonValue::Null => Some(String::new()),
        JsonValue::Object(map) => {
            let parts = map.get("content")?.as_array()?;
            let non_text = |c: &JsonValue| {
                c.is_object() && c.get("type").is_some_and(|t| !t.is_null() && t.as_str() != Some("") && t.as_str() != Some("text"))
            };
            if parts.iter().any(non_text) {
                return None;
            }
            Some(
                parts
                    .iter()
                    .map(|c| {
                        if c.get("type").and_then(|t| t.as_str()) == Some("text") {
                            c.get("text").and_then(|t| t.as_str()).unwrap_or_default().to_owned()
                        } else {
                            mixdog_js::json_stringify(c)
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        }
        _ => None,
    }
}

#[async_trait]
impl ToolHooks for SessionToolHooks {
    async fn after_tool(&self, call_id: &str, call: &GateCall, result: &str) -> Option<String> {
        let answer = self.dispatch.post_tool(&self.event(call_id, call, result)).await;
        let replaced = answer.updated_output.as_ref().and_then(updated_text);
        let notes: Vec<String> = answer
            .context
            .into_iter()
            .chain(answer.feedback.map(|reason| format!("PostToolUse hook: {reason}")))
            .filter(|note| !mixdog_js::js_trim(note).is_empty())
            .collect();
        if notes.is_empty() {
            return replaced;
        }
        Some(format!("{}\n\n{}", replaced.as_deref().unwrap_or(result), notes.join("\n\n")))
    }

    async fn after_failure(&self, call_id: &str, call: &GateCall, result: &str) {
        self.dispatch.post_failure(&self.event(call_id, call, result)).await;
    }

    /// `Some(reason)` only for a blocking decision; the reason defaults to Node's text.
    async fn after_batch(&self, tool_count: usize) -> Option<String> {
        if tool_count == 0 {
            return None;
        }
        let decision = self.dispatch.post_batch(&self.session_id, &self.cwd, tool_count).await?;
        decision.blocked.then(|| {
            decision
                .reason
                .filter(|r| !r.is_empty())
                .unwrap_or_else(|| "PostToolBatch hook blocked continuation".to_owned())
        })
    }

    /// A block with a reason continues an attended turn; a block without one, or in an unattended
    /// session, is ignored with a warning.
    async fn on_stop(&self, stop_hook_active: bool) -> StopVerdict {
        // Every turn the model ended fires `Stop`, a worker's included (Node's turn settlement).
        let stopped = self.dispatch.stop(&self.session_id, &self.cwd, stop_hook_active).await;
        let verdict = stop_verdict("Stop", stopped, self.unattended);
        // A worker's turn end is also its `SubagentStop`, asked here so that a block continues the worker under the same
        // cap as `Stop`; `HookSubagentEvents::stop` then leaves that event to the loop. It is asked whatever `Stop`
        // answered: a `Stop` block the loop cannot honour ends the turn, and nothing else fires it for a restored worker.
        let Some(agent) = &self.worker else { return verdict };
        self.asked.store(true, std::sync::atomic::Ordering::SeqCst);
        let decided = self.dispatch.subagent_stop(&self.session_id, &self.cwd, agent, stop_hook_active).await;
        if matches!(verdict, StopVerdict::Continue(_)) || !decided.blocked { verdict } else { stop_verdict("SubagentStop", decided, false) }
    }

    /// Only a stop that ends the turn stands for the spawn's terminal event: a worker the loop continues may still fail
    /// or be cancelled, and that end fires it; a `Continue` the loop could not honour ended the turn after the hook ran.
    fn stop_settled(&self, continued: bool) {
        if self.asked.swap(false, std::sync::atomic::Ordering::SeqCst)
            && !continued
            && let Some(accepted) = spawn_runs().get_mut(&self.session_id)
        {
            *accepted = true;
        }
    }
}

/// A block with a reason continues the turn unless nobody attends it; a block without one is ignored with a warning.
fn stop_verdict(event: &str, decision: StopDecision, unattended: bool) -> StopVerdict {
    if !decision.blocked {
        return StopVerdict::Proceed;
    }
    let reason = decision.reason.as_deref().map(mixdog_js::js_trim).unwrap_or_default();
    if reason.is_empty() {
        return StopVerdict::Ignored(format!("A {event} hook blocked the stop without a reason; it is ignored."));
    }
    if unattended {
        return StopVerdict::Ignored(format!("A {event} hook blocked the stop of an unattended session; it is ignored: {reason}"));
    }
    StopVerdict::Continue(reason.to_owned())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_agent::agent_tool::flow::seams::SubagentEvents;
    use serde_json::json;

    use super::*;

    #[derive(Default)]
    struct Fake {
        answer: Mutex<PostToolAnswer>,
        stop: Mutex<(StopDecision, Vec<bool>)>,
        subagent_stop: Mutex<(StopDecision, Vec<(String, bool)>)>,
        seen: Mutex<Vec<PostToolEvent>>,
        decision: Mutex<Option<(bool, Option<String>)>>,
    }

    #[async_trait]
    impl PostToolDispatch for Fake {
        async fn post_tool(&self, event: &PostToolEvent) -> PostToolAnswer {
            self.seen.lock().unwrap().push(event.clone());
            self.answer.lock().unwrap().clone()
        }
        async fn stop(&self, _: &str, _: &str, stop_hook_active: bool) -> StopDecision {
            let mut stop = self.stop.lock().unwrap();
            stop.1.push(stop_hook_active);
            stop.0.clone()
        }
        async fn subagent_stop(&self, _: &str, _: &str, agent_type: &str, stop_hook_active: bool) -> StopDecision {
            let mut stop = self.subagent_stop.lock().unwrap();
            stop.1.push((agent_type.to_owned(), stop_hook_active));
            stop.0.clone()
        }
        async fn post_failure(&self, event: &PostToolEvent) {
            self.seen.lock().unwrap().push(event.clone());
        }
        async fn post_batch(&self, _: &str, _: &str, _: usize) -> Option<BatchDecision> {
            self.decision.lock().unwrap().clone().map(|(blocked, reason)| BatchDecision { blocked, reason })
        }
    }

    fn hooks(fake: &Arc<Fake>) -> SessionToolHooks {
        SessionToolHooks::new("s1", Path::new("/work"), fake.clone(), false)
    }

    #[tokio::test]
    async fn a_hook_overrides_the_visible_text_only_with_text() {
        let fake = Arc::new(Fake::default());
        let h = hooks(&fake);
        let call = GateCall::new("shell", json!({"command": "ls", "cwd": "sub"}));
        assert_eq!(h.after_tool("c1", &call, "out").await, None);
        let seen = fake.seen.lock().unwrap()[0].clone();
        assert_eq!((seen.session_id.as_str(), seen.call_id.as_str(), seen.result.as_str()), ("s1", "c1", "out"));
        assert!(seen.cwd.ends_with("sub") && seen.cwd.contains("work"), "{}", seen.cwd);
        let answer = |value: JsonValue| PostToolAnswer { updated_output: Some(value), ..PostToolAnswer::default() };
        *fake.answer.lock().unwrap() = answer(json!("replaced"));
        assert_eq!(h.after_tool("c1", &call, "out").await.as_deref(), Some("replaced"));
        *fake.answer.lock().unwrap() = answer(json!({"content": [{"type": "text", "text": "a"}, {"type": "x"}]}));
        assert_eq!(h.after_tool("c1", &call, "out").await, None);
        *fake.answer.lock().unwrap() = answer(json!({"content": [{"type": "text", "text": "a"}, {"text": "b"}]}));
        assert_eq!(h.after_tool("c1", &call, "out").await.as_deref(), Some("a\n{\"text\":\"b\"}"));
        *fake.answer.lock().unwrap() = answer(JsonValue::Null);
        assert_eq!(h.after_tool("c1", &call, "out").await.as_deref(), Some(""));
    }

    /// Owner-approved difference from Node (B-5): a PostToolUse hook's context and block feedback reach the model, after
    /// the result (a replacement included), which is kept.
    #[tokio::test]
    async fn post_tool_context_and_block_feedback_follow_the_result() {
        let fake = Arc::new(Fake::default());
        let h = hooks(&fake);
        let call = GateCall::new("shell", json!({"command": "ls"}));
        *fake.answer.lock().unwrap() = PostToolAnswer { context: vec!["ctx".into()], feedback: Some("why".into()), ..PostToolAnswer::default() };
        assert_eq!(h.after_tool("c1", &call, "out").await.as_deref(), Some("out\n\nctx\n\nPostToolUse hook: why"));
        *fake.answer.lock().unwrap() = PostToolAnswer { updated_output: Some(json!("new")), context: vec!["ctx".into()], ..PostToolAnswer::default() };
        assert_eq!(h.after_tool("c1", &call, "out").await.as_deref(), Some("new\n\nctx"));
    }

    /// A Stop block with a reason continues an attended turn (and `stop_hook_active` is passed on); one without a reason, or in
    /// an unattended session, is ignored with a warning.
    #[tokio::test]
    async fn a_stop_block_continues_only_an_attended_turn_and_only_with_a_reason() {
        let fake = Arc::new(Fake::default());
        let h = hooks(&fake);
        assert_eq!(h.on_stop(false).await, StopVerdict::Proceed);
        fake.stop.lock().unwrap().0 = StopDecision { blocked: true, reason: Some(" keep going ".into()) };
        assert_eq!(h.on_stop(true).await, StopVerdict::Continue("keep going".into()));
        assert_eq!(fake.stop.lock().unwrap().1, [false, true]);
        fake.stop.lock().unwrap().0 = StopDecision { blocked: true, reason: Some("  ".into()) };
        assert!(matches!(h.on_stop(false).await, StopVerdict::Ignored(_)));
        fake.stop.lock().unwrap().0 = StopDecision { blocked: true, reason: Some("r".into()) };
        let unattended = SessionToolHooks::new("s1", Path::new("/work"), fake.clone(), true);
        assert!(matches!(unattended.on_stop(false).await, StopVerdict::Ignored(_)));
    }

    /// A worker's turn end fires `Stop` as any turn's does (its block ignored in the unattended worker) and `SubagentStop`
    /// in addition, whose block continues the worker; once the hook allows, the turn ends and the event is not fired a
    /// second time at the spawn's end.
    #[tokio::test]
    async fn a_worker_turn_fires_stop_and_a_subagent_stop_block_continues_it() {
        let fake = Arc::new(Fake::default());
        let events = idle_events();
        events.start("reviewer", "worker-s1", "t");
        let worker = worker_hooks("worker-s1", &fake);
        fake.subagent_stop.lock().unwrap().0 = StopDecision { blocked: true, reason: Some(" run the tests ".into()) };
        assert_eq!(worker.on_stop(false).await, StopVerdict::Continue("run the tests".into()));
        worker.stop_settled(true);
        // A blocked stop the loop honoured is not one the hooks let happen: a worker that then fails still fires the
        // terminal event.
        assert!(!accepted("worker-s1"));
        fake.subagent_stop.lock().unwrap().0 = StopDecision::default();
        fake.stop.lock().unwrap().0 = StopDecision { blocked: true, reason: Some("more".into()) };
        assert!(matches!(worker.on_stop(true).await, StopVerdict::Ignored(_)), "the unattended worker's Stop block is ignored");
        worker.stop_settled(false);
        assert_eq!(fake.stop.lock().unwrap().1, [false, true], "Stop is asked for every worker turn end");
        assert_eq!(fake.subagent_stop.lock().unwrap().1, [("reviewer".to_owned(), false), ("reviewer".to_owned(), true)]);
        assert!(accepted("worker-s1"));
        // The spawn's end takes the acceptance (and does not fire the event again), and nothing of the worker is kept.
        events.stop("reviewer", "worker-s1", "t", "idle");
        assert!(!SPAWN_RUNS.lock().unwrap().contains_key("worker-s1"));
    }

    /// A `SubagentStop` block the loop cannot honour (the continuation cap, an ending that cannot go on) ends the turn
    /// after the hook ran: that stop is accepted, so the spawn's end does not run the hook a second time.
    #[tokio::test]
    async fn a_subagent_stop_block_the_loop_ignores_is_an_accepted_stop() {
        let fake = Arc::new(Fake::default());
        let events = idle_events();
        events.start("reviewer", "worker-s3", "t");
        let worker = worker_hooks("worker-s3", &fake);
        fake.subagent_stop.lock().unwrap().0 = StopDecision { blocked: true, reason: Some("again".into()) };
        assert_eq!(worker.on_stop(true).await, StopVerdict::Continue("again".into()));
        worker.stop_settled(false);
        assert!(accepted("worker-s3"));
        SPAWN_RUNS.lock().unwrap().remove("worker-s3");
    }

    /// A worker this process has never seen (a restored one, its registry empty) is known from its header: its turn asks
    /// `SubagentStop` as the header's agent, and a reasoned block continues it. A session whose header is not an agent
    /// owner's asks `Stop` only.
    #[tokio::test]
    async fn a_worker_known_only_from_its_header_asks_subagent_stop() {
        let fake = Arc::new(Fake::default());
        assert!(!SPAWN_RUNS.lock().unwrap().contains_key("restored-s5"));
        let header = |value: JsonValue| value.as_object().unwrap().clone();
        let agent = worker_agent(&header(json!({"owner": " Agent ", "agent": "reviewer"})));
        assert_eq!(agent.as_deref(), Some("reviewer"));
        assert_eq!(worker_agent(&header(json!({"owner": "user", "agent": "lead"}))), None);
        let restored = SessionToolHooks::new("restored-s5", Path::new("/work"), fake.clone(), true).worker(agent);
        fake.subagent_stop.lock().unwrap().0 = StopDecision { blocked: true, reason: Some("finish the review".into()) };
        assert_eq!(restored.on_stop(false).await, StopVerdict::Continue("finish the review".into()));
        restored.stop_settled(true);
        assert_eq!(fake.subagent_stop.lock().unwrap().1, [("reviewer".to_owned(), false)]);
        assert!(!SPAWN_RUNS.lock().unwrap().contains_key("restored-s5"), "no spawn of it to deduplicate against");
        let lead = SessionToolHooks::new("lead-s5", Path::new("/work"), fake.clone(), false).worker(None);
        assert_eq!(lead.on_stop(false).await, StopVerdict::Proceed);
        assert_eq!(fake.subagent_stop.lock().unwrap().1.len(), 1, "a session that is not a worker asks Stop only");
    }

    /// An attended worker whose `Stop` hook blocks with a reason is still asked `SubagentStop`: the loop may end the turn
    /// on that verdict (the continuation cap), and a restored worker has no spawn end to fire it.
    #[tokio::test]
    async fn a_stop_block_of_an_attended_worker_still_asks_subagent_stop() {
        let fake = Arc::new(Fake::default());
        let worker = SessionToolHooks::new("restored-s6", Path::new("/work"), fake.clone(), false).worker(Some("reviewer".to_owned()));
        fake.stop.lock().unwrap().0 = StopDecision { blocked: true, reason: Some("keep going".into()) };
        assert_eq!(worker.on_stop(true).await, StopVerdict::Continue("keep going".into()));
        assert_eq!(fake.subagent_stop.lock().unwrap().1, [("reviewer".to_owned(), true)]);
    }

    fn worker_hooks(session_id: &str, fake: &Arc<Fake>) -> SessionToolHooks {
        SessionToolHooks::new(session_id, Path::new("/work"), fake.clone(), true).worker(Some("reviewer".into()))
    }

    /// Lifecycle events over a bus with no hooks configured.
    fn idle_events() -> HookSubagentEvents {
        let tokens = mixdog_rt::testing::tokens();
        let processes = Arc::new(mixdog_core_api::domain::mock::MockProcessManager::default());
        let bus = mixdog_mcp::hook_bus::HookBus::new(std::env::temp_dir().join("mixdog-hooks-no-config"), tokens.maintenance_io, processes, None, None, None);
        HookSubagentEvents::new(bus, Arc::new(|_: &str| (std::env::temp_dir(), mixdog_mcp::hook_bus::HookCommon::default())))
    }

    fn accepted(session_id: &str) -> bool {
        SPAWN_RUNS.lock().unwrap().get(session_id).copied().unwrap_or(false)
    }

    /// A `SubagentStop` block without a reason, read by the real parser from an exit 2 or a bare `decision: "block"`, is
    /// ignored with a warning as a reasonless `Stop` block is: it does not continue the worker.
    #[tokio::test]
    async fn a_reasonless_subagent_stop_block_does_not_continue_the_worker() {
        use mixdog_mcp::hook_bus::output::HandlerRun;
        use mixdog_mcp::hook_bus::output::parse_handler_output;
        let fake = Arc::new(Fake::default());
        let worker = worker_hooks("worker-s2", &fake);
        let exit2 = HandlerRun { exit_code: 2, ..HandlerRun::default() };
        let bare = HandlerRun { exit_code: 0, stdout: r#"{"decision":"block"}"#.into(), ..HandlerRun::default() };
        for run in [exit2, bare] {
            let parsed = parse_handler_output(&run, "SubagentStop");
            fake.subagent_stop.lock().unwrap().0 = StopDecision { blocked: parsed.block, reason: parsed.reason };
            match worker.on_stop(false).await {
                StopVerdict::Ignored(warning) => assert!(warning.contains("without a reason"), "{warning}"),
                other => panic!("{run:?}: {other:?}"),
            }
        }
    }

    /// Configured command hooks reach a spawned worker's turn end through the real hook bus: `SubagentStop` blocks with
    /// its reason and continues the worker; on the continuation it allows, and the `Stop` hook's block (fired too, ignored
    /// in the unattended worker) comes back with its reason.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[allow(clippy::disallowed_methods, reason = "Test-only fixture setup: the hook configuration file.")]
    async fn configured_hooks_reach_a_worker_turn_through_the_bus() {
        use mixdog_mcp::hook_bus::HookCommon;
        let dir = tempfile::tempdir().unwrap();
        let (shell, stop, subagent_stop) = if cfg!(windows) {
            (
                "powershell",
                r#"'{"decision":"block","reason":"from stop"}'"#,
                r#"$i = [Console]::In.ReadToEnd(); if ($i -notmatch '"stop_hook_active":true') { '{"decision":"block","reason":"run the tests"}' }"#,
            )
        } else {
            (
                "bash",
                r#"echo '{"decision":"block","reason":"from stop"}'"#,
                r#"i=$(cat); case "$i" in *'"stop_hook_active":true'*) ;; *) echo '{"decision":"block","reason":"run the tests"}' ;; esac"#,
            )
        };
        let handler = |command: &str| json!([{"hooks": [{"type": "command", "command": command, "shell": shell, "timeout": 60}]}]);
        let config = json!({"hooks": {"Stop": handler(stop), "SubagentStop": handler(subagent_stop)}});
        std::fs::write(dir.path().join("hooks.json"), config.to_string()).unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let processes = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
        let bus = mixdog_mcp::hook_bus::HookBus::new(dir.path().to_path_buf(), tokens.maintenance_io, processes, None, None, None);
        let dispatch = Arc::new(super::super::mcp_seams::BusPostToolDispatch::new(bus.clone(), Arc::new(|_: &str| HookCommon::default())));
        let cwd = dir.path().to_path_buf();
        let events = HookSubagentEvents::new(bus, Arc::new(move |_: &str| (cwd.clone(), HookCommon::default())));
        events.start("reviewer", "worker-bus", "t");
        let header = json!({"owner": "agent", "agent": "reviewer"}).as_object().unwrap().clone();
        let worker = SessionToolHooks::new("worker-bus", dir.path(), dispatch, true).worker(worker_agent(&header));
        assert_eq!(worker.on_stop(false).await, StopVerdict::Continue("run the tests".into()));
        worker.stop_settled(true);
        match worker.on_stop(true).await {
            StopVerdict::Ignored(warning) => assert!(warning.contains("from stop"), "{warning}"),
            other => panic!("{other:?}"),
        }
        worker.stop_settled(false);
        assert!(accepted("worker-bus"));
        events.stop("reviewer", "worker-bus", "t", "idle");
        assert!(!SPAWN_RUNS.lock().unwrap().contains_key("worker-bus"));
    }

    /// A call prepared in one folder and finished after the session moved to another reports the folder it ran in.
    #[tokio::test]
    async fn the_event_names_the_folder_the_call_was_prepared_in() {
        let fake = Arc::new(Fake::default());
        let h = hooks(&fake);
        let prepared_in = Path::new("/started");
        h.after_tool("c1", &GateCall::new("edit", json!({"file_path": "x"})).at(prepared_in), "out").await;
        h.after_failure("c2", &GateCall::new("shell", json!({"command": "ls", "cwd": "sub"})).at(prepared_in), "bad").await;
        let seen = fake.seen.lock().unwrap().clone();
        assert!(seen[0].cwd.contains("started") && !seen[0].cwd.contains("work"), "{}", seen[0].cwd);
        assert!(seen[1].cwd.contains("started") && seen[1].cwd.ends_with("sub"), "{}", seen[1].cwd);
    }

    #[tokio::test]
    async fn only_a_blocking_batch_decision_gives_a_reason() {
        let fake = Arc::new(Fake::default());
        let h = hooks(&fake);
        assert_eq!(h.after_batch(2).await, None);
        *fake.decision.lock().unwrap() = Some((false, Some("x".into())));
        assert_eq!(h.after_batch(2).await, None);
        *fake.decision.lock().unwrap() = Some((true, None));
        assert_eq!(h.after_batch(0).await, None);
        assert_eq!(h.after_batch(1).await.as_deref(), Some("PostToolBatch hook blocked continuation"));
        *fake.decision.lock().unwrap() = Some((true, Some("stop".into())));
        assert_eq!(h.after_batch(1).await.as_deref(), Some("stop"));
    }
}

/// What a hook payload carries besides the event: the worker session's directory and common
/// fields (`hookCommonPayload`, which reads the transcript path of the session it is given).
pub type SubagentContext = Arc<dyn Fn(&str) -> (std::path::PathBuf, mixdog_mcp::hook_bus::HookCommon) + Send + Sync>;

/// `SubagentEvents` over the hook bus (`onSubagentEvent` → `hooks.dispatch`). Fire and forget:
/// a hook problem never reaches the worker's lifecycle.
pub struct HookSubagentEvents {
    bus: Arc<mixdog_mcp::hook_bus::HookBus>,
    context: SubagentContext,
}

impl HookSubagentEvents {
    pub fn new(bus: Arc<mixdog_mcp::hook_bus::HookBus>, context: SubagentContext) -> Self {
        Self { bus, context }
    }

    fn emit(&self, stop: bool, agent: &str, session_id: &str) {
        let bus = self.bus.clone();
        let (cwd, common) = (self.context)(session_id);
        let (agent, session_id) = (agent.to_owned(), session_id.to_owned());
        tokio::spawn(async move {
            bus.subagent(stop, &session_id, Some(&agent), &cwd, &common).await;
        });
    }
}

impl mixdog_agent::agent_tool::flow::seams::SubagentEvents for HookSubagentEvents {
    fn start(&self, agent: &str, session_id: &str, _tag: &str) {
        spawn_runs().insert(session_id.to_owned(), false);
        self.emit(false, agent, session_id);
    }

    // The bus takes the agent and session only: the tag and status are not part of the payload. A spawn whose loop
    // already delivered `SubagentStop` at a stop that ended the turn does not fire it twice; one that failed or was
    // cancelled before that (a block's continuation included) does.
    fn stop(&self, agent: &str, session_id: &str, _tag: &str, _status: &str) {
        let accepted = spawn_runs().remove(session_id).unwrap_or(false);
        if !accepted {
            self.emit(true, agent, session_id);
        }
    }
}

impl SessionToolHooks {
    pub fn new(session_id: &str, cwd: &Path, dispatch: Arc<dyn PostToolDispatch>, unattended: bool) -> Self {
        Self {
            session_id: session_id.to_owned(),
            cwd: cwd.to_string_lossy().into_owned(),
            dispatch,
            unattended,
            worker: None,
            asked: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// The session is a worker running as `agent` (`SubagentStop`'s `agent_type`), as its header says: whatever this
    /// process has seen of it, every turn it runs ends with its `SubagentStop`.
    pub fn worker(mut self, agent: Option<String>) -> Self {
        self.worker = agent;
        self
    }

    /// The event reports the folder the call was prepared in (`call.cwd = prepared.cwd`), not the session's folder at the time
    /// it finished.
    fn event(&self, call_id: &str, call: &GateCall, result: &str) -> PostToolEvent {
        let cwd = call.cwd.as_ref().map_or_else(|| self.cwd.clone(), |cwd| cwd.to_string_lossy().into_owned());
        PostToolEvent {
            call_id: call_id.to_owned(),
            name: call.name.clone(),
            args: call.args.clone(),
            cwd: effective_tool_cwd(&call.name, &call.args, &cwd),
            session_id: self.session_id.clone(),
            result: result.to_owned(),
        }
    }
}
fn expand_home(path: &str) -> String {
    let home = || std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
    if path == "~" {
        return home();
    }
    match path.strip_prefix("~/").or_else(|| if cfg!(windows) { path.strip_prefix("~\\") } else { None }) {
        Some(rest) => super::result_reuse::resolve(&home(), rest),
        None => path.to_owned(),
    }
}
/// `effectiveToolCwd`: the shell's `cwd` argument resolved against the session cwd; the session
/// cwd for every other tool.
pub(crate) fn effective_tool_cwd(tool: &str, args: &JsonValue, session_cwd: &str) -> String {
    if tool != "shell" {
        return session_cwd.to_owned();
    }
    let Some(requested) = args.get("cwd").and_then(|c| c.as_str()).filter(|c| !mixdog_js::js_trim(c).is_empty()) else {
        return session_cwd.to_owned();
    };
    let resolved = super::result_reuse::resolve(session_cwd, &expand_home(requested));
    if cfg!(windows) { resolved.replace('/', "\\") } else { resolved }
}
