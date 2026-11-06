//! The quota-resume clock against the Node recording
//! (`fixtures/quota-scheduler/golden.json`, Node's real `createQuotaResumeScheduler` over its real
//! store): the delay the one timer is armed for, and per tick the log, the usage readings, the
//! retries fired and the queue left behind.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_core_base::quota_resume::QuotaResumeStore;
use mixdog_js::json_number;
use serde_json::{Value, json};

use super::quota_resume_scheduler::{FireOutcome, QuotaResumeScheduler, ResumeClock, ResumeHost, SessionRoute, UsageError};

struct FakeClock(Mutex<f64>);

#[async_trait]
impl ResumeClock for FakeClock {
    fn now_ms(&self) -> f64 {
        *self.0.lock().unwrap()
    }
    async fn sleep(&self, _ms: u64) {
        std::future::pending::<()>().await;
    }
}

#[derive(Default)]
struct Calls {
    reads: HashMap<String, usize>,
    usable: Vec<Value>,
    fire: Vec<Value>,
}

struct Host {
    spec: Value,
    calls: Mutex<Calls>,
}

#[async_trait]
impl ResumeHost for Host {
    async fn materialize(&self, _session_id: &str) -> Result<(), String> {
        match self.spec["materialize"].as_str() {
            Some(error) => Err(error.to_owned()),
            None => Ok(()),
        }
    }

    async fn route(&self, session_id: &str) -> SessionRoute {
        let routes = self.spec.get("routes").and_then(Value::as_array).cloned().unwrap_or_else(|| vec![json!({ "provider": "openai-oauth", "model": "gpt-x" })]);
        let mut calls = self.calls.lock().unwrap();
        let read = calls.reads.entry(session_id.to_owned()).or_default();
        *read += 1;
        let route = &routes[(*read).min(routes.len()) - 1];
        SessionRoute { provider: route["provider"].as_str().unwrap().to_owned(), model: route["model"].as_str().unwrap().to_owned() }
    }

    async fn usable(&self, provider: &str, model: &str) -> Result<bool, UsageError> {
        self.calls.lock().unwrap().usable.push(json!({ "provider": provider, "model": model }));
        match self.spec.get("usable") {
            None => Ok(true),
            Some(Value::Bool(usable)) => Ok(*usable),
            Some(other) if other.get("fail").is_some() => Err(UsageError::Failed(other["fail"].as_str().unwrap().to_owned())),
            Some(other) => Err(UsageError::ProxyUnavailable(other["proxy"].as_str().unwrap().to_owned())),
        }
    }

    async fn fire(&self, session_id: &str, generation: u64) -> Result<FireOutcome, String> {
        self.calls.lock().unwrap().fire.push(json!({ "sessionId": session_id, "generation": generation }));
        match self.spec.get("fire") {
            Some(Value::Object(fail)) => Err(fail["fail"].as_str().unwrap().to_owned()),
            None => Ok(FireOutcome::Fired),
            Some(name) => Ok(match name.as_str().unwrap() {
                "fired" => FireOutcome::Fired,
                "busy" => FireOutcome::Busy,
                "rejected" => FireOutcome::Rejected,
                "stale" => FireOutcome::Stale,
                "superseded" => FireOutcome::Superseded,
                "unreplayable" => FireOutcome::Unreplayable,
                other => panic!("{other}"),
            }),
        }
    }
}

fn queue(store: &QuotaResumeStore, now: f64) -> Value {
    Value::Array(
        store
            .list()
            .iter()
            .map(|e| json!({ "sessionId": e.session_id, "generation": e.generation, "resetAt": json_number(e.reset_at.as_f64().unwrap() - now), "attempts": e.attempts }))
            .collect(),
    )
}

#[tokio::test]
async fn the_clock_matches_node() {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/quota-scheduler/golden.json")).unwrap();
    let now = golden["now"].as_f64().unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(
            QuotaResumeStore::open(dir.path(), mixdog_rt::testing::tokens().durability_io, mixdog_rt::CancellationToken::new()).await.unwrap(),
        );
        for entry in case["entries"].as_array().unwrap() {
            let mut request = entry.clone();
            request["resetAt"] = json!(now + entry["resetIn"].as_f64().unwrap());
            store.schedule(&request).await.unwrap();
        }
        let clock = Arc::new(FakeClock(Mutex::new(now)));
        let host = Arc::new(Host { spec: case.clone(), calls: Mutex::default() });
        let log: Arc<Mutex<Vec<String>>> = Arc::default();
        let sink = log.clone();
        let auto = case["autoResume"].as_bool().unwrap_or(true);
        let scheduler = QuotaResumeScheduler::new(
            store.clone(),
            host.clone(),
            clock.clone(),
            Arc::new(move || auto),
            Arc::new(move |line: &str| sink.lock().unwrap().push(line.to_owned())),
        );
        let scheduled: Vec<Value> = store
            .list()
            .iter()
            .map(|e| {
                let mut value = e.to_value();
                value["resetAt"] = json_number(e.reset_at.as_f64().unwrap() - now);
                value
            })
            .collect();
        let want: Vec<Value> = case["scheduled"].as_array().unwrap().clone();
        assert_eq!(scheduled.len(), want.len(), "{name}: scheduled");
        for (got, want) in scheduled.iter().zip(&want) {
            for key in ["sessionId", "generation", "resetAt", "attempts"] {
                assert_eq!(got[key], want[key], "{name}: scheduled {key}");
            }
        }
        assert_eq!(scheduler.armed_ms().map(|ms| json!(ms)).unwrap_or(Value::Null), case["armed"], "{name}: armed");
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            *clock.0.lock().unwrap() += step["advance"].as_f64().unwrap();
            log.lock().unwrap().clear();
            {
                let mut calls = host.calls.lock().unwrap();
                calls.usable.clear();
                calls.fire.clear();
            }
            let armed = scheduler.tick().await;
            let at = format!("{name} step {i}");
            assert_eq!(json!(*log.lock().unwrap()), step["log"], "{at}: log");
            assert_eq!(Value::Array(host.calls.lock().unwrap().usable.clone()), step["usable"], "{at}: usable");
            assert_eq!(Value::Array(host.calls.lock().unwrap().fire.clone()), step["fire"], "{at}: fire");
            assert_eq!(queue(&store, now), step["queue"], "{at}: queue");
            assert_eq!(armed.map(|ms| json!(ms)).unwrap_or(Value::Null), step["armed"], "{at}: armed");
        }
    }
}