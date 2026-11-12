//! Node's web tool output cases (`fixtures/fetch-output-cases`, `record-fetch-output-cases.mjs`): windows through
//! `paginate` and `format_fetch`, search payloads through `format_results`, and the pipeline cases through the
//! `web_fetch` tool against a local server (and a fake render stage); each whole text against Node's, with the
//! fetched url as <url> and elapsed times as <n>ms. Named cases are left out.
#![allow(clippy::disallowed_methods, reason = "test fixture loading")]

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProcessManager;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::tool::*;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_protocol::TurnId;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;
use url::Url;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::path;

use super::error::FetchError;
use super::error::FetchKind;
use super::format::FetchItem;
use super::format::format_fetch;
use super::format::paginate;
use super::pipeline::PageRenderer;
use super::pipeline::StagePage;
use super::search::SearchHit;
use super::search::SearchPayload;
use super::search::format_results;
use super::ssrf::AddressPolicy;
use super::*;

fn fixture(name: &str) -> Value {
    let path = format!("{}/../../fixtures/fetch-output-cases/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn ctx() -> ToolContext {
    let tokens = mixdog_rt::testing::tokens();
    ToolContext {
        call_id: ToolCallId::from("c"),
        thread_id: ThreadId::from("t"),
        turn_id: TurnId::from("r"),
        tool: "web_fetch".into(),
        cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
        surface: SurfaceKind::Lead,
        cancel: CancellationToken::new(),
        deadline: None,
        progress: Arc::new(MockProgress::default()),
        io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
        approvals: Arc::new(MockApprovalGate::default()),
        files: Arc::new(MockFileService::default()),
        processes: Arc::new(MockProcessManager::default()),
        options: Default::default(),
        review: None,
    }
}

fn service(renderer: Option<Arc<dyn PageRenderer>>) -> Arc<WebService> {
    let tokens = mixdog_rt::testing::tokens();
    let mut config = WebConfig::new("test", lanes::WebLanes { extract: tokens.cpu_interactive, dns: tokens.interactive_io });
    config.public_policy = AddressPolicy::AnyForTest;
    config.renderer = renderer;
    WebService::new(config).unwrap()
}

async fn fetch(service: &Arc<WebService>, args: Value) -> String {
    let tool = service.tools().into_iter().find(|t| t.spec().name == "web_fetch").unwrap();
    match tool.call(&ctx(), args).await {
        Ok(output) => output.parts.iter().filter_map(|p| if let ToolPart::Text(t) = p { Some(t.as_str()) } else { None }).collect::<Vec<_>>().join("\n"),
        Err(error) => error.message_for_model.clone(),
    }
}

/// The url as <url> and each stage's elapsed time as <n>ms, as the recording writes them.
fn masked(text: &str, url: &str) -> String {
    let text = text.replace(url, "<url>");
    let mut out = String::new();
    let mut rest = text.as_str();
    while let Some(at) = rest.find('(') {
        let tail = &rest[at + 1..];
        let digits = tail.bytes().take_while(u8::is_ascii_digit).count();
        out.push_str(&rest[..at]);
        if digits > 0 && tail[digits..].starts_with("ms)") {
            out.push_str("(<n>ms)");
            rest = &tail[digits + 3..];
        } else {
            out.push('(');
            rest = tail;
        }
    }
    out.push_str(rest);
    out
}

fn payload(v: &Value) -> SearchPayload {
    let response = v.get("response").unwrap_or(v);
    SearchPayload {
        provider: String::new(),
        answer: s(response, "answer"),
        results: response["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| SearchHit {
                title: s(r, "title"),
                url: s(r, "url"),
                snippet: s(r, "snippet"),
                from_call: r["source"] == "web_search_call",
                published_date: r.get("publishedDate").and_then(Value::as_str).map(str::to_owned),
            })
            .collect(),
        warnings: v.get("warnings").and_then(Value::as_array).map(|w| w.iter().map(|x| x.as_str().unwrap().to_owned()).collect()).unwrap_or_default(),
        model: None,
        usage: None,
    }
}

struct Stage(Result<StagePage, (String, u16)>);

#[async_trait]
impl PageRenderer for Stage {
    async fn render(&self, url: &Url, _: Duration) -> Result<StagePage, FetchError> {
        match &self.0 {
            Ok(page) => Ok(StagePage { url: url.to_string(), ..page.clone() }),
            Err((message, status)) => {
                let mut error = FetchError::new(FetchKind::Challenge, message.clone());
                error.status = Some(*status);
                Err(error)
            }
        }
    }
}

#[tokio::test]
async fn every_recorded_web_output_is_nodes() {
    let golden = fixture("golden.json");
    let excluded = fixture("MANIFEST.json")["excluded"].as_object().unwrap().clone();
    let cases = golden["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    for case in cases.iter().filter(|c| !excluded.contains_key(c["case"].as_str().unwrap())) {
        let recorded = case["recorded"].as_array().unwrap();
        let server = MockServer::start().await;
        let url = format!("{}/document.md", server.uri());
        let got: Vec<Value> = match case["kind"].as_str().unwrap() {
            "windows" => recorded
                .iter()
                .map(|w| {
                    let content = w.get("content").and_then(Value::as_str).map_or_else(|| "x".repeat(w["repeat"].as_u64().unwrap() as usize), str::to_owned);
                    let window = paginate(&content, w["startIndex"].as_u64().unwrap_or(0), w["maxLength"].as_u64());
                    let item = FetchItem::Success { url: s(w, "url"), title: String::new(), window, failures: Vec::new(), attempts: Vec::new() };
                    let mut out = w.clone();
                    out["rendered"] = json!(format_fetch(&[item], 0));
                    out
                })
                .collect(),
            "search" => recorded.iter().map(|r| json!({ "payload": r["payload"], "rendered": format_results(&payload(&r["payload"])) })).collect(),
            "pages" => {
                Mock::given(path("/document.md"))
                    .respond_with(ResponseTemplate::new(200).set_body_raw(s(case, "source").into_bytes(), "text/markdown"))
                    .mount(&server)
                    .await;
                let web = service(None);
                let mut out = Vec::new();
                for call in recorded {
                    let mut args = json!({ "url": url });
                    for key in ["startIndex", "maxLength"] {
                        if let Some(v) = call.get(key) {
                            args[key] = v.clone();
                        }
                    }
                    let mut row = call.clone();
                    row["rendered"] = json!(masked(&fetch(&web, args).await, &url));
                    out.push(row);
                }
                out
            }
            kind @ ("blocked" | "fallback") => {
                Mock::given(path("/document.md")).respond_with(ResponseTemplate::new(403)).mount(&server).await;
                let stage = if kind == "blocked" {
                    Stage(Err(("Explicit challenge".into(), 200)))
                } else {
                    Stage(Ok(StagePage { title: "Recovered".into(), content: "    recovered content\n\n".into(), extractor: "puppeteer".into(), excerpt_json_len: 2, ..StagePage::default() }))
                };
                let web = service(Some(Arc::new(stage)));
                vec![json!({ "rendered": masked(&fetch(&web, json!({ "url": url })).await, &url) })]
            }
            other => panic!("{}: kind {other} has no replay and no exclusion", case["case"]),
        };
        if got != *recorded {
            failures.push(format!("{}:\n  want {}\n  got  {}", case["case"], Value::Array(recorded.clone()), Value::Array(got)));
        }
    }
    assert!(failures.is_empty(), "{} case(s) differ:\n{}", failures.len(), failures.join("\n"));
    // The test's seven cases; the crawl leg of the second is recorded apart and named.
    assert_eq!(cases.len(), 8);
}
