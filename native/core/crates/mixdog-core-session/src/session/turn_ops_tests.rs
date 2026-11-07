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
use super::tests::eventually;
use super::tests::idle;
use super::tests::start_thread;
use super::tests::turn;

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
async fn retry_when_settled(handle: &SessionHandle, key: &str, tag: &str) {
    for attempt in 0u32.. {
        let op: &'static str = Box::leak(format!("{tag}-{attempt}").into_boxed_str());
        if call(handle, "turn/retryFailed", json!({ "turnKey": key }), op).await.expect("answered") == json!(true) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    unreachable!("the attempts are unbounded");
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
    let shown = eventually(|| shown_of(json!(id))).await;
    assert_eq!(shown["turnId"], "");
    // A notice is a status row of kind `notice`; its polished text and tone ride in the row's ext.
    assert_eq!((shown["item"]["type"].clone(), shown["item"]["kind"].clone()), (json!("statusRow"), json!("notice")));
    let row = shown["item"].to_string();
    assert!(row.contains("\"saved the file\"") && row.contains("\"warn\""), "{row}");

    // The tone defaults to `info`; a text that polishes to nothing shows no row.
    let second = call(&handle, "thread/pushNotice", json!({ "text": "plain" }), "n-2").await.expect("pushed");
    let last = eventually(|| shown_of(second.clone())).await;
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
    eventually(|| (!idle(&handle)).then_some(())).await;

    let refused = call(&handle, "thread/clearSessionChangeHistory", json!({}), "c-1").await.expect_err("a turn runs");
    let CoreError::DomainError { message, .. } = refused else { panic!("a plain error") };
    assert_eq!(message.as_deref(), Some("Change history cannot be deleted while this session is running a turn"));

    gate.notify_one();
    eventually(|| idle(&handle).then_some(())).await;
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

    let first = {
        let (handle, q) = (handle.clone(), json!({ "question": "one" }));
        tokio::spawn(async move { call(&handle, "thread/askSide", q, "s-1").await })
    };
    eventually(|| begun(1).then_some(())).await;
    assert_eq!(call(&handle, "thread/cancelSide", json!({}), "s-2").await.expect("canceled"), Value::Null);
    assert_eq!(plain_error(first.await.expect("joined").expect_err("canceled")), "Side question canceled.");

    let second = {
        let (handle, q) = (handle.clone(), json!({ "question": "two" }));
        tokio::spawn(async move { call(&handle, "thread/askSide", q, "s-3").await })
    };
    eventually(|| (begun(2) && super::testing::lock(&rig.side.prompts).len() == 2).then_some(())).await;
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
    eventually(|| idle(&source).then_some(())).await;
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
    eventually(|| (!idle(&handle)).then_some(())).await;
    let busy = call(&handle, "thread/compact/start", json!({}), "k-1").await.expect("answered");
    assert_eq!(busy, json!({ "changed": false, "reason": "compact skipped: turn in progress" }));
    assert!(super::testing::lock(&rig.compaction.calls).is_empty(), "the engine is not reached");
    gate.notify_one();
    eventually(|| idle(&handle).then_some(())).await;

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
    let pending = eventually(|| handle.cell.header.load().get("pendingGoalReminder").cloned()).await;
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
    use super::ItemCommit;
    use mixdog_core_api::ids::ItemId;

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
            let end = json!({
                "type": "turnEnd", "id": format!("end-{}", run.turn), "status": "failed", "elapsedMs": 5,
                "quota": { "provider": "anthropic", "model": "m", "resetAt": 5000 },
                "meta": { "turnId": run.turn, "ext": { "attemptId": run.turn } },
            });
            run.port
                .commit_item(ItemCommit {
                    iid: ItemId::from(format!("end-{}", run.turn)),
                    role: Some("assistant".into()),
                    model: false,
                    visible: true,
                    body: json!({ "shownItem": end }),
                    prompt: None,
                })
                .await
                .expect("commit");
            let provider = mixdog_protocol::ProviderErrorDetail { provider: "anthropic".into(), status: Some(429), kind: "quota_exhausted".into(), delivery: None };
            RunOutcome::Failed(mixdog_protocol::TurnError { message: "quota".into(), data: json!({}), provider_error: Some(provider) })
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "write the report", "op-1").await;
    let id = handle.id.as_str().to_owned();
    let entry = eventually(|| rig.quota.entry(&id)).await;
    eventually(|| idle(&handle).then_some(())).await;
    let key = entry.turn_key.clone();

    assert_eq!(call(&handle, "turn/retryFailed", json!({ "turnKey": "attempt:other" }), "r-1").await.expect("answered"), json!(false));
    assert_eq!(call(&handle, "turn/retryFailed", json!({ "turnKey": "" }), "r-2").await.expect("answered"), json!(false));
    assert_eq!(super::testing::lock(&seen).len(), 1, "a refusal starts no turn");

    retry_when_settled(&handle, &key, "r-3").await;
    eventually(|| (super::testing::lock(&seen).len() == 2).then_some(())).await;
    assert_eq!(super::testing::lock(&seen)[1].1, Some(true), "the retry turn carries retryFailedTurn");
    assert!(super::testing::lock(&seen)[1].0.contains("write the report"), "the failed prompt is replayed");
    eventually(|| rig.quota.entry(&id).is_none().then_some(())).await;
    eventually(|| idle(&handle).then_some(())).await;
    assert_eq!(call(&handle, "turn/retryFailed", json!({ "turnKey": key }), "r-4").await.expect("answered"), json!(false), "the retry's own turn is now the latest");
}

/// A thread whose first turn failed on exhausted quota (its resume queued), the later turns
/// completing; `with_message` also leaves the failed user message in the model context as a
/// restored Node session does (`meta.transcript.completion` failed).
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
                let body = json!({ "role": "user", "content": "go on", "meta": { "transcript": { "messageId": "m1", "completion": { "status": "failed", "attemptId": "a1" } } } });
                run.port.commit_item(ItemCommit { iid: ItemId::from("m1-row"), role: Some("user".into()), model: true, visible: false, body, prompt: None }).await.expect("commit");
            }
            let end = json!({
                "type": "turnEnd", "id": format!("end-{}", run.turn), "status": "failed", "elapsedMs": 5,
                "quota": { "provider": "anthropic", "model": "m", "resetAt": 5000 },
                "meta": { "turnId": run.turn, "ext": { "attemptId": run.turn } },
            });
            run.port
                .commit_item(ItemCommit { iid: ItemId::from(format!("end-{}", run.turn)), role: Some("assistant".into()), model: false, visible: true, body: json!({ "shownItem": end }), prompt: None })
                .await
                .expect("commit");
            let provider = mixdog_protocol::ProviderErrorDetail { provider: "anthropic".into(), status: Some(429), kind: "quota_exhausted".into(), delivery: None };
            RunOutcome::Failed(mixdog_protocol::TurnError { message: "quota".into(), data: json!({}), provider_error: Some(provider) })
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "write the report", "op-1").await;
    let id = handle.id.as_str().to_owned();
    let entry = eventually(|| rig.quota.entry(&id)).await;
    eventually(|| idle(&handle).then_some(())).await;
    (handle, entry.turn_key, seen)
}

fn user_rows(handle: &SessionHandle) -> usize {
    handle.cell.view.load_full().items.iter().filter(|item| matches!(item.as_ref(), mixdog_protocol::ThreadItem::UserMessage { .. })).count()
}

/// A retry that names the failed message (a restored Node session) resends it as stored: the
/// retry turn carries its id and attempt, its input row stays off screen, and the entry ends.
#[tokio::test(start_paused = true)]
async fn a_retained_failed_message_is_resent_hidden_with_its_id_and_attempt() {
    let rig = Rig::new();
    let (handle, key, seen) = quota_failed_thread(&rig, true).await;
    let shown = user_rows(&handle);
    retry_when_settled(&handle, &key, "r-1a").await;
    eventually(|| (super::testing::lock(&seen).len() == 2).then_some(())).await;
    let options = super::testing::lock(&seen)[1].clone().expect("retry options");
    assert_eq!((options.retry_failed_turn, options.retry_turn_id, options.retry_attempt_id), (Some(true), Some("m1".into()), Some("a1".into())));
    eventually(|| idle(&handle).then_some(())).await;
    assert_eq!(user_rows(&handle), shown, "the resent message paints no second row");
    eventually(|| rig.quota.entry(handle.id.as_str()).is_none().then_some(())).await;
}

/// `retryBlocked`: a compaction running owns the session first (`commandBusy` /
/// `autoClearRunning`); the retry is refused and runs once the compaction ended.
#[tokio::test(start_paused = true)]
async fn a_retry_waits_for_a_running_compaction() {
    let rig = Rig::new();
    let (handle, key, seen) = quota_failed_thread(&rig, false).await;
    let hold = Arc::new(tokio::sync::Notify::new());
    *super::testing::lock(&rig.compaction.hold) = Some(hold.clone());
    let compacting = {
        let handle = handle.clone();
        tokio::spawn(async move { call(&handle, "thread/compact/start", json!({}), "c-1").await })
    };
    eventually(|| (!super::testing::lock(&rig.compaction.calls).is_empty()).then_some(())).await;
    assert_eq!(call(&handle, "turn/retryFailed", json!({ "turnKey": key }), "r-1").await.expect("answered"), json!(false));
    hold.notify_one();
    compacting.await.expect("joined").expect("compacted");
    assert_eq!(super::testing::lock(&seen).len(), 1, "the refused retry started nothing");
    retry_when_settled(&handle, &key, "r-2c").await;
    eventually(|| (super::testing::lock(&seen).len() == 2).then_some(())).await;
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
            let end = json!({
                "type": "turnEnd", "id": format!("end-{}", run.turn), "status": "failed", "elapsedMs": 5,
                "quota": { "provider": "anthropic", "model": "m", "resetAt": 5000 },
                "meta": { "turnId": run.turn, "ext": { "attemptId": run.turn } },
            });
            run.port
                .commit_item(super::ItemCommit { iid: mixdog_core_api::ids::ItemId::from(format!("end-{}", run.turn)), role: Some("assistant".into()), model: false, visible: true, body: json!({ "shownItem": end }), prompt: None })
                .await
                .expect("commit");
            let provider = mixdog_protocol::ProviderErrorDetail { provider: "anthropic".into(), status: Some(429), kind: "quota_exhausted".into(), delivery: None };
            RunOutcome::Failed(mixdog_protocol::TurnError { message: "quota".into(), data: json!({}), provider_error: Some(provider) })
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let id = handle.id.as_str().to_owned();
    rig.goals.goal_control(&handle.id, json!({ "action": "create", "objective": "Ship it" })).await.expect("create");
    let goal_id = rig.goals.goal_status(&handle.id).await.expect("status").expect("a goal")["id"].as_str().expect("goal id").to_owned();
    let key = eventually(|| rig.quota.entry(&id).map(|entry| entry.turn_key)).await;
    eventually(|| (rig.quota.suspended_goal(&id, &key) == goal_id).then_some(())).await;
    eventually(|| idle(&handle).then_some(())).await;

    retry_when_settled(&handle, &key, "r-1a").await;
    eventually(|| (*super::testing::lock(&seen) == 2).then_some(())).await;
    let goal = rig.goals.goal_status(&handle.id).await.expect("status").expect("a goal");
    assert_eq!(goal["status"], "active", "the Goal was revived");
    eventually(|| (rig.quota.entry(&id).is_none() && rig.quota.suspended_goal(&id, &key).is_empty()).then_some(())).await;
    eventually(|| idle(&handle).then_some(())).await;
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
    eventually(|| idle(&handle).then_some(())).await;
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
    eventually(|| (!idle(&handle)).then_some(())).await;
    assert_eq!(directory.commit_compaction(&handle.id, snapshot.clone(), compaction(), None).await.expect("answered"), CompactionCommit::Moved);
    gate.notify_one();
    eventually(|| idle(&handle).then_some(())).await;

    // The turn that finished meanwhile appended its rows: they follow the compacted ones.
    assert_eq!(directory.commit_compaction(&handle.id, snapshot, compaction(), None).await.expect("answered"), CompactionCommit::Applied);
    let after = directory.model_context(&handle.id).read().await.expect("context");
    assert_eq!(after.first().map(|(iid, _)| iid.as_str()), Some("sum1"));
    assert!(after.len() >= 2, "the second turn's rows follow the summary: {after:?}");
    assert!(after.iter().skip(1).all(|(iid, _)| iid.as_str() != "sum1"));
}

/// A commit that carries the header writes it with the compaction, in the record that counts it:
/// the caller's `compaction.compactCount` stands (it is not counted twice), and a commit that
/// carries none counts one more.
#[tokio::test(start_paused = true)]
async fn a_manual_compaction_commit_writes_the_header_it_carries_without_counting_twice() {
    use super::run::Compaction;
    use mixdog_core_api::ids::ItemId;
    use mixdog_store::schema::record::HeaderChange;

    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "first", "op-1").await;
    eventually(|| idle(&handle).then_some(())).await;
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
    eventually(|| (handle.live_header().header().get("compaction")?.get("compactCount") == Some(&json!(7))).then_some(())).await;
    let header = handle.live_header().header();
    assert_eq!(header["compaction"]["lastStage"], json!("manual"));
    assert_eq!(header["lastContextTokens"], json!(0));

    // Nothing carried: one more is counted over the state the header holds.
    let snapshot = snapshot_of(directory.model_context(&handle.id).read().await.expect("context"));
    let applied = directory.commit_compaction(&handle.id, snapshot, compaction("sum2"), None).await.expect("answered");
    assert_eq!(applied, super::turn_ops::CompactionCommit::Applied);
    eventually(|| (handle.live_header().header().get("compaction")?.get("compactCount") == Some(&json!(8))).then_some(())).await;
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
            let end = json!({
                "type": "turnEnd", "id": format!("end-{}", run.turn), "status": "failed", "elapsedMs": 5,
                "quota": { "provider": "anthropic", "model": "m", "resetAt": 5000 },
                "meta": { "turnId": run.turn, "ext": { "attemptId": run.turn } },
            });
            run.port
                .commit_item(ItemCommit { iid: ItemId::from(format!("end-{}", run.turn)), role: Some("assistant".into()), model: false, visible: true, body: json!({ "shownItem": end }), prompt: None })
                .await
                .expect("commit");
            let provider = mixdog_protocol::ProviderErrorDetail { provider: "anthropic".into(), status: Some(429), kind: "quota_exhausted".into(), delivery: None };
            RunOutcome::Failed(mixdog_protocol::TurnError { message: "quota".into(), data: json!({}), provider_error: Some(provider) })
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "write the report", "op-1").await;
    let id = handle.id.as_str().to_owned();
    let first = eventually(|| rig.quota.entry(&id)).await;
    eventually(|| idle(&handle).then_some(())).await;

    retry_when_settled(&handle, &first.turn_key, "r-1s").await;
    eventually(|| (super::testing::lock(&stamped).len() == 2).then_some(())).await;
    eventually(|| idle(&handle).then_some(())).await;
    let second = eventually(|| rig.quota.entry(&id).filter(|entry| entry.turn_key != first.turn_key)).await;
    retry_when_settled(&handle, &second.turn_key, "r-2s").await;
    eventually(|| (super::testing::lock(&stamped).len() == 3).then_some(())).await;

    let provenance = json!({ "source": "task-notification" });
    assert_eq!(*super::testing::lock(&stamped), [Value::Null, provenance.clone(), provenance], "each retry row carries the failed turn's provenance");
    let begun = super::testing::lock(&rig.warms.begun).clone();
    let kinds: Vec<TurnKind> = begun.iter().map(|(_, input, messages)| turn_kind(input, messages.as_ref())).collect();
    assert_eq!(kinds, [TurnKind::Return, TurnKind::System, TurnKind::System], "the prompt is a return, both retries are system");
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
            let end = json!({
                "type": "turnEnd", "id": format!("end-{}", run.turn), "status": "failed", "elapsedMs": 5, "verb": "Thought",
                "quota": { "provider": "anthropic", "model": "m", "resetAt": 5000 },
                "meta": { "turnId": run.turn, "at": 7, "ext": { "attemptId": "att-1" } },
            });
            run.port
                .commit_item(ItemCommit { iid: ItemId::from(format!("end-{}", run.turn)), role: Some("assistant".into()), model: false, visible: true, body: json!({ "shownItem": end }), prompt: None })
                .await
                .expect("commit");
            let provider = mixdog_protocol::ProviderErrorDetail { provider: "anthropic".into(), status: Some(429), kind: "quota_exhausted".into(), delivery: None };
            RunOutcome::Failed(mixdog_protocol::TurnError { message: "quota".into(), data: json!({}), provider_error: Some(provider) })
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "write the report", "op-1").await;
    eventually(|| idle(&handle).then_some(())).await;
    eventually(|| (super::testing::lock(&stamped).len() == 1).then_some(())).await;

    let context = directory.model_context(&handle.id);
    let messages = loop {
        let rows: Vec<Value> = context.read().await.expect("context").into_iter().map(|(_, message)| message).collect();
        if rows.iter().any(|message| message.pointer("/meta/transcript/completion").is_some()) {
            break rows;
        }
        tokio::task::yield_now().await;
    };
    assert_eq!(
        messages.last().expect("rows").pointer("/meta/transcript/completion"),
        Some(&json!({ "status": "failed", "attemptId": "att-1", "at": 7, "verb": "Thought", "elapsedMs": 5, "quota": { "provider": "anthropic", "model": "m", "resetAt": 5000 } })),
        "the failed turn's last message records its end"
    );

    call(&handle, "turn/start", json!({ "input": { "prompt": "go on", "options": { "retryFailedTurn": true, "retryTurnId": "m1" } } }), "op-retry").await.expect("started");
    eventually(|| (super::testing::lock(&stamped).len() == 2).then_some(())).await;
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
    eventually(|| idle(&handle).then_some(())).await;

    let context = directory.model_context(&handle.id);
    let messages = loop {
        let rows: Vec<Value> = context.read().await.expect("context").into_iter().map(|(_, message)| message).collect();
        if rows.iter().any(|message| message.pointer("/meta/transcript/completion").is_some()) {
            break rows;
        }
        tokio::task::yield_now().await;
    };
    let mut completion = messages.last().expect("rows").pointer("/meta/transcript/completion").cloned().expect("completion");
    assert!(completion["attemptId"].as_str().is_some_and(|id| !id.is_empty()), "a fresh attempt id");
    completion.as_object_mut().expect("object").shift_remove("attemptId");
    assert_eq!(
        completion,
        json!({ "status": "failed", "at": 1000, "verb": "Thought", "elapsedMs": 0, "detail": want["detail"], "errorDetails": want["errorDetails"], "errorKind": want["errorKind"] })
    );

    let ends: Vec<_> = directory
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