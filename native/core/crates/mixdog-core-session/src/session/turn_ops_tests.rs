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
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
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
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
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
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
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
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
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
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
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
    let pending = handle.cell.header.load().get("pendingGoalReminder").cloned().expect("marked");
    assert_eq!((pending["reason"].clone(), pending["revision"].clone()), (json!("compaction"), json!(1)));

    // No result at all is Node's `null`.
    *super::testing::lock(&rig.compaction.result) = None;
    assert_eq!(call(&handle, "thread/compact/start", json!({}), "k-4").await.expect("answered"), Value::Null);
}

/// `retryFailedTurn(sessionId, turnKey)` of the quota lane: while `turnKey` is the latest failed
/// turn and nothing runs, settles or waits, the failed prompt is replayed as a retry turn, the
/// resume entry is finished and the answer is `true`; any other key, and a second ask for the
/// same turn, answer `false`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
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

    assert_eq!(call(&handle, "turn/retryFailed", json!({ "turnKey": key }), "r-3").await.expect("answered"), json!(true));
    eventually(|| (super::testing::lock(&seen).len() == 2).then_some(())).await;
    assert_eq!(super::testing::lock(&seen)[1].1, Some(true), "the retry turn carries retryFailedTurn");
    assert!(super::testing::lock(&seen)[1].0.contains("write the report"), "the failed prompt is replayed");
    eventually(|| rig.quota.entry(&id).is_none().then_some(())).await;
    eventually(|| idle(&handle).then_some(())).await;
    assert_eq!(call(&handle, "turn/retryFailed", json!({ "turnKey": key }), "r-4").await.expect("answered"), json!(false), "the retry's own turn is now the latest");
}
