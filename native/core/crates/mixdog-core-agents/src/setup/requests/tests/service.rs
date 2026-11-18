//! The claimant's side of the desktop requests (the three `config/*SetupRequest` methods), the
//! claim moving the deadline, and what counts as a receipt.

use serde_json::json;

use super::*;

fn call(method: &'static str, params: Value) -> CoreRequest {
    CoreRequest { method: Method(method), params, op: None, ctx: mixdog_core_api::call::CallContext::internal("test") }
}

async fn answer(service: &SetupRequestsService, method: &'static str, params: Value) -> Result<Value, CoreError> {
    match service.call(call(method, params)).await? {
        Reply::Value(value) => Ok(value),
        _ => panic!("{method} answered no value"),
    }
}

fn domain_message(error: &CoreError) -> String {
    match error {
        CoreError::DomainError { message, .. } => message.as_deref().unwrap_or_default().to_owned(),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn a_window_checks_claims_and_completes_a_request_by_its_thread_and_owner() {
    let (broker, surface) = requests(true, CLAIM_TIMEOUT);
    let service = SetupRequestsService::new(broker.clone());
    let thread = ThreadId::from("sess_a");
    let args = json!({ "action": "save_project" });
    let pending = tokio::spawn({
        let (broker, thread, args) = (broker.clone(), thread.clone(), args.clone());
        async move { broker.request(&thread, &args).await }
    });
    let id = first_id(&surface).await;
    let who = |owner: &str, thread: Option<&str>| {
        let mut params = json!({ "id": id, "owner": owner });
        if let Some(thread) = thread {
            params["threadId"] = json!(thread);
        }
        params
    };

    assert_eq!(answer(&service, "config/isSetupRequestActive", who("win", Some("sess_a"))).await.unwrap(), json!(false), "nobody owns it yet");
    // Another session's window, a window with no session and a nameless owner get nothing.
    assert_eq!(answer(&service, "config/claimSetupRequest", who("win", Some("sess_b"))).await.unwrap(), Value::Null);
    assert_eq!(answer(&service, "config/claimSetupRequest", who("win", None)).await.unwrap(), Value::Null);
    assert_eq!(answer(&service, "config/claimSetupRequest", who(" ", Some("sess_a"))).await.unwrap(), Value::Null);
    let claim = answer(&service, "config/claimSetupRequest", who("win", Some("sess_a"))).await.unwrap();
    assert_eq!(claim, json!({ "id": id, "args": args, "scope": "desktop-host" }));
    assert_eq!(answer(&service, "config/isSetupRequestActive", who("win", Some("sess_a"))).await.unwrap(), json!(true));
    assert_eq!(answer(&service, "config/isSetupRequestActive", who("other", Some("sess_a"))).await.unwrap(), json!(false));
    assert_eq!(answer(&service, "config/isSetupRequestActive", who("win", None)).await.unwrap(), json!(false));

    let mut done = who("win", Some("sess_a"));
    done["receipt"] = json!({ "result": { "saved": true } });
    assert_eq!(answer(&service, "config/completeSetupRequest", done.clone()).await.unwrap(), json!(true));
    assert_eq!(pending.await.unwrap().unwrap(), DesktopAnswer::Done(json!({ "saved": true })));
    assert_eq!(answer(&service, "config/completeSetupRequest", done).await.unwrap(), json!(false), "a receipt is single-use");
}

#[tokio::test]
async fn a_receipt_that_is_no_object_is_refused_and_one_with_a_falsy_error_succeeds() {
    let (broker, surface) = requests(true, CLAIM_TIMEOUT);
    let service = SetupRequestsService::new(broker.clone());
    let thread = ThreadId::from("s");
    // Each receipt settles its own request.
    let cases = [
        (json!({ "error": "" }), Some(Value::Null)),
        (json!({ "error": 0, "result": { "n": 1 } }), Some(json!({ "n": 1 }))),
        (json!([1, 2]), Some(Value::Null)),
    ];
    for (receipt, expected) in cases {
        let pending = tokio::spawn({
            let (broker, thread) = (broker.clone(), thread.clone());
            async move { broker.request(&thread, &json!({})).await }
        });
        let id = loop {
            if let Some(id) = surface.seen.lock().unwrap().last().cloned().filter(|id| broker.claim(&thread, id, "win").is_some()) {
                break id;
            }
            tokio::task::yield_now().await;
        };
        let params = json!({ "id": id, "owner": "win", "receipt": receipt });
        assert_eq!(answer(&service, "config/completeSetupRequest", params).await.unwrap(), json!(true), "{receipt}");
        assert_eq!(pending.await.unwrap().unwrap(), DesktopAnswer::Done(expected.unwrap()), "{receipt}");
    }

    let pending = tokio::spawn({
        let (broker, thread) = (broker.clone(), thread.clone());
        async move { broker.request(&thread, &json!({})).await }
    });
    let id = loop {
        if let Some(id) = surface.seen.lock().unwrap().last().cloned().filter(|id| broker.claim(&thread, id, "win").is_some()) {
            break id;
        }
        tokio::task::yield_now().await;
    };
    let refused = answer(&service, "config/completeSetupRequest", json!({ "id": id, "owner": "win", "receipt": "done" })).await.unwrap_err();
    assert_eq!(domain_message(&refused), "setup receipt is required");
    assert!(!pending.is_finished(), "a refused receipt leaves the request open");
    broker.dispose();
    pending.await.unwrap().unwrap_err();
}

#[tokio::test]
async fn the_service_needs_an_id_and_an_owner_and_knows_only_its_three_methods() {
    let (broker, _) = requests(true, CLAIM_TIMEOUT);
    let service = SetupRequestsService::new(broker);
    assert_eq!(service.methods(), ["config/isSetupRequestActive", "config/claimSetupRequest", "config/completeSetupRequest"]);
    for params in [json!({ "owner": "w" }), json!({ "id": "x" }), json!({ "id": 3, "owner": "w" })] {
        let error = answer(&service, "config/claimSetupRequest", params.clone()).await.unwrap_err();
        assert!(matches!(error, CoreError::InvalidParams { .. }), "{params}: {error:?}");
    }
    let unknown = answer(&service, "config/somethingElse", json!({ "id": "x", "owner": "w" })).await.unwrap_err();
    assert!(matches!(unknown, CoreError::InvalidParams { .. }), "{unknown:?}");
    assert_eq!(answer(&service, "config/claimSetupRequest", json!({ "id": "nope", "owner": "w", "threadId": "s" })).await.unwrap(), Value::Null);
}

#[tokio::test(start_paused = true)]
async fn a_claim_moves_the_deadline_from_the_claim_window_to_the_execution_window() {
    let surface = Arc::new(Surface { attached: true, ..Surface::default() });
    let broker = Arc::new(SetupRequests::with_timeouts(surface.clone(), Duration::from_secs(10), Duration::from_secs(60)));
    let thread = ThreadId::from("s");
    let pending = tokio::spawn({
        let (broker, thread) = (broker.clone(), thread.clone());
        async move { broker.request(&thread, &json!({})).await }
    });
    let id = first_id(&surface).await;
    tokio::time::advance(Duration::from_secs(5)).await;
    broker.claim(&thread, &id, "win").unwrap();
    // Past the claim window the claimed request is still waited for.
    tokio::time::advance(Duration::from_secs(30)).await;
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    assert!(!pending.is_finished(), "the claim window no longer applies");
    assert!(broker.complete(&id, "win", &json!({ "result": { "late": false } })).unwrap());
    assert_eq!(pending.await.unwrap().unwrap(), DesktopAnswer::Done(json!({ "late": false })));
}

#[tokio::test(start_paused = true)]
async fn a_claimed_request_with_no_receipt_in_time_fails_and_warns_it_may_still_run() {
    let surface = Arc::new(Surface { attached: true, ..Surface::default() });
    let broker = Arc::new(SetupRequests::with_timeouts(surface.clone(), Duration::from_secs(10), Duration::from_secs(60)));
    let thread = ThreadId::from("s");
    let pending = tokio::spawn({
        let (broker, thread) = (broker.clone(), thread.clone());
        async move { broker.request(&thread, &json!({})).await }
    });
    let id = first_id(&surface).await;
    broker.claim(&thread, &id, "win").unwrap();
    let error = pending.await.unwrap().unwrap_err();
    match error {
        PortError::Failed { message, .. } => {
            assert_eq!(message, "setup: Desktop did not return a receipt. The operation may still be running; inspect its state before retrying.");
        }
        other => panic!("{other:?}"),
    }
    assert!(!broker.is_active(&thread, &id, "win"), "the request is gone");
}
