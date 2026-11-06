//! Mirrors `setup-tool/ui-requests.test.mjs`.

use std::sync::Mutex;

use serde_json::json;

use super::*;

#[derive(Default)]
struct Surface {
    attached: bool,
    seen: Mutex<Vec<String>>,
}

#[async_trait]
impl SetupUiSurface for Surface {
    async fn notify(&self, _thread: &ThreadId, request_id: &str) -> bool {
        self.seen.lock().unwrap().push(request_id.to_owned());
        self.attached
    }
}

fn requests(attached: bool, claim: Duration) -> (Arc<SetupRequests>, Arc<Surface>) {
    let surface = Arc::new(Surface { attached, seen: Mutex::default() });
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
