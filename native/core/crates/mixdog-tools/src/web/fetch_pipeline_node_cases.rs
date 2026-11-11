//! Node's fetch pipeline cases (`fixtures/fetch-pipeline-cases`, `record-fetch-pipeline-cases.mjs`): each recorded run
//! through `Pipeline::run` against a local server serving the recorded responses (and a fake render stage), its whole
//! outcome against Node's; the pacer case as three same-host fetches and one other-host fetch through one pipeline.
//! Named cases are left out.
#![allow(clippy::disallowed_methods, reason = "test fixture loading")]

use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;
use url::Url;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::Request;
use wiremock::Respond;
use wiremock::ResponseTemplate;
use wiremock::matchers::path;

use super::error::FetchError;
use super::error::FetchKind;
use super::http::Fetcher;
use super::lanes::WebLanes;
use super::pipeline::Page;
use super::pipeline::PageRenderer;
use super::pipeline::Pipeline;
use super::pipeline::PipelineFailure;
use super::pipeline::StagePage;
use super::ssrf::AddressPolicy;

/// The retry floor: a retry waits its Retry-After, and never this much longer.
const RETRY_FLOOR_MS: u128 = 400;

fn fixture(name: &str) -> Value {
    let path = format!("{}/../../fixtures/fetch-pipeline-cases/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

struct Browser(String);

#[async_trait]
impl PageRenderer for Browser {
    async fn render(&self, url: &Url, _: Duration) -> Result<StagePage, FetchError> {
        match self.0.as_str() {
            "page" => Ok(StagePage { url: url.to_string(), title: "Guide".into(), content: "Useful page content.".into(), format: "html".into(), ..StagePage::default() }),
            "challenge" => {
                let mut error = FetchError::new(FetchKind::Challenge, "Explicit challenge response");
                error.status = Some(200);
                Err(error)
            }
            "hang" => std::future::pending().await,
            other => Err(FetchError::new(FetchKind::Network, format!("browser stage must not run ({other})"))),
        }
    }
}

/// Cancels the caller's fetch while answering its request with a page (the test's stage that aborts, then returns).
struct CancelThenPage(CancellationToken);

impl Respond for CancelThenPage {
    fn respond(&self, _: &Request) -> ResponseTemplate {
        self.0.cancel();
        ResponseTemplate::new(200).set_body_raw("Useful page content.", "text/markdown")
    }
}

fn pipeline(policy: AddressPolicy, browser: &str) -> Arc<Pipeline> {
    let tokens = mixdog_rt::testing::tokens();
    let fetcher = Fetcher::new(policy, "test", WebLanes { extract: tokens.cpu_interactive, dns: tokens.interactive_io }).unwrap();
    Arc::new(Pipeline::new(Arc::new(fetcher), Some(Arc::new(Browser(browser.to_owned())))))
}

fn response(spec: &Value) -> ResponseTemplate {
    let mut template = ResponseTemplate::new(spec["status"].as_u64().unwrap() as u16).set_body_raw(spec["body"].as_str().unwrap().to_owned(), "text/markdown");
    for (name, value) in spec["headers"].as_object().unwrap() {
        template = template.insert_header(name.as_str(), value.as_str().unwrap());
    }
    template
}

fn trace(failures: &[super::pipeline::Failure], attempts: &[super::pipeline::Attempt]) -> (Value, Value, Value) {
    let failures: Vec<Value> = failures
        .iter()
        .map(|f| {
            let mut row = json!({ "extractor": f.extractor, "error": f.error, "code": f.code });
            if let Some(status) = f.status {
                row["status"] = json!(status);
            }
            row
        })
        .collect();
    let rows: Vec<Value> = attempts
        .iter()
        .map(|a| {
            let mut row = json!({ "stage": a.stage, "status": if a.ok { "success" } else { "error" } });
            if let Some(code) = &a.code {
                row["code"] = json!(code);
            }
            row
        })
        .collect();
    let tried: Vec<&str> = attempts.iter().map(|a| a.stage.as_str()).collect();
    (json!(tried), json!(failures), json!(rows))
}

fn outcome(result: &Result<Page, PipelineFailure>) -> Value {
    match result {
        Ok(page) => {
            let (tried, failures, attempts) = trace(&page.failures, &page.attempts);
            let extractor = if page.extractor.is_empty() { Value::Null } else { json!(page.extractor) };
            json!({ "page": { "title": page.title, "content": page.content, "extractor": extractor }, "triedExtractors": tried, "failures": failures, "attempts": attempts })
        }
        Err(failure) => {
            let (tried, failures, attempts) = trace(&failure.failures, &failure.attempts);
            json!({
                "error": { "code": failure.code, "message": failure.error.message, "status": failure.error.status },
                "triedExtractors": tried, "failures": failures, "attempts": attempts,
            })
        }
    }
}

async fn replay(spec: &Value, recorded_delays: &Value) -> Value {
    let server = MockServer::start().await;
    let cancel = CancellationToken::new();
    let browser = spec["browser"].as_str().unwrap();
    let policy = if spec["http"] == "private" { AddressPolicy::PublicOnly } else { AddressPolicy::AnyForTest };
    match &spec["http"] {
        Value::Array(responses) => {
            let (last, first) = responses.split_last().unwrap();
            for each in first {
                Mock::given(path("/docs")).respond_with(response(each)).up_to_n_times(1).mount(&server).await;
            }
            Mock::given(path("/docs")).respond_with(response(last)).mount(&server).await;
        }
        Value::String(kind) if kind == "hang" => {
            Mock::given(path("/docs")).respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(30))).mount(&server).await;
        }
        Value::String(kind) if kind == "cancel" => {
            Mock::given(path("/docs")).respond_with(CancelThenPage(cancel.clone())).mount(&server).await;
        }
        _ => {}
    }
    let url = Url::parse(&format!("{}/docs", server.uri())).unwrap();
    let budget = Duration::from_millis(spec.get("timeoutMs").and_then(Value::as_u64).unwrap_or(3000));
    let started = Instant::now();
    let result = pipeline(policy, browser).run(&url, budget, &cancel).await;
    let elapsed = started.elapsed().as_millis();
    let mut got = outcome(&result);
    // The waits are not observable one by one: the run took at least their sum, and less than one more retry floor.
    let waited: u128 = recorded_delays.as_array().unwrap().iter().map(|d| u128::from(d.as_u64().unwrap())).sum();
    got["delays"] = if elapsed >= waited && elapsed < waited + RETRY_FLOOR_MS { recorded_delays.clone() } else { json!({ "elapsedMs": elapsed as u64 }) };
    got
}

async fn paths(server: &MockServer) -> Vec<String> {
    server.received_requests().await.unwrap().iter().map(|r| r.url.path().trim_start_matches('/').to_owned()).collect()
}

async fn pacer() -> Value {
    let server = MockServer::start().await;
    // The first fetch holds its host while the others queue or run (the test's blocker, released by its delay).
    Mock::given(path("/first")).respond_with(ResponseTemplate::new(200).set_body_raw("held page", "text/markdown").set_delay(Duration::from_secs(3))).mount(&server).await;
    for name in ["cancelled", "third", "other"] {
        Mock::given(path(format!("/{name}"))).respond_with(ResponseTemplate::new(200).set_body_raw(format!("{name} page"), "text/markdown")).mount(&server).await;
    }
    let pipeline = pipeline(AddressPolicy::AnyForTest, "none");
    let port = server.address().port();
    let fetch = |host: &str, name: &str, cancel: CancellationToken| {
        let (pipeline, url) = (pipeline.clone(), Url::parse(&format!("http://{host}:{port}/{name}")).unwrap());
        tokio::spawn(async move { pipeline.run(&url, Duration::from_secs(10), &cancel).await })
    };
    let first = fetch("127.0.0.1", "first", CancellationToken::new());
    while paths(&server).await.is_empty() {
        tokio::task::yield_now().await;
    }
    let stop = CancellationToken::new();
    let cancelled = fetch("127.0.0.1", "cancelled", stop.clone());
    let third = fetch("127.0.0.1", "third", CancellationToken::new());
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    stop.cancel();
    let cancelled = if cancelled.await.unwrap().is_err() { "rejected" } else { "ran" };
    fetch("localhost", "other", CancellationToken::new()).await.unwrap().unwrap();
    let before = paths(&server).await;
    first.await.unwrap().unwrap();
    third.await.unwrap().unwrap();
    json!({ "beforeRelease": before, "afterRelease": paths(&server).await, "cancelled": cancelled })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_recorded_pipeline_run_is_nodes() {
    let golden = fixture("golden.json");
    let excluded = fixture("MANIFEST.json")["excluded"].as_object().unwrap().clone();
    let cases = golden["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    for case in cases {
        let name = case["case"].as_str().unwrap();
        if case["kind"] == "pacer" {
            if excluded.contains_key(name) {
                continue;
            }
            let got = pacer().await;
            if got != case["recorded"] {
                failures.push(format!("{name}:\n  want {}\n  got  {got}", case["recorded"]));
            }
            continue;
        }
        for (i, run) in case["runs"].as_array().unwrap().iter().enumerate() {
            if excluded.contains_key(&format!("{name} #{i}")) || excluded.contains_key(name) {
                continue;
            }
            let want = &run["outcome"];
            let got = replay(&run["spec"], &want["delays"]).await;
            if got != *want {
                failures.push(format!("{name} #{i}:\n  want {want}\n  got  {got}"));
            }
        }
    }
    assert!(failures.is_empty(), "{} run(s) differ:\n{}", failures.len(), failures.join("\n"));
    assert_eq!(cases.len(), 6, "the test's six cases");
}
