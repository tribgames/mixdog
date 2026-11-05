use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

use super::*;
use crate::channels::running::RunningWork;

#[derive(Default)]
struct MemStore {
    endpoints: Mutex<HashMap<String, Endpoint>>,
    secrets: Mutex<HashMap<String, String>>,
    deliveries: Mutex<HashMap<(String, String), String>>,
}

#[async_trait]
impl WebhookStore for MemStore {
    async fn load_endpoint(&self, name: &str) -> Result<Option<Endpoint>, String> {
        Ok(self.endpoints.lock().unwrap().get(name).cloned())
    }
    async fn read_secret(&self, name: &str) -> Result<Option<String>, String> {
        Ok(self.secrets.lock().unwrap().get(name).cloned())
    }
    async fn claim_delivery(&self, endpoint: &str, id: &str, claim: Claim<'_>) -> Result<bool, String> {
        let mut rows = self.deliveries.lock().unwrap();
        let key = (endpoint.to_string(), id.to_string());
        if rows.contains_key(&key) {
            return Ok(false);
        }
        rows.insert(key, claim.status.to_string());
        Ok(true)
    }
    async fn update_delivery_status(&self, endpoint: &str, id: &str, status: &str, _e: Option<&str>) -> Result<(), String> {
        self.deliveries.lock().unwrap().insert((endpoint.into(), id.into()), status.into());
        Ok(())
    }
}

#[derive(Default)]
struct Dispatched(Mutex<Vec<(String, Value)>>);

#[async_trait]
impl WebhookDispatch for Dispatched {
    async fn handle(&self, name: &str, payload: Value, _h: &Headers, id: &str, _t: bool) -> Result<HttpReply, String> {
        self.0.lock().unwrap().push((name.into(), payload));
        Ok(HttpReply { status: 200, body: json!({"status":"accepted","id":id}) })
    }
}

fn sign(secret: &str, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(body);
    let hex: String = mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect();
    format!("sha256={hex}")
}

fn headers(pairs: &[(&str, &str)]) -> Headers {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

struct Fx {
    svc: WebhookService,
    store: Arc<MemStore>,
    dispatched: Arc<Dispatched>,
    work: RunningWork,
}

fn fx(config: WebhookConfig) -> Fx {
    let store = Arc::new(MemStore::default());
    store.endpoints.lock().unwrap().insert("hook".into(), Endpoint::default());
    store.secrets.lock().unwrap().insert("hook".into(), "s3".into());
    let dispatched = Arc::new(Dispatched::default());
    let work = RunningWork::new();
    let svc = WebhookService::new(store.clone(), dispatched.clone(), config, work.clone(), Arc::new(|| 0));
    Fx { svc, store, dispatched, work }
}

const JSON_CT: (&str, &str) = ("content-type", "application/json");

#[tokio::test]
async fn name_gate_runs_before_anything_else() {
    let f = fx(WebhookConfig::default());
    for (path, status, error) in [
        ("/webhook/..%2Fx", 404, "invalid endpoint name"),
        ("/webhook/", 404, "invalid endpoint name"),
        ("/webhook/nope", 404, "unknown endpoint"),
    ] {
        let reply = f.svc.handle_post(path, &headers(&[]), b"{}").await;
        assert_eq!((reply.status, reply.body), (status, json!({"error":error})), "{path}");
    }
    f.store.endpoints.lock().unwrap().insert("off".into(), Endpoint { enabled: Some(false), ..Default::default() });
    assert_eq!(f.svc.handle_post("/webhook/off", &headers(&[]), b"{}").await.body, json!({"error":"disabled endpoint"}));
}

#[tokio::test]
async fn signed_delivery_dispatches_once_and_dedups_replays() {
    let f = fx(WebhookConfig::default());
    let body = br#"{"a":1}"#;
    let h = headers(&[JSON_CT, ("x-hub-signature-256", &sign("s3", body)), ("x-github-delivery", "g1")]);
    let first = f.svc.handle_post("/webhook/hook?x=1", &h, body).await;
    assert_eq!(first.status, 200);
    assert_eq!(first.body["status"], "accepted");
    let replay = f.svc.handle_post("/webhook/hook", &h, body).await;
    assert_eq!(replay.status, 200);
    assert_eq!(replay.body["status"], "dedup");
    assert_eq!(f.dispatched.0.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn bad_or_missing_signature_is_403_and_unsigned_table_endpoint_401() {
    let f = fx(WebhookConfig::default());
    let body = b"{}";
    let missing = f.svc.handle_post("/webhook/hook", &headers(&[JSON_CT]), body).await;
    assert_eq!((missing.status, missing.body), (403, json!({"ok":false,"error":"missing signature"})));
    let bad = headers(&[JSON_CT, ("x-hub-signature-256", &sign("wrong", body))]);
    let reply = f.svc.handle_post("/webhook/hook", &bad, body).await;
    assert_eq!((reply.status, reply.body), (403, json!({"ok":false,"error":"invalid signature"})));
    f.store.secrets.lock().unwrap().clear();
    let unsigned = f.svc.handle_post("/webhook/hook", &headers(&[JSON_CT]), body).await;
    assert_eq!((unsigned.status, unsigned.body), (401, json!({"error":"webhook secret required for endpoint"})));
    assert!(f.dispatched.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn config_endpoint_accepts_unsigned_only_on_explicit_opt_in() {
    let mut config = WebhookConfig::default();
    config.endpoints.insert("cfg".into(), Endpoint::default());
    let f = fx(config.clone());
    let denied = f.svc.handle_post("/webhook/cfg", &headers(&[JSON_CT]), b"{}").await;
    assert_eq!(denied.status, 401);
    config.allow_unsigned_webhooks = true;
    f.svc.set_config(config);
    assert_eq!(f.svc.handle_post("/webhook/cfg", &headers(&[JSON_CT]), b"{}").await.status, 200);
}

#[tokio::test]
async fn parser_without_secret_fails_closed() {
    let mut config = WebhookConfig::default();
    config.endpoints.insert("cfg".into(), Endpoint { parser: Some("github".into()), allow_unsigned: Some(true), ..Default::default() });
    let f = fx(config);
    let reply = f.svc.handle_post("/webhook/cfg", &headers(&[JSON_CT]), b"{}").await;
    assert_eq!((reply.status, reply.body), (401, json!({"error":"webhook secret required for signed parser"})));
}

#[tokio::test]
async fn test_probe_needs_header_marker_and_secret_and_never_dispatches() {
    let f = fx(WebhookConfig::default());
    let body = br#"{"mixdogWebhookTest":true}"#;
    let sig = sign("s3", body);
    let ok = f.svc.handle_post("/webhook/hook", &headers(&[JSON_CT, ("x-hub-signature-256", &sig), ("x-mixdog-webhook-test", "1")]), body).await;
    assert_eq!((ok.status, ok.body), (200, json!({"status":"verified","test":true})));
    let header_only_body = b"{}";
    let sig2 = sign("s3", header_only_body);
    let mismatch = f
        .svc
        .handle_post("/webhook/hook", &headers(&[JSON_CT, ("x-hub-signature-256", &sig2), ("x-mixdog-webhook-test", "1")]), header_only_body)
        .await;
    assert_eq!((mismatch.status, mismatch.body), (400, json!({"error":"invalid test request"})));
    assert!(f.dispatched.0.lock().unwrap().is_empty());
    assert!(f.store.deliveries.lock().unwrap().is_empty());
}

#[tokio::test]
async fn content_type_json_and_self_comment_gates() {
    let f = fx(WebhookConfig::default());
    let body = b"a=b";
    let h = headers(&[("x-hub-signature-256", &sign("s3", body)), ("content-type", "text/plain")]);
    let reply = f.svc.handle_post("/webhook/hook", &h, body).await;
    assert_eq!(reply.status, 415);
    let failed = f.store.deliveries.lock().unwrap().values().cloned().collect::<Vec<_>>();
    assert_eq!(failed, vec!["failed".to_string()]);

    let own = br#"{"comment":{"body":"[mixdog reviewer] hi"}}"#;
    let h = headers(&[JSON_CT, ("x-hub-signature-256", &sign("s3", own)), ("x-github-event", "issue_comment")]);
    let reply = f.svc.handle_post("/webhook/hook", &h, own).await;
    assert_eq!((reply.status, reply.body["status"].clone()), (202, json!("self-comment-skip")));
    assert!(f.dispatched.0.lock().unwrap().is_empty());

    let broken = b"{not json";
    let h = headers(&[JSON_CT, ("x-hub-signature-256", &sign("s3", broken))]);
    let reply = f.svc.handle_post("/webhook/hook", &h, broken).await;
    assert_eq!((reply.status, reply.body), (400, json!({"error":"invalid JSON"})));
}

#[tokio::test]
async fn oversized_body_is_413_and_listener_counts_as_work() {
    let f = fx(WebhookConfig::default());
    let big = vec![b' '; MAX_BODY_BYTES + 1];
    let reply = f.svc.handle_post("/webhook/hook", &headers(&[JSON_CT]), &big).await;
    assert_eq!(reply.status, 413);
    assert!(f.work.is_idle());
    let listening = f.svc.listening();
    assert_eq!(f.work.count(), 1);
    drop(listening);
    assert!(f.work.is_idle());
}
