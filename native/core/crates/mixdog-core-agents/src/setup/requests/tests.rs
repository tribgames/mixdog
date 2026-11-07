//! Mirrors `setup-tool/ui-requests.test.mjs`.

use std::sync::Mutex;

use serde_json::json;

use super::*;

#[derive(Default)]
struct Surface {
    attached: bool,
    seen: Mutex<Vec<String>>,
    /// The notified requests the broker settled, in order.
    settled: Mutex<Vec<String>>,
}

#[async_trait]
impl SetupUiSurface for Surface {
    async fn notify(&self, _thread: &ThreadId, request_id: &str, _window: Duration) -> bool {
        self.seen.lock().unwrap().push(request_id.to_owned());
        self.attached
    }

    async fn settled(&self, _thread: &ThreadId, request_id: &str) {
        self.settled.lock().unwrap().push(request_id.to_owned());
    }
}

fn requests(attached: bool, claim: Duration) -> (Arc<SetupRequests>, Arc<Surface>) {
    let surface = Arc::new(Surface { attached, seen: Mutex::default(), settled: Mutex::default() });
    (Arc::new(SetupRequests::with_timeouts(surface.clone(), claim, EXECUTION_TIMEOUT)), surface)
}

async fn first_id(surface: &Surface) -> String {
    loop {
        if let Some(id) = surface.seen.lock().unwrap().first().cloned() {
            return id;
        }
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn a_matching_single_use_receipt_completes_the_request() {
    let (broker, surface) = requests(true, CLAIM_TIMEOUT);
    let thread = ThreadId::from("session-a");
    let args = json!({ "action": "save_project", "project": { "path": "/p" } });
    let pending = tokio::spawn({
        let (broker, thread, args) = (broker.clone(), thread.clone(), args.clone());
        async move { broker.request(&thread, &args).await }
    });
    let id = first_id(&surface).await;
    assert!(broker.claim(&thread, "missing", "owner").is_none());
    let claim = broker.claim(&thread, &id, "owner").unwrap();
    assert_eq!(claim["args"], args);
    assert_eq!(claim["scope"], "desktop-host");
    assert!(broker.claim(&thread, &id, "other-window").is_none());
    assert_eq!(broker.complete(&id, "wrong-owner", &json!({ "result": {} })).unwrap(), false);
    assert_eq!(broker.complete(&id, "owner", &json!({ "result": { "saved": true, "scope": "desktop-host" } })).unwrap(), true);
    assert_eq!(pending.await.unwrap().unwrap(), DesktopAnswer::Done(json!({ "saved": true, "scope": "desktop-host" })));
    assert!(broker.claim(&thread, &id, "owner").is_none());
    assert_eq!(broker.complete(&id, "owner", &json!({ "result": {} })).unwrap(), false);
}

#[tokio::test]
async fn a_claim_from_another_thread_or_without_an_owner_is_refused() {
    let (broker, surface) = requests(true, CLAIM_TIMEOUT);
    let thread = ThreadId::from("s");
    let pending = tokio::spawn({
        let (broker, thread) = (broker.clone(), thread.clone());
        async move { broker.request(&thread, &json!({})).await }
    });
    let id = first_id(&surface).await;
    assert!(broker.claim(&ThreadId::from("other"), &id, "owner").is_none());
    assert!(broker.claim(&thread, &id, "  ").is_none());
    assert!(broker.claim(&thread, &id, "owner").is_some());
    broker.dispose();
    let error = pending.await.unwrap().unwrap_err();
    assert!(format!("{error:?}").contains("session closed"), "{error:?}");
}

#[tokio::test]
async fn a_desktop_error_receipt_fails_the_request() {
    let (broker, surface) = requests(true, CLAIM_TIMEOUT);
    let thread = ThreadId::from("s");
    let pending = tokio::spawn({
        let (broker, thread) = (broker.clone(), thread.clone());
        async move { broker.request(&thread, &json!({ "action": "set_desktop_settings" })).await }
    });
    let id = first_id(&surface).await;
    broker.claim(&thread, &id, "local-desktop").unwrap();
    assert!(broker.complete(&id, "local-desktop", &json!("nope")).is_err());
    broker.complete(&id, "local-desktop", &json!({ "error": "Desktop storage failed" })).unwrap();
    let error = pending.await.unwrap().unwrap_err();
    assert!(format!("{error:?}").contains("Desktop storage failed"), "{error:?}");
}

#[tokio::test]
async fn no_surface_or_no_claim_leaves_the_request_unclaimed() {
    let (absent, _) = requests(false, CLAIM_TIMEOUT);
    assert_eq!(
        absent.request(&ThreadId::from("s"), &json!({})).await.unwrap(),
        DesktopAnswer::Unclaimed("setup: no attached Desktop surface; nothing was changed".into())
    );
    let (broker, surface) = requests(true, Duration::from_millis(10));
    let thread = ThreadId::from("s");
    assert_eq!(
        broker.request(&thread, &json!({})).await.unwrap(),
        DesktopAnswer::Unclaimed("setup: no Desktop window claimed the request; nothing was changed".into())
    );
    let id = first_id(&surface).await;
    assert!(broker.claim(&thread, &id, "owner").is_none(), "an expired request cannot be claimed");
}

#[tokio::test]
async fn a_cancelled_call_loses_its_request() {
    let (broker, surface) = requests(true, CLAIM_TIMEOUT);
    let thread = ThreadId::from("s");
    let pending = tokio::spawn({
        let (broker, thread) = (broker.clone(), thread.clone());
        async move { broker.request(&thread, &json!({})).await }
    });
    let id = first_id(&surface).await;
    broker.claim(&thread, &id, "desktop").unwrap();
    assert!(broker.is_active(&thread, &id, "desktop"));
    assert!(!broker.is_active(&thread, &id, "other-window"));
    pending.abort();
    let _ = pending.await;
    assert!(!broker.is_active(&thread, &id, "desktop"));
    assert_eq!(broker.complete(&id, "desktop", &json!({ "result": { "saved": true } })).unwrap(), false);
}

/// A surface that records each notice and answers as the world says the next one is attached.
struct Scripted {
    attach: Mutex<bool>,
    seen: Mutex<Vec<String>>,
}

#[async_trait]
impl SetupUiSurface for Scripted {
    async fn notify(&self, _thread: &ThreadId, request_id: &str, _window: Duration) -> bool {
        self.seen.lock().unwrap().push(request_id.to_owned());
        *self.attach.lock().unwrap()
    }

    async fn settled(&self, _thread: &ThreadId, _request_id: &str) {}
}

async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

fn state_of(answer: &Result<DesktopAnswer, PortError>) -> Value {
    match answer {
        Ok(DesktopAnswer::Done(value)) => json!({ "ok": value }),
        Ok(DesktopAnswer::Unclaimed(message)) => json!({ "err": message, "code": "SETUP_DESKTOP_UNCLAIMED" }),
        Err(PortError::Failed { message, .. }) => json!({ "err": message, "code": null }),
        Err(other) => panic!("{other:?}"),
    }
}

struct Open {
    state: Arc<Mutex<Option<Value>>>,
    task: tokio::task::JoinHandle<()>,
    id: String,
}

fn states(opened: &[Open]) -> Value {
    Value::Array(opened.iter().map(|open| open.state.lock().unwrap().clone().unwrap_or_else(|| json!("pending"))).collect())
}

/// The recorded answers of Node's `createSetupUiRequests` (`record-setup-requests.mjs`) to 160
/// scripted worlds of request / claim / isActive / complete / abort / wait / dispose.
#[tokio::test(start_paused = true)]
async fn the_requests_answer_what_the_recorded_node_broker_answered() {
    let twin: Value = serde_json::from_str(include_str!("../../../../../fixtures/desktop/settings/setup-requests-twin.json")).unwrap();
    let mut steps = 0;
    for (w, world) in twin["worlds"].as_array().unwrap().iter().enumerate() {
        let surface = Arc::new(Scripted { attach: Mutex::new(true), seen: Mutex::default() });
        let broker = Arc::new(SetupRequests::with_timeouts(
            surface.clone(),
            Duration::from_millis(world["claimMs"].as_u64().unwrap()),
            Duration::from_millis(world["execMs"].as_u64().unwrap()),
        ));
        let service = SetupRequestsService::new(broker.clone());
        let mut opened: Vec<Open> = Vec::new();
        for (s, step) in world["steps"].as_array().unwrap().iter().enumerate() {
            let at = format!("world {w} step {s}: {step}");
            steps += 1;
            let mut result = Value::Null;
            match step["op"].as_str().unwrap() {
                "request" => {
                    *surface.attach.lock().unwrap() = step["attach"].as_bool().unwrap();
                    let (broker, thread, args) = (broker.clone(), ThreadId::from(step["session"].as_str().unwrap()), step["args"].clone());
                    let state = Arc::new(Mutex::new(None));
                    let task = tokio::spawn({
                        let state = state.clone();
                        async move {
                            let answer = broker.request(&thread, &args).await;
                            *state.lock().unwrap() = Some(state_of(&answer));
                        }
                    });
                    settle().await;
                    let id = surface.seen.lock().unwrap().last().cloned().unwrap();
                    opened.push(Open { state, task, id });
                }
                "wait" => {
                    tokio::time::advance(Duration::from_millis(step["ms"].as_u64().unwrap())).await;
                }
                "dispose" => broker.dispose(),
                "abort" => {
                    let open = &opened[step["target"].as_u64().unwrap() as usize];
                    if open.state.lock().unwrap().is_none() {
                        open.task.abort();
                        *open.state.lock().unwrap() = Some(json!("cancelled"));
                    }
                }
                op => {
                    let open = &opened[step["target"].as_u64().unwrap() as usize];
                    let mut params = json!({ "id": open.id, "owner": step["owner"] });
                    let session = step["session"].as_str().unwrap();
                    if !session.is_empty() {
                        params["threadId"] = json!(session);
                    }
                    if op == "complete" {
                        params["receipt"] = step["receipt"].clone();
                    }
                    let method = match op {
                        "claim" => "config/claimSetupRequest",
                        "active" => "config/isSetupRequestActive",
                        _ => "config/completeSetupRequest",
                    };
                    let req = CoreRequest {
                        method: Method(method),
                        params,
                        op: None,
                        ctx: mixdog_core_api::call::CallContext::internal("test"),
                    };
                    result = match service.call(req).await {
                        Ok(Reply::Value(value)) => value,
                        Ok(_) => panic!("{at}"),
                        Err(CoreError::DomainError { message, .. }) => json!({ "throws": message.as_deref() }),
                        Err(other) => panic!("{at}: {other:?}"),
                    };
                }
            }
            settle().await;
            // The request ids are random: the claim answers with the id it was sent.
            let mut expected = step["result"].clone();
            if expected.get("id").is_some() {
                expected["id"] = result["id"].clone();
            }
            assert_eq!(result, expected, "{at}");
            assert_eq!(states(&opened), step["states"], "{at}");
        }
        broker.dispose();
        settle().await;
        assert_eq!(states(&opened), world["final"], "world {w} final");
    }
    assert!(steps > 1000);
}

/// The session shows a request until it can no longer be claimed: the broker settles it once,
/// when a window claims it or when it ends unclaimed, and never settles one nobody took.
#[tokio::test]
async fn a_request_is_settled_once_when_claimed_or_when_it_ends_unclaimed() {
    let thread = ThreadId::from("s");
    let (broker, surface) = requests(true, CLAIM_TIMEOUT);
    let pending = tokio::spawn({
        let (broker, thread) = (broker.clone(), thread.clone());
        async move { broker.request(&thread, &json!({})).await }
    });
    let id = first_id(&surface).await;
    assert!(surface.settled.lock().unwrap().is_empty(), "claimable until claimed");
    broker.claim(&thread, &id, "desktop").unwrap();
    while surface.settled.lock().unwrap().is_empty() {
        tokio::task::yield_now().await;
    }
    broker.complete(&id, "desktop", &json!({ "result": { "ok": true } })).unwrap();
    pending.await.unwrap().unwrap();
    assert_eq!(*surface.settled.lock().unwrap(), [id.clone()], "settled at the claim, not again at the end");

    let (expiring, surface) = requests(true, Duration::from_millis(10));
    expiring.request(&thread, &json!({})).await.unwrap();
    assert_eq!(*surface.settled.lock().unwrap(), surface.seen.lock().unwrap().clone(), "an unclaimed request ends settled");

    let (absent, surface) = requests(false, CLAIM_TIMEOUT);
    absent.request(&thread, &json!({})).await.unwrap();
    assert!(surface.settled.lock().unwrap().is_empty(), "a request nobody took is never shown");
}