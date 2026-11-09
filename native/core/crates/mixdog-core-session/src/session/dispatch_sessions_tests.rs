//! [`DispatchThreads`]: the status writes against `fixtures/dispatch-sessions/golden.json`
//! (Node's `updateSessionStatus` before and after `closeSession`), and the ask over a scripted
//! run: the reply, the turn handed to the run (the dispatch's own watchdog, so the run arms none),
//! and an abort that ends the turn with the signal's reason and the ask with Node's
//! `SessionClosedError` text.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_agent::agent_tool::flow::seams::TurnResult;
use mixdog_agent::cancel::Cancel;
use mixdog_core_api::ids::ThreadId;
use serde_json::Value;
use serde_json::json;

use super::DispatchThreads;
use crate::session::RunOutcome;
use crate::session::SessionDirectory;
use crate::session::agent_registry::RuntimeRelease;
use crate::session::agent_registry::SessionTurns;
use crate::session::close::SessionClose;
use crate::session::testing::Rig;
use crate::eventually_on;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/dispatch-sessions/golden.json")).expect("golden.json")
}

struct NoRelease;

impl RuntimeRelease for NoRelease {
    fn release(&self, _: &ThreadId, _: &str) {}
}

struct NoShells;

impl crate::session::shell_jobs::OwnedShells for NoShells {
    fn cancel_owned(&self, _: &ThreadId) {}
}

struct NoProviders;

#[async_trait]
impl mixdog_ai::registry::providers::ProviderBuilder for NoProviders {
    async fn build(&self, name: &str, _: &Value) -> Result<Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, String> {
        Err(format!("no {name}"))
    }
    async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn available(&self, _: &str) -> bool {
        false
    }
    async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
        Ok(false)
    }
}

/// A slot that hands nothing back: the task just runs.
struct Immediate;

#[async_trait]
impl mixdog_agent::env::Yielder for Immediate {
    async fn run_yielded(&self, task: futures::future::BoxFuture<'_, bool>, _: Option<&Cancel>) -> Result<(), String> {
        task.await;
        Ok(())
    }
}

fn threads(directory: &Arc<SessionDirectory>) -> DispatchThreads {
    let providers = Arc::new(mixdog_ai::registry::providers::ProviderRegistry::new(Arc::new(NoProviders)));
    let read_state = Arc::new(mixdog_tools::fs::ReadState::new(None));
    let close = Arc::new(SessionClose::new(directory.clone(), providers, Arc::new(NoShells), read_state));
    DispatchThreads::new(directory.clone(), Arc::new(SessionTurns::new(directory.clone(), Arc::new(NoRelease))), close, None)
}

fn hidden_header() -> mixdog_store::schema::record::Header {
    json!({ "agent": "cycle1-agent", "owner": "agent", "provider": "stub", "model": "stub-model", "schemaAllowedTools": [] }).as_object().cloned().expect("header")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_status_is_written_until_the_session_is_closed() {
    let golden = golden();
    let status = &golden["status"];
    let rig = Rig::new();
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let threads = threads(&directory);
    let id = threads.create(hidden_header()).await.expect("created");
    let thread = ThreadId::from(id.as_str());
    let stored = |key: &'static str| {
        let directory = directory.clone();
        let thread = thread.clone();
        async move { directory.stored_header(&thread).await.expect("stored").get(key).cloned().unwrap_or(Value::Null) }
    };
    assert!(stored("createdAt").await.is_number(), "createSession stamps its creation time");
    threads.set_status(&id, "running").await;
    assert_eq!(stored("status").await, status["runningStatus"]);
    threads.close(&id, "ephemeral-done").await;
    threads.set_status(&id, "idle").await;
    assert_eq!(stored("status").await, status["afterClose"], "a tombstone refuses the status write");
    threads.set_status("sess_unknown", "idle").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ask_answers_the_reply_and_an_abort_ends_the_turn_with_nodes_text() {
    let rig = Rig::new();
    let heard: Arc<Mutex<Vec<(bool, bool, bool, Value)>>> = Arc::default();
    let record = heard.clone();
    let signal: Arc<Mutex<Option<String>>> = Arc::default();
    let seen = signal.clone();
    let started: Arc<Mutex<bool>> = Arc::default();
    let marked = started.clone();
    // Raised by the script after each flag it sets: what the waits below are woken by.
    let changed = Arc::new(tokio::sync::Notify::new());
    let wake = changed.clone();
    rig.set_script(Arc::new(move |run| {
        let (record, aborted, ready, wake) = (record.clone(), seen.clone(), marked.clone(), wake.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            // As the run host does at each ask (`markSessionAskStart`): a fresh entry.
            run.progress.send_modify(|p| p.ask_start(0));
            let agent = run.agent_turn.as_ref();
            record.lock().unwrap().push((
                run.unattended,
                agent.is_some_and(|turn| turn.caller_watchdog),
                agent.is_some_and(|turn| turn.slot.is_some()),
                run.input_body.clone(),
            ));
            let text = run.input_body.to_string();
            if text.contains("hang") {
                // "loop": the model loop runs (a provider call in flight); "tool": it has moved on
                // to the tool the first call asked for, between two provider calls.
                if text.contains("loop") {
                    run.progress.send_modify(|p| p.model_loop(true));
                }
                if text.contains("tool") {
                    run.progress.send_modify(|p| p.stage_change("tool_running", 0));
                }
                *ready.lock().unwrap() = true;
                wake.notify_waiters();
                run.cancel.cancelled().await;
                *aborted.lock().unwrap() = Some(run.signal.reason());
                wake.notify_waiters();
                return RunOutcome::Interrupted;
            }
            RunOutcome::Completed(Box::new(TurnResult { content: "reply text".into(), iterations: 1, ..Default::default() }))
        })
    }));
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let threads = threads(&directory);
    let id = threads.create(hidden_header()).await.expect("created");

    let cancel = Cancel::new();
    assert_eq!(threads.ask(&id, "summarise the rows", None, Arc::new(Immediate), &cancel).await, Ok("reply text".to_owned()));
    let (unattended, caller_watchdog, slot, input) = heard.lock().unwrap()[0].clone();
    assert!(!unattended && caller_watchdog && slot, "the dispatch's watchdog is the only one; its slot reaches the run");
    assert!(input.to_string().contains("summarise the rows"), "{input}");

    // A parent abort (reason "parent aborted") in each recorded place: what Node's `askSession`
    // threw, with the session id in place of `<session>`; the run's signal carries the reason.
    let golden = golden();
    let node = |name: &str| {
        let case = golden["aborts"].as_array().expect("aborts").iter().find(|case| case["name"] == name).expect(name).clone();
        case["error"].as_str().expect("an error").replace("<session>", &id)
    };
    let thread = ThreadId::from(id.as_str());
    let threads = Arc::new(threads);
    let abort_in = |prompt: &'static str| {
        let (threads, id, directory, thread, signal, started, changed) = (threads.clone(), id.clone(), directory.clone(), thread.clone(), signal.clone(), started.clone(), changed.clone());
        async move {
            *started.lock().unwrap() = false;
            *signal.lock().unwrap() = None;
            let cancel = Cancel::new();
            let asking = tokio::spawn({
                let (threads, id, cancel) = (threads.clone(), id.clone(), cancel.clone());
                async move { threads.ask(&id, prompt, None, Arc::new(Immediate), &cancel).await }
            });
            eventually_on!(&[&changed], || started.lock().unwrap().then_some(())).await;
            cancel.abort("parent aborted");
            let answer = asking.await.expect("ask");
            eventually_on!(&[&changed], || signal.lock().unwrap().clone()).await;
            assert_eq!(signal.lock().unwrap().as_deref(), Some("parent aborted"), "{prompt}: the turn ends with the signal's reason");
            let live = directory.handle(&thread).expect("the thread is loaded while its turn runs");
            // Not just the run gone: the next ask is refused as busy until the Goal settlement is back.
            eventually_on!(&[&live.cell.stepped], || (!live.cell.busy.load(std::sync::atomic::Ordering::SeqCst)).then_some(())).await;
            answer
        }
    };
    // A provider call in flight.
    assert_eq!(abort_in("hang loop").await, Err(node("during-call")));
    // Between two provider calls (the first answered with a tool call): Node's interrupt window
    // spans the whole model loop, so this too is "during call".
    assert_eq!(abort_in("hang loop tool").await, Err(node("between-calls")));
    // The turn started, its model loop not yet (`_api_call_with_interrupt` meets an aborted
    // signal on entry).
    assert_eq!(abort_in("hang").await, Err(format!("Session \"{id}\" closed: aborted before call: parent aborted")));

    // Already aborted when the ask starts: its reason, and no turn runs.
    let aborted = Cancel::new();
    aborted.abort("parent aborted");
    let turns = heard.lock().unwrap().len();
    assert_eq!(threads.ask(&id, "late", None, Arc::new(Immediate), &aborted).await, Err(node("before-ask")));
    assert_eq!(heard.lock().unwrap().len(), turns);
}
