//! The session's turn operations against Node's session actions (`session/turn_ops.rs`).

use std::sync::Arc;

use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_goal::goal::hooks::GoalViewHooks;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::SessionHandle;
use super::seams::RunOutcome;
use super::testing::Rig;
use crate::eventually_on_until;
use crate::eventually_on;
use super::tests::idle;
use super::tests::start_routed_thread;
use super::tests::start_thread;
use super::tests::turn;

/// The context's rows once one of them carries its turn's completion, woken by each store commit; the wait is registered
/// before the read so a commit between the read and the wait is not missed.
async fn rows_with_completion(rig: &Rig, context: &super::run::ModelContext) -> Vec<Value> {
    super::testing::awaiting(|| "a committed row carrying the turn's completion".to_owned(), async {
        loop {
            let committed = rig.store.committed.notified();
            tokio::pin!(committed);
            committed.as_mut().enable();
            let rows: Vec<Value> = context.read().await.expect("context").into_iter().map(|(_, message)| message).collect();
            if rows.iter().any(|message| message.pointer("/meta/transcript/completion").is_some()) {
                return rows;
            }
            committed.await;
        }
    })
    .await
}

fn request(method: &'static str, params: Value, op: &str) -> CoreRequest {
    CoreRequest {
        method: Method(method),
        params,
        op: Some(OpId::from(op)),
        ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new()),
    }
}

async fn call(handle: &SessionHandle, method: &'static str, mut params: Value, op: &'static str) -> Result<Value, CoreError> {
    params["threadId"] = json!(handle.id);
    params["opId"] = json!(op);
    match handle.request(request(method, params, op)).await? {
        Reply::Value(value) => Ok(value),
        other => panic!("a value reply, got {other:?}"),
    }
}

/// A retry the session accepts once the failed turn has settled: Node's button only shows then,
/// so a refusal before that is polled past (each attempt its own op id).
async fn retry_when_settled(handle: &SessionHandle, key: &str, tag: &'static str) {
    use std::sync::atomic::Ordering::SeqCst;
    eventually_on!(&[&handle.cell.stepped], || (!handle.cell.busy.load(SeqCst) && !handle.cell.compacting.load(SeqCst)).then_some(())).await;
    assert_eq!(call(handle, "turn/retryFailed", json!({ "turnKey": key }), tag).await.expect("answered"), json!(true), "the settled turn takes its retry");
}

/// A run held open until the gate is notified.
fn held(rig: &Rig) -> Arc<tokio::sync::Notify> {
    let gate = Arc::new(tokio::sync::Notify::new());
    let open = gate.clone();
    rig.set_script(Arc::new(move |run| {
        let open = open.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            open.notified().await;
            RunOutcome::Completed(Default::default())
        })
    }));
    gate
}

/// `pushNotice(text, tone)` of a hosted runtime: the polished text is a muted notice row of no
/// turn, shown live and published; the answer is the row id, `null` for a text with nothing left.
#[tokio::test(start_paused = true)]
async fn a_pushed_notice_shows_its_polished_text_as_a_row_of_no_turn() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;

    let id = call(&handle, "thread/pushNotice", json!({ "text": "✓ saved the file", "level": "warn" }), "n-1").await.expect("pushed");
    let id = id.as_str().expect("the row id").to_owned();
    let shown_of = |id: Value| {
        rig.feeds.frames(handle.id.as_str()).into_iter().find(|(_, method, params)| method == "item/completed" && params["item"]["id"] == id).map(|(_, _, params)| params)
    };
    let shown = eventually_on!(&[&rig.feeds.published], || shown_of(json!(id))).await;
    assert_eq!(shown["turnId"], "");
    // A notice is a status row of kind `notice`; its polished text and tone ride in the row's ext.
    assert_eq!((shown["item"]["type"].clone(), shown["item"]["kind"].clone()), (json!("statusRow"), json!("notice")));
    let row = shown["item"].to_string();
    assert!(row.contains("\"saved the file\"") && row.contains("\"warn\""), "{row}");

    // The tone defaults to `info`; a text that polishes to nothing shows no row.
    let second = call(&handle, "thread/pushNotice", json!({ "text": "plain" }), "n-2").await.expect("pushed");
    let last = eventually_on!(&[&rig.feeds.published], || shown_of(second.clone())).await;
    assert!(last["item"].to_string().contains("\"info\""), "{}", last["item"]);
    let before = rig.feeds.frames(handle.id.as_str()).len();
    assert_eq!(call(&handle, "thread/pushNotice", json!({ "text": "   " }), "n-3").await.expect("pushed"), Value::Null);
    assert_eq!(rig.feeds.frames(handle.id.as_str()).len(), before);
}

/// `clearSessionChangeHistory` (`integrations.mjs`): refused with Node's text while the session
/// runs a turn, else `{turns}` of the turn review.
#[tokio::test(start_paused = true)]
async fn the_change_history_is_cleared_only_while_the_session_runs_no_turn() {
    let rig = Rig::new();
    let gate = held(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;

    let refused = call(&handle, "thread/clearSessionChangeHistory", json!({}), "c-1").await.expect_err("a turn runs");
    let CoreError::DomainError { message, .. } = refused else { panic!("a plain error") };
    assert_eq!(message.as_deref(), Some("Change history cannot be deleted while this session is running a turn"));

    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(call(&handle, "thread/clearSessionChangeHistory", json!({}), "c-2").await.expect("cleared"), json!({ "turns": 0 }));
}

fn plain_error(error: CoreError) -> String {
    let CoreError::DomainError { message, .. } = error else { panic!("a plain error: {error:?}") };
    message.expect("a message").to_string()
}

fn reply(content: &str, tool_call: bool) -> Result<super::turn_ops::SideReply, super::turn_ops::SideFailure> {
    Ok(super::turn_ops::SideReply { content: content.into(), tool_call })
}

/// `askSideQuestion` (`side-question.mjs`): Node's refusals, the `<side-question>` prompt, the
/// trimmed answer, and the tool-attempt and empty-answer texts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_side_question_is_answered_from_the_saved_request_with_nodes_texts() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let ask = |q: &'static str, op: &'static str| call(&handle, "thread/askSide", json!({ "question": q }), op);

    assert_eq!(plain_error(ask("  \n", "a-1").await.expect_err("empty")), "Side question is empty.");
    assert_eq!(plain_error(ask("why?", "a-2").await.expect_err("no request")), "Send a message first, then try /btw.");
    assert_eq!(rig.side.begins.load(std::sync::atomic::Ordering::SeqCst), 0, "a missing request aborts nothing");

    rig.side.request.store(true, std::sync::atomic::Ordering::SeqCst);
    *super::testing::lock(&rig.side.reply) = Some(reply("  because.\n", false));
    assert_eq!(ask("  why?  ", "a-3").await.expect("answered"), json!({ "text": "because." }));
    let prompt = super::testing::lock(&rig.side.prompts)[0].clone();
    assert!(prompt.starts_with("<side-question>\nThe user is asking you a quick side question.") && prompt.ends_with("\n\nwhy?\n</side-question>"), "{prompt}");

    *super::testing::lock(&rig.side.reply) = Some(reply("x", true));
    assert_eq!(ask("q", "a-4").await.expect("answered")["text"], "The model tried to use a tool instead of answering. A side question cannot run tools; try asking it differently.");
    *super::testing::lock(&rig.side.reply) = Some(reply(" ", false));
    assert_eq!(ask("q", "a-5").await.expect("answered")["text"], "The model returned no answer.");
    *super::testing::lock(&rig.side.reply) = Some(Err(super::turn_ops::SideFailure::Failed("provider down".into())));
    assert_eq!(plain_error(ask("q", "a-6").await.expect_err("failed")), "provider down");
}

/// `cancelSide`: aborts the question in flight with `Side question canceled.`; a new question
/// aborts the previous one.
#[tokio::test(start_paused = true)]
async fn a_side_question_in_flight_is_canceled_by_cancel_side_or_a_newer_question() {
    let rig = Rig::new();
    rig.side.request.store(true, std::sync::atomic::Ordering::SeqCst);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let begun = |n: usize| rig.side.begins.load(std::sync::atomic::Ordering::SeqCst) == n;

    let mut first = {
        let (handle, q) = (handle.clone(), json!({ "question": "one" }));
        tokio::spawn(async move { call(&handle, "thread/askSide", q, "s-1").await })
    };
    eventually_on_until!(&[&rig.side.began], || begun(1).then_some(()), &mut first).await;
    assert_eq!(call(&handle, "thread/cancelSide", json!({}), "s-2").await.expect("canceled"), Value::Null);
    assert_eq!(plain_error(first.await.expect("joined").expect_err("canceled")), "Side question canceled.");

    let mut second = {
        let (handle, q) = (handle.clone(), json!({ "question": "two" }));
        tokio::spawn(async move { call(&handle, "thread/askSide", q, "s-3").await })
    };
    eventually_on_until!(&[&rig.side.began], || (begun(2) && super::testing::lock(&rig.side.prompts).len() == 2).then_some(()), &mut second).await;
    *super::testing::lock(&rig.side.reply) = Some(reply("done", false));
    assert_eq!(call(&handle, "thread/askSide", json!({ "question": "three" }), "s-4").await.expect("answered"), json!({ "text": "done" }));
    assert_eq!(plain_error(second.await.expect("joined").expect_err("replaced")), "Side question canceled.");
}

async fn preflight(directory: &SessionDirectory, params: Value) -> Value {
    match directory.request(request("thread/inheritancePreflight", params, "pf")).await.expect("preflight") {
        Reply::Value(value) => value,
        other => panic!("a value reply, got {other:?}"),
    }
}

/// `inheritancePreflight` (`lifecycle/inheritance.mjs`): the verdict's shape and key order are
/// Node's, recorded in `golden/inheritance_preflight.json` for the source it measured. The
/// heir's policy (`limit`, `used`) is the host's; the conversation counted is the source's own.
#[tokio::test(start_paused = true)]
async fn the_preflight_answers_nodes_verdict_for_the_heir_route() {
    let golden: Value = serde_json::from_str(include_str!("golden/inheritance_preflight.json")).expect("golden");
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let current = start_thread(&directory).await;
    let source = start_thread(&directory).await;
    turn(&source, "carry this", "op-1").await;
    eventually_on!(&[&source.cell.stepped], || idle(&source).then_some(())).await;
    let patch = json!({ "threadId": current.id, "set": { "provider": "openai", "model": "gpt-5" }, "unset": [] });
    current.request(CoreRequest { method: Method("thread/header/patch"), params: patch, op: None, ctx: CallContext::internal("test") }).await.expect("patch");
    let cases = [
        ("small", Some(&source.id), (272_000, 74)),
        ("big", Some(&source.id), (272_000, 455_009)),
        ("live", None, (272_000, 12)),
        ("missing", Some(&"sess_none".to_owned().into()), (272_000, 0)),
    ];
    for (name, id, (limit, used)) in cases {
        *super::testing::lock(&rig.inherit.basis) = Some((limit, used, true));
        let mut params = json!({ "threadId": current.id });
        if let Some(id) = id {
            params["sourceThreadId"] = json!(id);
        }
        let got = preflight(&directory, params).await;
        // The conversation counted and the source named are this rig's own.
        let mut want = golden[name].clone();
        want["messages"] = got["messages"].clone();
        want["sourceSessionId"] = json!(id.unwrap_or(&current.id));
        assert_eq!(got, want, "{name}");
        assert_eq!(got.as_object().unwrap().keys().collect::<Vec<_>>(), want.as_object().unwrap().keys().collect::<Vec<_>>(), "{name} key order");
    }
    let asked = super::testing::lock(&rig.inherit.asked).clone();
    assert_eq!((asked[0].0.as_str(), asked[0].1.as_str(), asked[0].2, asked[0].3.as_ref()), ("openai", "gpt-5", None, Some(&current.id)));
    assert_eq!(asked[3].4, 0, "an unknown source carries no messages");

    // An unmeasurable route stays permissive; a selection names the heir's route.
    *super::testing::lock(&rig.inherit.basis) = None;
    let open = preflight(&directory, json!({ "threadId": current.id, "sourceThreadId": source.id, "selection": { "provider": "anthropic", "model": "claude" } })).await;
    assert_eq!((open["provider"].clone(), open["known"].clone(), open["fits"].clone(), open["percent"].clone(), open["willCompact"].clone()), (json!("anthropic"), json!(false), json!(true), Value::Null, json!(false)));
    assert_eq!(super::testing::lock(&rig.inherit.asked).last().unwrap().2, None, "another route's window is its own default");
    // No route to open on (no session, no selection): no target at all.
    let none = preflight(&directory, json!({ "sourceThreadId": source.id })).await;
    assert_eq!((none["provider"].clone(), none["model"].clone(), none["known"].clone()), (json!(""), json!(""), json!(false)));
}

/// With no source named the preflight falls back to the current session (`getSessionId()`); a thread with no session yet has
/// none, so Node names no source (`sourceSessionId: null`), and a thread that has its session names itself.
#[tokio::test(start_paused = true)]
async fn the_preflight_names_no_current_session_for_a_thread_without_one() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let header = |value: Value| value.as_object().cloned().expect("header");
    directory.create_with_id(mixdog_core_api::ids::ThreadId::from("sess_reserved"), header(json!({ "cwd": "/ws" })), json!({})).await.expect("create");
    directory.create_with_id(mixdog_core_api::ids::ThreadId::from("sess_seated"), header(json!({ "cwd": "/ws", "provider": "openai", "model": "gpt-5" })), json!({})).await.expect("create");
    for (thread, source) in [("sess_reserved", Value::Null), ("sess_seated", json!("sess_seated"))] {
        let got = preflight(&directory, json!({ "threadId": thread })).await;
        assert_eq!(got["sourceSessionId"], source, "{thread}");
    }
}

/// `compact(options)` of the session ops (`session-ops.mjs`): refused with Node's answer while a
/// turn runs; a `skipped` result is the answer as is, before PostCompact; any other runs
/// PostCompact, re-marks the Goal reminder `compaction`, re-arms the late tools, recovers the
/// agent on request and invalidates the context status, then answers the result.
#[tokio::test(start_paused = true)]
async fn a_manual_compaction_follows_the_session_ops_order() {
    let rig = Rig::new();
    let gate = held(&rig);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    let busy = call(&handle, "thread/compact/start", json!({}), "k-1").await.expect("answered");
    assert_eq!(busy, json!({ "changed": false, "reason": "compact skipped: turn in progress" }));
    assert!(super::testing::lock(&rig.compaction.calls).is_empty(), "the engine is not reached");
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;

    *super::testing::lock(&rig.compaction.result) = Some(json!({ "skipped": true, "reason": "no reduction" }));
    let skipped = call(&handle, "thread/compact/start", json!({ "options": { "requireReduction": true } }), "k-2").await.expect("answered");
    assert_eq!(skipped, json!({ "skipped": true, "reason": "no reduction" }));
    assert_eq!(*super::testing::lock(&rig.compaction.calls), ["compact auto_clear true"]);
    assert!(!handle.cell.header.load().contains_key("pendingGoalReminder"), "a skip marks nothing");

    super::testing::lock(&rig.compaction.calls).clear();
    *super::testing::lock(&rig.compaction.result) = Some(json!({ "changed": true }));
    let done = call(&handle, "thread/compact/start", json!({ "options": { "recoverAgent": true } }), "k-3").await.expect("answered");
    assert_eq!(done, json!({ "changed": true }));
    assert_eq!(*super::testing::lock(&rig.compaction.calls), ["compact manual false", "post manual", "rearm", "recover", "invalidate"]);
    let pending = eventually_on!(&[&handle.cell.stepped], || handle.cell.header.load().get("pendingGoalReminder").cloned()).await;
    assert_eq!((pending["reason"].clone(), pending["revision"].clone()), (json!("compaction"), json!(1)));

    // No result at all is Node's `null`.
    *super::testing::lock(&rig.compaction.result) = None;
    assert_eq!(call(&handle, "thread/compact/start", json!({}), "k-4").await.expect("answered"), Value::Null);
}

/// `retryFailedTurn(sessionId, turnKey)` of the quota lane: while `turnKey` is the latest failed
/// turn and nothing runs, settles or waits, the failed prompt is replayed as a retry turn, the
/// resume entry is finished and the answer is `true`; any other key, and a second ask for the
/// same turn, answer `false`.
#[tokio::test(start_paused = true)]
async fn a_failed_turn_is_retried_once_with_its_prompt_and_its_resume_entry_finished() {
    let rig = Rig::new();
    type Seen = Arc<std::sync::Mutex<Vec<(String, Option<bool>)>>>;
    let seen: Seen = Arc::default();
    let log = seen.clone();
    rig.set_script(Arc::new(move |run| {
        let log = log.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let retry = run.input.options.as_ref().and_then(|options| options.retry_failed_turn);
            let first = {
                let mut seen = super::testing::lock(&log);
                seen.push((format!("{:?}", run.input.prompt), retry));
                seen.len() == 1
            };
            if !first {
                return RunOutcome::Completed(Default::default());
            }
            RunOutcome::Failed(super::testing::quota_error(5000))
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_routed_thread(&directory).await;
    turn(&handle, "write the report", "op-1").await;
    let id = handle.id.as_str().to_owned();
    let entry = eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id)).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let key = entry.turn_key.clone();

    assert_eq!(call(&handle, "turn/retryFailed", json!({ "turnKey": "attempt:other" }), "r-1").await.expect("answered"), json!(false));
    assert_eq!(call(&handle, "turn/retryFailed", json!({ "turnKey": "" }), "r-2").await.expect("answered"), json!(false));
    assert_eq!(super::testing::lock(&seen).len(), 1, "a refusal starts no turn");

    retry_when_settled(&handle, &key, "r-3").await;
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&seen).len() == 2).then_some(())).await;
    assert_eq!(super::testing::lock(&seen)[1].1, Some(true), "the retry turn carries retryFailedTurn");
    assert!(super::testing::lock(&seen)[1].0.contains("write the report"), "the failed prompt is replayed");
    eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id).is_none().then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(call(&handle, "turn/retryFailed", json!({ "turnKey": key }), "r-4").await.expect("answered"), json!(false), "the retry's own turn is now the latest");
}

/// A thread whose first turn failed on exhausted quota (its resume queued), the later turns
/// completing; `with_message` also leaves a user message with an id as the turn's last model row,
/// which the failed turn's end is recorded on (`attachFailedTurnCompletion`, as it is on a
/// restored Node session's failed message: `meta.transcript.completion` failed).
async fn quota_failed_thread(rig: &Rig, with_message: bool) -> (Arc<SessionHandle>, String, Arc<std::sync::Mutex<Vec<Option<mixdog_protocol::thread::SubmitOptions>>>>) {
    use super::ItemCommit;
    use mixdog_core_api::ids::ItemId;

    let seen: Arc<std::sync::Mutex<Vec<Option<mixdog_protocol::thread::SubmitOptions>>>> = Arc::default();
    let log = seen.clone();
    rig.set_script(Arc::new(move |run| {
        let log = log.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let first = {
                let mut seen = super::testing::lock(&log);
                seen.push(run.input.options.clone());
                seen.len() == 1
            };
            if !first {
                return RunOutcome::Completed(Default::default());
            }
            if with_message {
                let body = json!({ "role": "user", "content": "go on", "meta": { "transcript": { "messageId": "m1" } } });
                run.port.commit_item(ItemCommit { iid: ItemId::from("m1-row"), role: Some("user".into()), model: true, visible: false, body, prompt: None }).await.expect("commit");
            }
            RunOutcome::Failed(super::testing::quota_error(5000))
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_routed_thread(&directory).await;
    turn(&handle, "write the report", "op-1").await;
    let id = handle.id.as_str().to_owned();
    let entry = eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id)).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    (handle, entry.turn_key, seen)
}

fn user_rows(handle: &SessionHandle) -> usize {
    handle.cell.view.load_full().items.iter().filter(|item| matches!(item.as_ref(), mixdog_protocol::ThreadItem::UserMessage { .. })).count()
}

/// A retry that names the failed message (a restored Node session) resends it as stored: the
/// retry turn carries its id and the attempt the failed turn's completion recorded on it
/// (`attachFailedTurnCompletion` replaces any completion the message held), its input row stays
/// off screen, and the entry ends.
#[tokio::test(start_paused = true)]
async fn a_retained_failed_message_is_resent_hidden_with_its_id_and_attempt() {
    let rig = Rig::new();
    let (handle, key, seen) = quota_failed_thread(&rig, true).await;
    let shown = user_rows(&handle);
    let recorded = rig
        .store
        .records(&handle.id)
        .iter()
        .rev()
        .find_map(|(_, record)| match record {
            mixdog_store::schema::record::Record::Amend(amend) => match &amend.body {
                mixdog_store::schema::blob::Slot::Inline(body) => body.pointer("/meta/transcript/completion/attemptId").and_then(Value::as_str).map(str::to_owned),
                _ => None,
            },
            _ => None,
        })
        .expect("the failed turn's completion is recorded on its last message");
    retry_when_settled(&handle, &key, "r-1a").await;
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&seen).len() == 2).then_some(())).await;
    let options = super::testing::lock(&seen)[1].clone().expect("retry options");
    assert_eq!((options.retry_failed_turn, options.retry_turn_id, options.retry_attempt_id), (Some(true), Some("m1".into()), Some(recorded)));
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(user_rows(&handle), shown, "the resent message paints no second row");
    eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(handle.id.as_str()).is_none().then_some(())).await;
}

/// `retryBlocked`: a compaction running owns the session first (`commandBusy` /
/// `autoClearRunning`); the retry is refused and runs once the compaction ended.
#[tokio::test(start_paused = true)]
async fn a_retry_waits_for_a_running_compaction() {
    let rig = Rig::new();
    let (handle, key, seen) = quota_failed_thread(&rig, false).await;
    let hold = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.compaction.hold) = Some(hold.clone());
    let mut compacting = {
        let handle = handle.clone();
        tokio::spawn(async move { call(&handle, "thread/compact/start", json!({}), "c-1").await })
    };
    eventually_on_until!(&[&rig.compaction.called], || (!super::testing::lock(&rig.compaction.calls).is_empty()).then_some(()), &mut compacting).await;
    assert_eq!(call(&handle, "turn/retryFailed", json!({ "turnKey": key }), "r-1").await.expect("answered"), json!(false));
    hold.notify_one();
    compacting.await.expect("joined").expect("compacted");
    assert_eq!(super::testing::lock(&seen).len(), 1, "the refused retry started nothing");
    retry_when_settled(&handle, &key, "r-2c").await;
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&seen).len() == 2).then_some(())).await;
}

/// A manual compaction runs under the session's abort signal (`getSessionAbortSignal`): the runtime's shutdown aborts it with
/// Node's `runtime close` text, so a compaction in flight does not outlive the session.
#[tokio::test(start_paused = true)]
async fn a_shutdown_aborts_the_compaction_in_flight() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let hold = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.compaction.hold) = Some(hold);
    let mut compacting = {
        let handle = handle.clone();
        tokio::spawn(async move { call(&handle, "thread/compact/start", json!({}), "c-1").await })
    };
    eventually_on_until!(&[&rig.compaction.called], || (!super::testing::lock(&rig.compaction.calls).is_empty()).then_some(()), &mut compacting).await;
    let cancel = super::testing::lock(&rig.compaction.cancels)[0].clone();
    assert!(!cancel.is_aborted(), "a running compaction is not aborted");
    directory.shutdown().await;
    assert!(cancel.is_aborted(), "the shutdown aborted the compaction's signal");
    assert_eq!(cancel.reason(), format!("Session \"{}\" closed: runtime close (reason=cli-exit)", handle.id.as_str()));
}

/// `resumeGoal`: a quota failure that suspended the Goal is retried by reviving that Goal through
/// the lane's admission; the Goal then continues on its own, the queued resume and the note
/// of the suspended Goal end, and a second ask for the same turn is refused.
#[tokio::test(start_paused = true)]
async fn a_suspended_goal_is_revived_by_its_retry_and_continues() {
    let rig = Rig::new();
    let seen: Arc<std::sync::Mutex<usize>> = Arc::default();
    let count = seen.clone();
    rig.set_script(Arc::new(move |run| {
        let count = count.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let first = {
                let mut count = super::testing::lock(&count);
                *count += 1;
                *count == 1
            };
            if !first {
                return RunOutcome::Completed(Default::default());
            }
            RunOutcome::Failed(super::testing::quota_error(5000))
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_routed_thread(&directory).await;
    let id = handle.id.as_str().to_owned();
    rig.goals.goal_control(&handle.id, json!({ "action": "create", "objective": "Ship it" })).await.expect("create");
    let goal_id = rig.goals.goal_status(&handle.id).await.expect("status").expect("a goal")["id"].as_str().expect("goal id").to_owned();
    let key = eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id).map(|entry| entry.turn_key)).await;
    eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || (rig.quota.suspended_goal(&id, &key) == goal_id).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;

    retry_when_settled(&handle, &key, "r-1a").await;
    eventually_on!(&[&handle.cell.stepped], || (*super::testing::lock(&seen) == 2).then_some(())).await;
    let goal = rig.goals.goal_status(&handle.id).await.expect("status").expect("a goal");
    assert_eq!(goal["status"], "active", "the Goal was revived");
    eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || (rig.quota.entry(&id).is_none() && rig.quota.suspended_goal(&id, &key).is_empty()).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(call(&handle, "turn/retryFailed", json!({ "turnKey": key }), "r-2").await.expect("answered"), json!(false));
}
/// `commitSessionCompaction`: a manual compaction's result is applied when no turn runs and the
/// context still starts with what it was planned on; the rows a finished turn appended meanwhile
/// follow the compacted ones; a running turn, or a context that moved, leave the conversation as
/// it is.
#[tokio::test(start_paused = true)]
async fn a_manual_compactions_result_is_committed_only_to_the_context_it_was_planned_on() {
    use super::run::Compaction;
    use super::turn_ops::CompactionCommit;
    use mixdog_core_api::ids::ItemId;

    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "first", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let planned = directory.model_context(&handle.id).read().await.expect("context");
    assert!(!planned.is_empty());
    let snapshot: Vec<ItemId> = planned.iter().map(|(iid, _)| iid.clone()).collect();
    let summary = (ItemId::from("sum1".to_owned()), json!({ "role": "user", "content": "summary" }));
    let compaction = || Compaction { replacement: vec![summary.clone()], at: 5, dropped_count: 1, dropped: None };

    // A context that moved (the planned rows are not its start): nothing is applied.
    let moved = vec![ItemId::from("not-a-row".to_owned())];
    assert_eq!(directory.commit_compaction(&handle.id, moved, compaction(), None).await.expect("answered"), CompactionCommit::Moved);
    assert_eq!(directory.model_context(&handle.id).read().await.expect("context").len(), planned.len());

    // A turn that runs refuses it.
    let gate = held(&rig);
    turn(&handle, "second", "op-2").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    assert_eq!(directory.commit_compaction(&handle.id, snapshot.clone(), compaction(), None).await.expect("answered"), CompactionCommit::Moved);
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;

    // The turn that finished meanwhile appended its rows: they follow the compacted ones.
    assert_eq!(directory.commit_compaction(&handle.id, snapshot, compaction(), None).await.expect("answered"), CompactionCommit::Applied);
    let after = directory.model_context(&handle.id).read().await.expect("context");
    assert_eq!(after.first().map(|(iid, _)| iid.as_str()), Some("sum1"));
    assert!(after.len() >= 2, "the second turn's rows follow the summary: {after:?}");
    assert!(after.iter().skip(1).all(|(iid, _)| iid.as_str() != "sum1"));
}

/// A commit that carries the header writes it with the compaction, in the record that counts it:
/// the caller's `compaction.compactCount` stands (it is not counted twice), and a commit that
/// carries none leaves the count to the pass's telemetry.
#[tokio::test(start_paused = true)]
async fn a_manual_compaction_commit_writes_the_header_it_carries_without_counting_twice() {
    use super::run::Compaction;
    use mixdog_core_api::ids::ItemId;
    use mixdog_store::schema::record::HeaderChange;

    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "first", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let compaction = |id: &str| Compaction { replacement: vec![(ItemId::from(id.to_owned()), json!({ "role": "user", "content": "summary" }))], at: 5, dropped_count: 1, dropped: None };
    let snapshot_of = |rows: Vec<(ItemId, Value)>| rows.into_iter().map(|(iid, _)| iid).collect::<Vec<_>>();

    let snapshot = snapshot_of(directory.model_context(&handle.id).read().await.expect("context"));
    let mut set = serde_json::Map::new();
    set.insert("compaction".into(), json!({ "compactCount": 7, "lastStage": "manual" }));
    set.insert("lastContextTokens".into(), json!(0));
    let carried = HeaderChange { set, unset: Vec::new() };
    // The commit computes the header from the thread's header and the rows appended since the snapshot (none here).
    let header: super::turn_ops::CompactionHeader = Box::new(move |_, appended| {
        assert!(appended.is_empty());
        carried
    });
    let applied = directory.commit_compaction(&handle.id, snapshot, compaction("sum1"), Some(header)).await.expect("answered");
    assert_eq!(applied, super::turn_ops::CompactionCommit::Applied);
    eventually_on!(&[&handle.cell.stepped], || (handle.live_header().header().get("compaction")?.get("compactCount") == Some(&json!(7))).then_some(())).await;
    let header = handle.live_header().header();
    assert_eq!(header["compaction"]["lastStage"], json!("manual"));
    assert_eq!(header["lastContextTokens"], json!(0));

    // Nothing carried: the pre-send pass's own telemetry counts the compaction (`rememberCompactTelemetry`), not the commit.
    let snapshot = snapshot_of(directory.model_context(&handle.id).read().await.expect("context"));
    let applied = directory.commit_compaction(&handle.id, snapshot, compaction("sum2"), None).await.expect("answered");
    assert_eq!(applied, super::turn_ops::CompactionCommit::Applied);
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert_eq!(handle.live_header().header()["compaction"]["compactCount"], json!(7));
}

/// A manual compaction's header is evaluated after the provider continuation is reset and the replacement is in
/// (Node stamps `committedAt` after `session.messages = transcript` and `providerState = undefined`,
/// `compaction-runner.mjs:695-749`; the replacement precedes the header, `session-log-writer.mjs:1146-1159`), and the commit
/// answers only once that header is durable. Observed through events: the header the closure is handed has no `providerState`,
/// the log holds reset, replacement, header in that order, and the commit stays unanswered while the header's batch is held.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_manual_compactions_header_follows_the_reset_and_the_replacement_and_is_durable_before_the_answer() {
    use super::run::Compaction;
    use mixdog_core_api::ids::ItemId;
    use mixdog_core_api::ids::ThreadId;
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::record::HeaderChange;
    use mixdog_store::schema::record::Record;

    let rig = Rig::new();
    let id = ThreadId::from("sess_order");
    let creator = SessionDirectory::new(rig.deps());
    creator.create_with_id(id.clone(), json!({ "cwd": "/ws" }).as_object().cloned().expect("object"), json!({})).await.expect("create");
    let seeded = rig.store.records(&id).len();
    rig.store.seed(&id, vec![serde_json::from_value(json!({ "k": "meta", "change": { "inline": { "set": { "providerState": { "id": "resp_1" } }, "unset": [] } } })).expect("meta record")]);
    let directory = SessionDirectory::new(rig.deps());
    directory.open_handle(&id, &CallContext::internal("test")).await.expect("open");

    let seen: Arc<std::sync::Mutex<Vec<bool>>> = Arc::default();
    let log = seen.clone();
    let mut set = serde_json::Map::new();
    set.insert("compaction".into(), json!({ "compactCount": 1, "lastStage": "manual" }));
    let header: super::turn_ops::CompactionHeader = Box::new(move |current, _| {
        log.lock().expect("log").push(current.contains_key("providerState"));
        HeaderChange { set, unset: Vec::new() }
    });
    let (release, go) = std::sync::mpsc::channel();
    let arrived = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.store.header_gate) = Some((arrived.clone(), go));

    let compaction = Compaction { replacement: vec![(ItemId::from("sum1".to_owned()), json!({ "role": "user", "content": "summary" }))], at: 5, dropped_count: 0, dropped: None };
    let mut commit = Box::pin(directory.commit_compaction(&id, Vec::new(), compaction, Some(header)));
    tokio::select! {
        () = arrived.notified() => {}
        answered = &mut commit => panic!("answered before the header was durable: {answered:?}"),
    }
    // The header's batch is at the gate (`header_gate`'s arrival signal): one poll, no clock, and the commit is still pending.
    assert!(futures::poll!(&mut commit).is_pending(), "the commit answered while the header was held");
    release.send(()).expect("release");
    assert_eq!(commit.await.expect("answered"), super::turn_ops::CompactionCommit::Applied);

    assert_eq!(*seen.lock().expect("log"), vec![false], "the header is evaluated once, after the provider reset");
    let order: Vec<&str> = rig
        .store
        .records(&id)
        .into_iter()
        .skip(seeded + 1)
        .filter_map(|(_, record)| match record {
            Record::Meta(meta) => match meta.change {
                Slot::Inline(change) if change.unset.iter().any(|key| key == "providerState") => Some("reset"),
                Slot::Inline(change) if change.set.contains_key("compaction") => Some("header"),
                _ => None,
            },
            Record::Compacted(_) => Some("replacement"),
            _ => None,
        })
        .collect();
    assert_eq!(order, vec!["reset", "replacement", "header"]);
    let context = directory.model_context(&id).read().await.expect("context");
    assert_eq!(context.iter().map(|(iid, _)| iid.as_str()).collect::<Vec<_>>(), vec!["sum1"]);
}

/// `failedTurnProvenance` (`ask-session.mjs:198-201`): a retry of a system-caused turn (a restored
/// message with `meta.source` and the failed completion) is noted to the warmer as system, and its
/// row carries that provenance as `meta.provenance` (`turnPromptSourceFor`, `ask-turn-execute.mjs:27-34`)
/// so the retry of the retry is system too. The completions come from the actor's own write when a turn
/// fails (`attachFailedTurnCompletion`), none is seeded.
#[tokio::test(start_paused = true)]
async fn a_retry_of_a_system_turn_and_the_retry_of_that_retry_are_noted_as_system() {
    use super::ItemCommit;
    use mixdog_ai::warmer::plan::TurnKind;
    use mixdog_ai::warmer::plan::turn_kind;
    use mixdog_core_api::ids::ItemId;

    let rig = Rig::new();
    let stamped: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
    let log = stamped.clone();
    rig.set_script(Arc::new(move |run| {
        let log = log.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let n = {
                let mut seen = super::testing::lock(&log);
                seen.push(run.input_body.pointer("/meta/provenance").cloned().unwrap_or(Value::Null));
                seen.len()
            };
            if n >= 3 {
                return RunOutcome::Completed(Default::default());
            }
            // The first failed turn is a restored system-caused message; its completion, and the
            // retry row's, are written by the actor when the turn fails (`attachFailedTurnCompletion`).
            if n == 1 {
                let body = json!({ "role": "user", "content": "go on", "meta": { "source": "task-notification", "transcript": { "messageId": "m1" } } });
                run.port.commit_item(ItemCommit { iid: ItemId::from("m1-row"), role: Some("user".into()), model: true, visible: false, body, prompt: None }).await.expect("commit");
            }
            RunOutcome::Failed(super::testing::quota_error(5000))
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_routed_thread(&directory).await;
    turn(&handle, "write the report", "op-1").await;
    let id = handle.id.as_str().to_owned();
    let first = eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id)).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;

    retry_when_settled(&handle, &first.turn_key, "r-1s").await;
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&stamped).len() == 2).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let second = eventually_on!(&[&rig.quota_changed, &handle.cell.stepped], || rig.quota.entry(&id).filter(|entry| entry.turn_key != first.turn_key)).await;
    retry_when_settled(&handle, &second.turn_key, "r-2s").await;
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&stamped).len() == 3).then_some(())).await;

    let provenance = json!({ "source": "task-notification" });
    assert_eq!(*super::testing::lock(&stamped), [Value::Null, provenance.clone(), provenance], "each retry row carries the failed turn's provenance");
    let begun = super::testing::lock(&rig.warms.begun).clone();
    let kinds: Vec<TurnKind> = begun.iter().map(|(_, input, messages)| turn_kind(input, messages.as_ref())).collect();
    assert_eq!(kinds, [TurnKind::Return, TurnKind::System, TurnKind::System], "the prompt is a return, both retries are system");

    // A retained retry keeps the failed message's id (`messageId: previousTranscript.messageId`) and carries every failure
    // it replaced, the earliest first (`previousCompletions`, `ask-turn-execute.mjs:38-61`): without the id the retry of
    // the retry finds no retained message and is not resumable.
    let rows: Vec<Value> = directory.model_context(&handle.id).read().await.expect("context").into_iter().map(|(_, message)| message).collect();
    let last = rows.last().expect("the last retry's row").pointer("/meta/transcript").cloned().expect("its transcript");
    assert_eq!(last["messageId"], "m1");
    let previous = last["previousCompletions"].as_array().expect("the failures it replaced");
    assert_eq!(previous.iter().map(|completion| completion["status"].clone()).collect::<Vec<_>>(), [json!("failed"), json!("failed")]);
}

/// A failed turn gets `meta.transcript.completion` on its last message (`attachFailedTurnCompletion`,
/// `ask-turn-settle.mjs:85-96`) and a plain `turn/start` carrying the retry flags stamps the row with the
/// failed turn's provenance like the lane's retry does (`ask-session.mjs:199`).
#[tokio::test(start_paused = true)]
async fn a_failed_turn_records_its_completion_and_a_plain_retry_start_carries_the_provenance() {
    use super::ItemCommit;
    use mixdog_core_api::ids::ItemId;

    let rig = Rig::new();
    let stamped: Arc<std::sync::Mutex<Vec<Value>>> = Arc::default();
    let log = stamped.clone();
    rig.set_script(Arc::new(move |run| {
        let log = log.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let n = {
                let mut seen = super::testing::lock(&log);
                seen.push(run.input_body.pointer("/meta/provenance").cloned().unwrap_or(Value::Null));
                seen.len()
            };
            if n > 1 {
                return RunOutcome::Completed(Default::default());
            }
            let body = json!({ "role": "user", "content": "go on", "meta": { "source": "task-notification", "transcript": { "messageId": "m1" } } });
            run.port.commit_item(ItemCommit { iid: ItemId::from("m1-row"), role: Some("user".into()), model: true, visible: false, body, prompt: None }).await.expect("commit");
            RunOutcome::Failed(super::testing::quota_error(5000))
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "write the report", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&stamped).len() == 1).then_some(())).await;

    let context = directory.model_context(&handle.id);
    let messages = rows_with_completion(&rig, &context).await;
    let completion = messages.last().expect("rows").pointer("/meta/transcript/completion").cloned().expect("completion");
    // The record is built from the run's failure: Node's `turnFailureRecord` of an exhausted quota with the reset the
    // provider named (`fixtures/turn-failure`, "quota with a provider-named reset").
    assert_eq!(completion["status"], "failed");
    assert_eq!(completion["detail"], "Provider usage limit reached.");
    assert_eq!(completion["errorKind"], json!({ "kind": "quota_exhausted", "code": "usage_limit_reached", "status": 429, "retryAfterMs": null, "resetAt": 5000 }));
    assert_eq!(completion["quota"]["resetAt"], 5000);

    call(&handle, "turn/start", json!({ "input": { "prompt": "go on", "options": { "retryFailedTurn": true, "retryTurnId": "m1" } } }), "op-retry").await.expect("started");
    eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&stamped).len() == 2).then_some(())).await;
    assert_eq!(super::testing::lock(&stamped)[1], json!({ "source": "task-notification" }), "the plain retry's row carries the failed turn's provenance");
}

/// A turn that fails with no end item of its own (a workspace admission refusal, a provider error the run
/// never showed) still records its end on its last message, built from the failure
/// (`failedTurnCompletion`, `ask-turn-failure.mjs:26-45`; the text fields are Node's own,
/// `fixtures/failed-completion`), and the history shows that end once: the row's completion is the only
/// source, as in Node's restore (`transcript_rows::metadata`).
#[tokio::test(start_paused = true)]
async fn a_failure_without_an_end_item_records_its_end_and_the_history_shows_it_once() {
    let gold: Value = serde_json::from_str(include_str!("../../../../fixtures/failed-completion/golden.json")).unwrap();
    let want = &gold["cases"][0];
    assert_eq!(want["message"], "boom");
    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            RunOutcome::Failed(mixdog_protocol::TurnError { message: "boom".into(), data: json!({}), provider_error: None })
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "write the report", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;

    let context = directory.model_context(&handle.id);
    let messages = rows_with_completion(&rig, &context).await;
    let mut completion = messages.last().expect("rows").pointer("/meta/transcript/completion").cloned().expect("completion");
    assert!(completion["attemptId"].as_str().is_some_and(|id| !id.is_empty()), "a fresh attempt id");
    completion.as_object_mut().expect("object").shift_remove("attemptId");
    assert_eq!(
        completion,
        json!({ "status": "failed", "at": 1000, "verb": "Mapped", "elapsedMs": 0, "detail": want["detail"], "errorDetails": want["errorDetails"], "errorKind": want["errorKind"] })
    );

    // The history is read through the stored-record transcript, the one that restores a row from its stored message
    // (the rig's text transcript shows every row as a message and restores no end), over the same store.
    let mut restoring = rig.deps_parts(rig.store.clone());
    restoring.transcript = Arc::new(super::testing::RecordTranscript::new());
    let ends: Vec<_> = SessionDirectory::new(Arc::new(restoring))
        .history_items(&handle.id)
        .await
        .expect("history")
        .into_iter()
        .filter_map(|item| match item {
            mixdog_protocol::ThreadItem::TurnEnd { status, detail, .. } => Some((status, detail)),
            _ => None,
        })
        .collect();
    assert_eq!(ends, [(mixdog_protocol::TurnEndStatus::Failed, Some("boom".to_owned()))], "one turn end, from the row's completion");
}

/// The failed `TurnEnd` of the newest `item/completed` frame of `thread` that carries one, as the feed sent it.
fn failed_end_frame(rig: &Rig, thread: &str) -> Option<mixdog_protocol::ThreadItem> {
    rig.feeds.frames(thread).into_iter().rev().find_map(|(_, method, params)| {
        (method == "item/completed" && params["item"]["type"] == "turnEnd").then(|| serde_json::from_value(params["item"].clone()).expect("a thread item"))
    })
}

/// A turn that fails on exhausted quota, as the run host reports a provider's refusal, shows the failed turn end
/// Node's turn close shows (`turnDoneItem`, `publishTurnClose`; `fixtures/turn-failure` `live.quota`): the last
/// row of the turn, with the reason, error kind and quota stop of `turnFailureRecord`, once. The quota settlement
/// reads that row, so the resume is queued at the reset the provider named, and the turn's Goal settles after it.
#[tokio::test(start_paused = true)]
async fn a_quota_failed_turn_shows_nodes_end_and_the_settlement_reads_it() {
    let gold: Value = serde_json::from_str(include_str!("../../../../fixtures/turn-failure/golden.json")).unwrap();
    let live = &gold["live"]["quota"];
    assert_eq!(live["kinds"], json!(["user", "turndone"]), "Node shows no failure row besides the end");
    assert_eq!(live["toasts"][0]["options"], json!({ "owner": "transcript" }), "the failure notice is a toast the end replaces");
    let reset = gold["resetAt"].as_u64().expect("the recorded reset");
    let rig = Rig::new();
    rig.set_script(Arc::new(move |run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            RunOutcome::Failed(super::testing::quota_error(reset))
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_routed_thread(&directory).await;
    // The queued resume is written on the quota store's own lane, after the last frame: the store tells when.
    let queued = Arc::new(tokio::sync::Notify::new());
    let _subscription = {
        let queued = queued.clone();
        rig.quota.subscribe(move |_| queued.notify_one())
    };
    turn(&handle, "write the report", "op-1").await;
    let id = handle.id.as_str().to_owned();
    let entry = eventually_on!(&[&queued], || rig.quota.entry(&id)).await;
    assert_eq!(entry.to_value()["resetAt"].as_f64(), Some(reset as f64), "the resume waits for the reset the provider named");

    let items = eventually_on!(&[&rig.feeds.published, &handle.cell.stepped], || {
        let items = handle.cell.view.load_full().items.clone();
        items.iter().any(|item| matches!(item.as_ref(), mixdog_protocol::ThreadItem::TurnEnd { .. })).then_some(items)
    })
    .await;
    let kinds: Vec<&str> = items
        .iter()
        .map(|item| match item.as_ref() {
            mixdog_protocol::ThreadItem::UserMessage { .. } => "user",
            mixdog_protocol::ThreadItem::TurnEnd { .. } => "turndone",
            _ => "other",
        })
        .collect();
    assert_eq!(kinds, ["user", "turndone"], "the end is the turn's last row, and the only one");
    let Some(mixdog_protocol::ThreadItem::TurnEnd { status, detail, error_details, error_kind, quota, meta, .. }) = items.last().map(|item| item.as_ref().clone()) else {
        panic!("the last row is the turn end");
    };
    let want = &live["turndone"];
    assert_eq!(status, mixdog_protocol::TurnEndStatus::Failed);
    assert_eq!((detail.as_deref(), error_details.as_deref()), (want["detail"].as_str(), want["errorDetails"].as_str()));
    assert_eq!(serde_json::to_value(error_kind).unwrap(), want["errorKind"]);
    assert_eq!(serde_json::to_value(quota).unwrap()["resetAt"], want["quota"]["resetAt"]);
    for key in ["outputTokens", "thinkingElapsedMs", "toolCount"] {
        assert_eq!(meta.ext.get(key), Some(&want[key]), "{key}");
    }
    assert!(meta.ext.get("attemptId").is_some_and(|attempt| attempt.as_str().is_some_and(|attempt| !attempt.is_empty())), "the turn's identity, as the turn keys read it");
}

/// Plays a recorded live script (`fixtures/turn-failure` `live.<name>.script`, offsets in ms from the turn's start)
/// through the run's port on the rig's clock; each step is applied before the clock moves on.
async fn play(run: &super::RunStart, clock: &super::testing::FixedClock, script: &[Value]) {
    use mixdog_core_api::ids::ItemId;
    use std::sync::atomic::Ordering;

    let start = clock.0.load(Ordering::SeqCst);
    for (n, step) in script.iter().enumerate() {
        clock.0.store(start + step["at"].as_u64().expect("an offset"), Ordering::SeqCst);
        let port = &run.port;
        if let Some(text) = step["reasoning"].as_str() {
            port.reasoning_delta(ItemId::from("think"), text.to_owned()).await.expect("reasoning");
        }
        if let Some(text) = step["text"].as_str() {
            port.delta(ItemId::from("reply"), text.to_owned()).await.expect("text");
        }
        if let Some(tokens) = step["usage"].as_u64() {
            let usage = mixdog_core_api::domain::provider::Usage { output_tokens: tokens, ..Default::default() };
            let report = super::run::UsageReport {
                iteration: 1,
                usage,
                model: "m".into(),
                requested_model: "m".into(),
                delta_tool_calls: 0,
                request_ms: 0,
                delta_prompt: 0,
                send_tools: Vec::new(),
                reasoning_tokens: None,
                reasoning_tokens_complete: false,
                outgoing: Vec::new(),
                sent_at_ms: 0,
            };
            port.usage(report).await.expect("usage");
        }
        if let Some(calls) = step.get("tools") {
            // The batch is on the assistant row the run commits for it, which is where the actor sees its calls.
            let body = json!({ "role": "assistant", "content": "", "toolCalls": calls });
            let row = super::ItemCommit { iid: ItemId::from(format!("calls-{n}")), role: Some("assistant".into()), model: true, visible: false, body, prompt: None };
            port.commit_item(row).await.expect("tool calls");
        }
        // The port's messages are taken in order: once this commit is acked, the step above has been applied.
        let barrier = super::ItemCommit { iid: ItemId::from(format!("barrier-{n}")), role: Some("assistant".into()), model: false, visible: false, body: json!({ "text": "" }), prompt: None };
        port.commit_item(barrier).await.expect("barrier");
    }
}

/// The live end is built from what the run showed while it ran (`turnDoneItem`, `turn.mjs:573-601`): the spinner's
/// tokens or the estimate of the text and thinking, the thinking time, the cards, the elapsed time from the turn's start,
/// and the time it closed. The scripts are the ones Node's real stream handlers and tool cards were driven with
/// (`fixtures/turn-failure` `live.streamed`, `live.estimated` and `live.tools`: merged reads, a task wait, control tools, built-in
/// and user skill loads, a call with no id), and the item must equal what Node's turndone held.
#[tokio::test(start_paused = true)]
async fn the_live_failed_end_holds_what_the_run_showed_as_nodes_turndone_does() {
    let gold: Value = serde_json::from_str(include_str!("../../../../fixtures/turn-failure/golden.json")).unwrap();
    let reset = gold["resetAt"].as_u64().expect("the recorded reset");
    for name in ["streamed", "estimated", "tools", "routed"] {
        let live = gold["live"][name].clone();
        let script = live["script"].as_array().expect("a recorded script").clone();
        let rig = Rig::new();
        // The skills Node's status listed as built in (`skillsStatus`, `source === 'builtin'`), as the turn reads them.
        let builtin = live["skills"].as_array().expect("the recorded skills").iter().filter(|skill| skill["source"] == "builtin").map(|skill| skill["name"].as_str().expect("a name").to_lowercase());
        *super::testing::lock(&rig.builtin_skills.0) = Some(builtin.collect());
        let clock = rig.clock.clone();
        let quota = live["turndone"]["quota"].is_object();
        let plays = script.clone();
        rig.set_script(Arc::new(move |run| {
            let (clock, plays) = (clock.clone(), plays.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                play(&run, &clock, &plays).await;
                if quota {
                    RunOutcome::Failed(super::testing::quota_error(reset))
                } else {
                    RunOutcome::Failed(mixdog_protocol::TurnError { message: "boom".into(), data: json!({}), provider_error: None })
                }
            })
        }));
        let directory = SessionDirectory::new(rig.deps());
        let handle = start_thread(&directory).await;
        // The session's route, which Node's turn start stamps into the row (`createTranscriptRouteMetadata`).
        if let Some(route) = live.get("route") {
            let params = json!({ "threadId": handle.id, "set": { "provider": route["provider"], "model": route["model"] }, "unset": [] });
            handle.request(CoreRequest { method: Method("thread/header/patch"), params, op: None, ctx: CallContext::internal("test") }).await.expect("route");
        }
        let start = rig.clock.0.load(std::sync::atomic::Ordering::SeqCst);
        turn(&handle, "write the report", "op-1").await;
        let thread = handle.id.as_str().to_owned();
        let end = eventually_on!(&[&rig.feeds.published], || failed_end_frame(&rig, &thread)).await;
        let mixdog_protocol::ThreadItem::TurnEnd { status, elapsed_ms, detail, error_details, error_kind, quota, meta, .. } = end else {
            panic!("a turn end");
        };
        let want = &live["turndone"];
        assert_eq!(status, mixdog_protocol::TurnEndStatus::Failed, "{name}");
        assert_eq!(json!(elapsed_ms), want["elapsedMs"], "{name}: the elapsed time from the turn's start");
        assert_eq!(meta.at, Some((start + want["at"].as_u64().unwrap() - gold["live"][name]["start"].as_u64().unwrap()) as i64), "{name}: the close time");
        for key in ["outputTokens", "thinkingElapsedMs", "toolCount"] {
            assert_eq!(meta.ext.get(key), Some(&want[key]), "{name}: {key}");
        }
        assert_eq!((detail.as_deref(), error_details.as_deref()), (want["detail"].as_str(), want["errorDetails"].as_str()), "{name}");
        assert_eq!(serde_json::to_value(error_kind).unwrap(), want["errorKind"], "{name}");
        // The row spreads the turn-start route (`routeMeta`), and the quota stop names it.
        assert_eq!((meta.model_id.as_deref(), meta.model.as_deref(), meta.provider.as_deref()), (want["modelId"].as_str(), want["model"].as_str(), want["provider"].as_str()), "{name}: the route");
        let stop = json!(quota);
        assert_eq!((stop["provider"].clone(), stop["model"].clone()), (want["quota"]["provider"].clone(), want["quota"]["model"].clone()), "{name}: the quota stop's route");
    }
}

/// A codec that refuses to encode an amend, as a store that cannot take the completion would.
struct RefusesAmends;

impl super::seams::RecordCodec for RefusesAmends {
    fn encode(&self, lane: &mixdog_rt::InLane<mixdog_rt::CpuInteractive>, record: &mixdog_store::schema::record::Record) -> Result<super::seams::EncodedRecord, CoreError> {
        match record {
            mixdog_store::schema::record::Record::Amend(_) => Err(CoreError::Internal { incident_id: "amend-refused".into() }),
            _ => super::store::StoreCodec.encode(lane, record),
        }
    }
}

/// The settlements stand on the completion's amend (`attachFailedTurnCompletion` before `beginQuotaSettlement`,
/// `ask-turn-settle.mjs:94`, `turn.mjs:644`). When the amend cannot be recorded the end is not shown, the quota is not
/// settled (no resume is queued), and the Goal still settles: the next turn runs.
#[tokio::test(start_paused = true)]
async fn a_failed_turn_whose_completion_cannot_be_recorded_settles_no_quota_and_shows_no_end() {
    let rig = Rig::new();
    let turns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = turns.clone();
    rig.set_script(Arc::new(move |run| {
        let counted = counted.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            if counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                RunOutcome::Failed(super::testing::quota_error(5000))
            } else {
                RunOutcome::Completed(Default::default())
            }
        })
    }));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.codec = Arc::new(RefusesAmends);
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    turn(&handle, "write the report", "op-1").await;
    // The next turn starts only once the failed one has settled its Goal: it is the signal that the settlement ended.
    turn(&handle, "again", "op-2").await;
    let thread = handle.id.as_str().to_owned();
    let completed = || rig.feeds.frames(&thread).iter().filter(|(_, method, _)| method == "turn/completed").count();
    eventually_on!(&[&rig.feeds.published], || (completed() == 2).then_some(())).await;
    assert_eq!(turns.load(std::sync::atomic::Ordering::SeqCst), 2, "the settled turn let the next one run");
    assert!(failed_end_frame(&rig, &thread).is_none(), "no end is shown for a turn whose completion was not recorded");
    assert!(rig.quota.entry(&thread).is_none(), "no resume is queued for it");
    let ends = handle.cell.view.load_full().items.iter().filter(|item| matches!(item.as_ref(), mixdog_protocol::ThreadItem::TurnEnd { .. })).count();
    assert_eq!(ends, 0);
}

/// The notices a session's own events raise (`failTurn` / `completeTurn`, `_recordSaveFailure`):
/// a turn that fails on a provider's auth refusal, one that completes, a cancelled one, and a
/// save whose barrier failed are each reported once to the composition.
#[tokio::test(start_paused = true)]
async fn turn_ends_and_failed_saves_are_reported_to_the_notices() {
    use mixdog_protocol::{ProviderErrorDetail, TurnError};

    let rig = Rig::new();
    let outcomes: Arc<std::sync::Mutex<Vec<RunOutcome>>> = Arc::new(std::sync::Mutex::new(vec![
        RunOutcome::Failed(TurnError {
            message: "401".into(),
            data: json!({}),
            provider_error: Some(ProviderErrorDetail { provider: "anthropic".into(), status: Some(401), kind: "auth".into(), delivery: None }),
        }),
        RunOutcome::Failed(TurnError { message: "disk".into(), data: json!({}), provider_error: None }),
        RunOutcome::Interrupted,
        RunOutcome::Completed(Default::default()),
    ]));
    let script = outcomes.clone();
    rig.set_script(Arc::new(move |run| {
        let script = script.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            super::testing::lock(&script).remove(0)
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    for (n, expected) in [(1, "failed::auth"), (2, "failed::-"), (3, ""), (4, "completed:")] {
        turn(&handle, "go", &format!("op-{n}")).await;
        eventually_on!(&[&handle.cell.stepped], || (super::testing::lock(&outcomes).len() == 4 - n).then_some(())).await;
        eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
        if !expected.is_empty() {
            eventually_on!(&[&rig.notices.1, &handle.cell.stepped], || (super::testing::lock(&rig.notices.0).last().map(String::as_str) == Some(expected)).then_some(())).await;
        }
    }
    assert_eq!(super::testing::lock(&rig.notices.0).clone(), vec!["failed::auth", "failed::-", "completed:"], "a cancelled turn reports nothing");
    rig.store.fail_next.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = handle
        .request(request("thread/name/set", json!({ "threadId": handle.id, "opId": "op-save", "title": "renamed" }), "op-save"))
        .await
        .expect_err("barrier failed");
    eventually_on!(&[&rig.notices.1, &handle.cell.stepped], || (super::testing::lock(&rig.notices.0).last().map(String::as_str) == Some("save-failed")).then_some(())).await;
}

/// A route change while a turn runs does not move the notice its end raises: the provider is the
/// one of the route the turn started with (`routeMeta.provider`), not the header's at the end.
/// Node sets `routeMeta` once, when the turn is prepared (`onRouteApplied`, turn-prepare.mjs:159,
/// after the pending route and profile applied); a fallback hop (`updateSessionRoute`,
/// route-fallback.mjs:131) does not touch it. The route here changes the way a hop writes the
/// header (the new provider with the `routeFallback*` fields) and the notice stays with the start.
#[tokio::test(start_paused = true)]
async fn a_route_change_during_a_turn_does_not_move_its_notice() {
    use mixdog_protocol::{ProviderErrorDetail, TurnError};

    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let open = gate.clone();
    rig.set_script(Arc::new(move |run| {
        let open = open.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            open.notified().await;
            RunOutcome::Failed(TurnError {
                message: "401".into(),
                data: json!({}),
                provider_error: Some(ProviderErrorDetail { provider: "ignored".into(), status: Some(401), kind: "auth".into(), delivery: None }),
            })
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let route = |set: Value| {
        let handle = handle.clone();
        let params = json!({ "threadId": handle.id, "set": set, "unset": [] });
        async move {
            handle
                .request(CoreRequest { method: Method("thread/header/patch"), params, op: None, ctx: CallContext::internal("test") })
                .await
                .expect("patch");
        }
    };
    route(json!({ "provider": "anthropic-oauth" })).await;
    turn(&handle, "go", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    route(json!({ "provider": "openai", "routeFallbackIndex": 1, "routeFallbackFailures": [{ "provider": "anthropic-oauth", "kind": "auth" }] })).await;
    assert_eq!(handle.live_header().header().get("provider"), Some(&json!("openai")), "the route changed under the running turn");
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    eventually_on!(&[&rig.notices.1, &handle.cell.stepped], || (!super::testing::lock(&rig.notices.0).is_empty()).then_some(())).await;
    assert_eq!(super::testing::lock(&rig.notices.0).clone(), vec!["failed:anthropic-oauth:auth"]);
}

/// A route change while a turn runs moves the durable failure record and not the live end: the live end's quota stop
/// names the route the turn started with (`turn.routeMeta`, `turn.mjs:555`; the model by its display name), while the
/// completion recorded on the last message names the session's route at the close (`session.provider`,
/// `failedTurnCompletion`, `ask-turn-failure.mjs:28`).
#[tokio::test(start_paused = true)]
async fn a_route_change_during_a_quota_failed_turn_moves_the_durable_stop_and_not_the_live_end() {
    use mixdog_core_run::run_host::model_display::display_model_name;

    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let open = gate.clone();
    rig.set_script(Arc::new(move |run| {
        let open = open.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            open.notified().await;
            RunOutcome::Failed(super::testing::quota_error(5000))
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let route = |set: Value| {
        let handle = handle.clone();
        let params = json!({ "threadId": handle.id, "set": set, "unset": [] });
        async move {
            handle
                .request(CoreRequest { method: Method("thread/header/patch"), params, op: None, ctx: CallContext::internal("test") })
                .await
                .expect("patch");
        }
    };
    route(json!({ "provider": "anthropic-oauth", "model": "claude-opus-4-1" })).await;
    turn(&handle, "go", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (!idle(&handle)).then_some(())).await;
    route(json!({ "provider": "openai", "model": "gpt-5" })).await;
    gate.notify_one();
    let thread = handle.id.as_str().to_owned();
    let end = eventually_on!(&[&rig.feeds.published], || failed_end_frame(&rig, &thread)).await;
    let mixdog_protocol::ThreadItem::TurnEnd { quota: Some(live), .. } = end else { panic!("a failed end with a quota stop") };
    assert_eq!(live.get("provider"), Some(&json!("anthropic-oauth")), "the live end keeps the route the turn started with");
    assert_eq!(live.get("model"), Some(&json!(display_model_name("claude-opus-4-1", ""))));
    let durable = eventually_on!(&[&handle.cell.stepped], || {
        rig.store.records(&handle.id).iter().rev().find_map(|(_, record)| match record {
            mixdog_store::schema::record::Record::Amend(amend) => match &amend.body {
                mixdog_store::schema::blob::Slot::Inline(body) => body.pointer("/meta/transcript/completion/quota").cloned(),
                _ => None,
            },
            _ => None,
        })
    })
    .await;
    assert_eq!((durable["provider"].clone(), durable["model"].clone()), (json!("openai"), json!("gpt-5")), "the completion names the session's route at the close");
}
